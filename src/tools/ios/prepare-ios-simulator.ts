import path from 'node:path';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';

import {fs, net, plist, zip} from '@appium/support';
/**
 * Single-call tool to prepare an iOS simulator for Appium testing.
 * Chains: boot simulator → download WDA → install & launch WDA.
 * Each step checks preconditions and skips if already satisfied.
 */
import type {ContentResult, FastMCP} from 'fastmcp';
import {Simctl} from 'node-simctl';
import {exec} from 'teen_process';
import {z} from 'zod';

import {IOSManager} from '../../devicemanager/ios-manager.js';
import log from '../../logger.js';
import {callEffortAuthority} from '../../utils/effort-authority.js';
import type {ManagedSessionArgs} from '../../utils/managed-session.js';
import {resolveAppiumMcpCachePath} from '../../utils/paths.js';
import {findFreePort, releaseReservedPort} from '../../utils/ports.js';
import {getWdaLogTail, sanitizeDiagnostic, waitForWdaReady, type WdaReadiness} from '../../utils/wda-readiness.js';
import {textResult} from '../tool-response.js';

type StepStatus = 'completed' | 'skipped' | 'failed';

interface StepResult {
  status: StepStatus;
  detail: string;
}

interface PrepareResult {
  boot: StepResult;
  wda_download: StepResult;
  wda_install: StepResult;
  ready: boolean;
  udid: string;
  wdaAppPath?: string;
  wdaLocalPort?: number;
  webDriverAgentUrl?: string;
  capabilitiesHint?: Record<string, any>;
}

// ── Filesystem helpers ──

interface WDAState {
  installed: boolean;
  running: boolean;
}

async function fileExists(filePath: string): Promise<boolean> {
  return await fs.hasAccess(filePath);
}

// ── WDA download helpers ──

async function cleanupFile(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch (err: any) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

// Resolves the latest WDA version via GitHub's release permalink instead of the REST API, avoiding the 60/hr
// unauthenticated API limit. Note: still subject to general GitHub rate limiting and redirect behavior.
async function getLatestWDAVersionFromGitHub(): Promise<string> {
  const permalink = 'https://github.com/appium/WebDriverAgent/releases/latest';
  const response = await fetch(permalink, {
    method: 'HEAD',
    redirect: 'manual',
    headers: {'User-Agent': 'mcp-appium'},
  });

  const location = response.headers.get('location');
  if (!location) {
    throw new Error(
      `Failed to resolve latest WDA version (${response.status} ${response.statusText}): no redirect from ${permalink}`,
    );
  }

  // Expected format: https://github.com/appium/WebDriverAgent/releases/tag/v<version>
  const match = location.match(/\/releases\/tag\/v?([^/]+)\/?$/);
  if (!match) {
    throw new Error(`Failed to parse WDA version from redirect location: ${location}`);
  }

  return match[1];
}

async function unzipFile(zipPath: string, destDir: string): Promise<void> {
  await zip.extractAllTo(zipPath, destDir, {useSystemUnzip: true});
}

// ── WDA install helpers ──

async function getLatestWDAVersionFromCache(): Promise<string | null> {
  const wdaCacheDir = resolveAppiumMcpCachePath('wda');

  if (!(await fileExists(wdaCacheDir))) {
    return null;
  }

  const entries = await fs.readdir(wdaCacheDir);
  const versions = await Promise.all(
    entries.map(async (dir) => {
      const dirPath = path.join(wdaCacheDir, dir);
      const stats = await fs.stat(dirPath);
      return stats.isDirectory() ? dir : null;
    }),
  );

  const filteredVersions = versions
    .filter((v): v is string => v !== null)
    .sort((a, b) => b.localeCompare(a, undefined, {numeric: true}));

  return filteredVersions.length > 0 ? filteredVersions[0] : null;
}

async function getSimulatorArchitecture(simulatorUdid: string): Promise<string[]> {
  const {stdout} = await exec('xcrun', ['simctl', 'getenv', simulatorUdid, 'SIMULATOR_ARCHS']);
  const archs = stdout.trim().split(/\s+/);
  return archs;
}

async function installAppOnSimulator(appPath: string, simulatorUdid: string): Promise<void> {
  await exec('xcrun', ['simctl', 'install', simulatorUdid, appPath]);
}

async function launchAppOnSimulator(bundleId: string, simulatorUdid: string, wdaPort: number): Promise<void> {
  // simctl forwards env vars prefixed with SIMCTL_CHILD_ to the launched app.
  // WDA reads USE_PORT to choose which local port to listen on inside the
  // simulator, so each simulator's WDA can run on its own port instead of all
  // colliding on the default 8100.
  await exec('xcrun', ['simctl', 'launch', simulatorUdid, bundleId], {
    env: {...process.env, SIMCTL_CHILD_USE_PORT: String(wdaPort)},
  });
}

async function terminateAppOnSimulator(bundleId: string, simulatorUdid: string): Promise<void> {
  try {
    await exec('xcrun', ['simctl', 'terminate', simulatorUdid, bundleId]);
  } catch {
    // Nothing running to terminate — ignore.
  }
}

/** Loopback base URL a simulator's WDA is reachable at for a given local port. */
function wdaBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

async function getAppBundleId(appPath: string): Promise<string> {
  const manifest = (await plist.parsePlistFile(path.join(appPath, 'Info.plist'))) as {CFBundleIdentifier?: string};
  if (!manifest.CFBundleIdentifier) {
    throw new Error(`No CFBundleIdentifier found in ${appPath}`);
  }
  return manifest.CFBundleIdentifier;
}

async function getWDAState(simulatorUdid: string): Promise<WDAState> {
  let installed: boolean;

  // simctl listapps emits a plist; convert it with Apple's plutil before inspecting it.
  try {
    const {stdout} = await exec('xcrun', ['simctl', 'listapps', simulatorUdid]);
    const data = await convertListAppsPlistToJson(stdout);
    installed = isWdaInstalledInInventory(data);
  } catch {
    throw new Error('WDA installation state could not be verified; preserve the simulator.');
  }

  if (!installed) {
    return {installed: false, running: false};
  }

  // Check if actually running via launchctl inside the simulator
  try {
    const {stdout} = await exec('xcrun', ['simctl', 'spawn', simulatorUdid, 'launchctl', 'list']);
    const running = stdout.includes('WebDriverAgentRunner');
    return {installed: true, running};
  } catch {
    throw new Error('WDA running state could not be verified; preserve the simulator.');
  }
}

function isWdaInstalledInInventory(data: unknown): boolean {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('simctl listapps returned an invalid inventory');
  }

  let installed = false;
  for (const [bundleId, appInfo] of Object.entries(data)) {
    if (!appInfo || typeof appInfo !== 'object' || Array.isArray(appInfo)) {
      throw new Error('simctl listapps returned an invalid app record');
    }
    const bundleName = (appInfo as {CFBundleName?: unknown}).CFBundleName;
    if (bundleId.includes('WebDriverAgentRunner') || (typeof bundleName === 'string' && bundleName.includes('WebDriverAgent'))) {
      installed = true;
    }
  }
  return installed;
}

async function convertListAppsPlistToJson(plist: string): Promise<Record<string, unknown>> {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), 'appium-mcp-wda-listapps-'));
  const plistPath = path.join(temporaryDirectory, 'listapps.plist');

  try {
    await writeFile(plistPath, plist, 'utf8');
    const {stdout} = await exec('plutil', ['-convert', 'json', '-o', '-', '--', plistPath], {timeout: 5000});
    const result: unknown = JSON.parse(stdout);
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('plutil returned an invalid inventory');
    }
    return result as Record<string, unknown>;
  } finally {
    await rm(temporaryDirectory, {recursive: true, force: true});
  }
}

// ── Main pipeline ──

async function resolveWdaAppPath(
  simulatorUdid: string,
  forceRefreshWda: boolean,
  platform: 'ios' | 'tvos' = 'ios',
): Promise<{
  wdaAppPath: string;
  version: string;
  source: 'env' | 'cache' | 'download';
}> {
  // Provide a way to override the WDA app path via an env variable (useful in environments where external downloads are blocked)
  const envAppPath = process.env.APPIUM_MCP_WDA_APP_PATH;
  if (envAppPath) {
    if (!envAppPath.endsWith('.app')) {
      throw new Error(`APPIUM_MCP_WDA_APP_PATH must point to a .app bundle, got: ${envAppPath}`);
    }
    if (!(await fileExists(envAppPath))) {
      throw new Error(`APPIUM_MCP_WDA_APP_PATH points to a non-existent path: ${envAppPath}`);
    }
    if (forceRefreshWda) {
      log.warn('forceRefreshWda=true is ignored because APPIUM_MCP_WDA_APP_PATH is set');
    }
    return {
      wdaAppPath: envAppPath,
      version: 'user-provided',
      source: 'env',
    };
  }

  const archs = await getSimulatorArchitecture(simulatorUdid);
  const archStr = archs.includes('arm64') ? 'arm64' : archs[0];
  const isRosetta = await exec('sysctl', ['-in', 'sysctl.proc_translated']).then(({stdout}) => stdout.trim() === '1');
  if (isRosetta) {
    log.info(`Running under Rosetta. Simulator architecture: ${archs.join(', ')}. Using ${archStr} WDA build.`);
  }
  const artifactPrefix = platform === 'tvos' ? 'WebDriverAgentRunner_tvOS' : 'WebDriverAgentRunner';

  // Check cache first (unless force refresh)
  if (!forceRefreshWda) {
    const cachedVersion = await getLatestWDAVersionFromCache();
    if (cachedVersion) {
      const cachedAppPath = path.join(
        resolveAppiumMcpCachePath('wda', cachedVersion, `extracted-${platform}`),
        `${artifactPrefix}-Runner.app`,
      );
      if (await fileExists(cachedAppPath)) {
        return {
          wdaAppPath: cachedAppPath,
          version: cachedVersion,
          source: 'cache',
        };
      }
    }
  }

  // Download from GitHub
  const wdaVersion = await getLatestWDAVersionFromGitHub();
  const versionCacheDir = resolveAppiumMcpCachePath('wda', wdaVersion);
  const extractDir = path.join(versionCacheDir, `extracted-${platform}`);
  const zipPath = path.join(versionCacheDir, `${artifactPrefix}-Build-Sim-${archStr}.zip`);
  const wdaAppPath = path.join(extractDir, `${artifactPrefix}-Runner.app`);

  // Check if this specific version is already extracted
  if (!forceRefreshWda && (await fileExists(wdaAppPath))) {
    return {wdaAppPath, version: wdaVersion, source: 'cache'};
  }

  // Clean any prior (possibly partial) extraction before downloading
  if (await fileExists(extractDir)) {
    await fs.rimraf(extractDir);
  }

  await fs.mkdirp(versionCacheDir);
  await fs.mkdirp(extractDir);

  const downloadUrl = `https://github.com/appium/WebDriverAgent/releases/download/v${wdaVersion}/${artifactPrefix}-Build-Sim-${archStr}.zip`;
  log.info(`Downloading prebuilt WDA v${wdaVersion}...`);
  await net.downloadFile(downloadUrl, zipPath, {
    headers: {'User-Agent': 'appium-mcp'},
  });

  try {
    log.info('Extracting WebDriverAgent...');
    await unzipFile(zipPath, extractDir);
  } finally {
    // Clean up zip whether extraction succeeds or fails — the .app is what we cache
    await cleanupFile(zipPath);
  }

  if (!(await fileExists(wdaAppPath))) {
    throw new Error('WebDriverAgent extraction failed - app bundle not found');
  }

  return {wdaAppPath, version: wdaVersion, source: 'download'};
}

async function recordPreparationResource(
  managed: ManagedSessionArgs,
  resource: Record<string, unknown>,
): Promise<void> {
  if (!managed.effortToken || !managed.operationId || !managed.worktree) {
    throw new Error('Managed preparation requires effortToken, operationId and worktree.');
  }
  const response = await callEffortAuthority('resource-add', {
    token: managed.effortToken,
    operationId: managed.operationId,
    owned: true,
    lifetime: 'keepalive',
    ...resource,
  });
  if (!response.ok) {
    throw new Error(
      `Preparation resource could not be recorded (${response.status}); preserve the simulator and reconcile.`,
    );
  }
}

async function installWdaStep(
  result: PrepareResult,
  udid: string,
  wdaAppPath: string,
  managed: ManagedSessionArgs,
): Promise<void> {
  try {
    const wdaState = await getWDAState(udid);
    const bundleId = await getAppBundleId(wdaAppPath);

    // Never replace a WDA that may belong to an operator or another effort.
    // Reuse cannot be claimed safely by this flow because its listener identity
    // and ownership are not available from simulator state alone.
    if (wdaState.running) {
      result.wda_install = {
        status: 'failed',
        detail: `A WDA instance is already running on simulator ${udid}; it was preserved. Stop only an instance owned by this effort before preparing again.`,
      };
      return;
    }

    const wdaPort = await findFreePort();
    const webDriverAgentUrl = wdaBaseUrl(wdaPort);
    const wdaResource = {kind: 'wda', id: `wda:${managed.operationId}`, udid, bundleId, port: wdaPort, endpoint: webDriverAgentUrl};
    await recordPreparationResource(managed, {...wdaResource, pending: true});
    if (!wdaState.installed) {
      log.info(`Installing WDA on simulator ${udid}...`);
      await installAppOnSimulator(wdaAppPath, udid);
    }
    let readiness: WdaReadiness = {ready: false, elapsedMs: 0, lastProbe: 'Launch did not complete'};
    try {
      log.info(`Launching WDA (${bundleId}) on port ${wdaPort}...`);
      await launchAppOnSimulator(bundleId, udid, wdaPort);
      readiness = await waitForWdaReady(wdaPort);
      if (readiness.ready) {await recordPreparationResource(managed, {...wdaResource, pending: false});}
    } finally {
      // Once WDA has bound the port the OS guards it; on failure it's free again.
      // Either way the reservation has served its purpose — release it.
      releaseReservedPort(wdaPort);
    }

    if (!readiness.ready) {
      const logTail = await getWdaLogTail(udid);
      result.wda_install = {
        status: 'failed',
        detail:
          `WDA readiness failed (UDID=${udid}, phase=readiness, elapsedMs=${readiness.elapsedMs}, ` +
          `lastProbe=${readiness.lastProbe}). WDA log tail (bounded): ${logTail}`,
      };
      return;
    }

    result.wdaLocalPort = wdaPort;
    result.webDriverAgentUrl = webDriverAgentUrl;
    result.capabilitiesHint = {
      'appium:webDriverAgentUrl': webDriverAgentUrl,
      'appium:udid': udid,
      'appium:usePrebuiltWDA': true,
      'appium:useNewWDA': false,
      'appium:noReset': true,
    };
    result.wda_install = {
      status: 'completed',
      detail: `WDA ${wdaState.installed ? 'already installed, ' : ''}launched and ready on ${webDriverAgentUrl}`,
    };
    result.ready = true;
  } catch (error: any) {
    result.wda_install = {status: 'failed', detail: sanitizeDiagnostic(String(error))};
  }
}

async function prepareSimulator(
  udid: string,
  skipWda: boolean,
  forceRefreshWda: boolean,
  platform: 'ios' | 'tvos' = 'ios',
  managed: ManagedSessionArgs = {},
): Promise<PrepareResult> {
  const result: PrepareResult = {
    boot: {status: 'skipped', detail: ''},
    wda_download: {status: 'skipped', detail: ''},
    wda_install: {status: 'skipped', detail: ''},
    ready: false,
    udid,
  };

  // ── Step 1: Boot simulator ──
  try {
    const iosManager = IOSManager.getInstance();
    const simulators = await iosManager.listSimulators();
    const simulator = simulators.find((sim) => sim.udid === udid);

    if (!simulator) {
      result.boot = {
        status: 'failed',
        detail: `Simulator with UDID "${udid}" not found. Use select_device to get a valid UDID.`,
      };
      return result;
    }

    if (simulator.state === 'Booted') {
      result.boot = {
        status: 'skipped',
        detail: `${simulator.name} is already booted`,
      };
    } else {
      log.info(`Booting simulator ${simulator.name} (${udid})...`);
      const simctl = new Simctl();
      simctl.udid = udid;
      const bootResource = {kind: 'simulatorBoot', id: `boot:${managed.operationId}`, udid};
      await recordPreparationResource(managed, {...bootResource, pending: true});
      await simctl.bootDevice();
      await recordPreparationResource(managed, {...bootResource, pending: false});
      await simctl.startBootMonitor({timeout: 120000});
      result.boot = {
        status: 'completed',
        detail: `${simulator.name} booted successfully`,
      };
    }
  } catch (error: any) {
    result.boot = {status: 'failed', detail: sanitizeDiagnostic(String(error))};
    return result;
  }

  if (skipWda) {
    result.wda_download = {status: 'skipped', detail: 'skipWda=true'};
    result.wda_install = {status: 'skipped', detail: 'skipWda=true'};
    result.ready = true;
    return result;
  }

  // ── Step 2: Download WDA ──
  let wdaAppPath: string;
  try {
    const resolved = await resolveWdaAppPath(udid, forceRefreshWda, platform);
    wdaAppPath = resolved.wdaAppPath;
    result.wdaAppPath = wdaAppPath;

    if (resolved.source === 'download') {
      result.wda_download = {
        status: 'completed',
        detail: `WDA v${resolved.version} downloaded and extracted to ${wdaAppPath}`,
      };
    } else if (resolved.source === 'cache') {
      result.wda_download = {
        status: 'skipped',
        detail: `WDA v${resolved.version} already cached at ${wdaAppPath}`,
      };
    } else {
      result.wda_download = {
        status: 'skipped',
        detail: `Using WDA from APPIUM_MCP_WDA_APP_PATH: ${wdaAppPath}`,
      };
    }
  } catch (error: any) {
    result.wda_download = {status: 'failed', detail: sanitizeDiagnostic(String(error))};
    result.wda_install = {
      status: 'skipped',
      detail: 'WDA download failed',
    };
    return result;
  }

  // ── Step 3: Install & launch WDA ──
  await installWdaStep(result, udid, wdaAppPath, managed);
  return result;
}

// ── Tool registration ──

const prepareIosSimulatorSchema = z.object({
  effortToken: z.string().optional(),
  operationId: z.string().optional(),
  worktree: z.string().optional(),
  udid: z.string().describe('The UDID of the iOS simulator to prepare. Use select_device to get this.'),
  platform: z
    .enum(['ios', 'tvos'])
    .optional()
    .default('ios')
    .describe('The simulator platform to download WDA for. Default is "ios". Use "tvos" for Apple TV simulators.'),
  skipWda: z
    .boolean()
    .optional()
    .describe('If true, only boot the simulator without downloading or installing WDA. Default: false.'),
  forceRefreshWda: z.boolean().optional().describe('If true, re-download WDA even if already cached. Default: false.'),
});

export default function prepareIosSimulator(server: FastMCP): void {
  server.addTool({
    name: 'prepare_ios_simulator',
    description:
      'Boot an iOS/tvOS simulator, download/cache WDA, and launch it on a free per-simulator port. ' +
      'Pass capabilitiesHint (appium:webDriverAgentUrl) to appium_session_management action=create to reuse WDA. ' +
      'Managed preparation requires effortToken, worktree and stable operationId. Existing WDA is preserved, never replaced. ' +
      'skipWda=true only boots. APPIUM_MCP_WDA_APP_PATH can point to an extracted WebDriverAgentRunner-Runner.app (absolute path) to skip download.',
    parameters: prepareIosSimulatorSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (args: z.infer<typeof prepareIosSimulatorSchema>): Promise<ContentResult> => {
      if (process.platform !== 'darwin') {
        throw new Error('iOS simulator preparation is only supported on macOS');
      }

      const {udid, platform = 'ios', skipWda = false, forceRefreshWda = false} = args;

      log.info(`Preparing ${platform} simulator ${udid} (skipWda=${skipWda}, forceRefreshWda=${forceRefreshWda})`);

      const result = await prepareSimulator(udid, skipWda, forceRefreshWda, platform, args);

      return textResult(JSON.stringify(result));
    },
  });
}
