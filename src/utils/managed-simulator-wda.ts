import {WebDriverAgent, type SimulatorHostOps, type WebDriverAgentArgs} from 'appium-webdriveragent';
import {exec} from 'teen_process';

import log from '../logger.js';
import {
  prepareSimulatorWda,
  type SimulatorWdaEndpoint,
  type SimulatorWdaIdentity,
  type SimulatorWdaLifecycleDependencies,
  type SimulatorWdaPrepareResult,
} from './simulator-wda-lifecycle.js';
import {findFreePort, releaseReservedPort} from './ports.js';
import type {SimulatorWdaApp} from './simulator-wda-app.js';
import {startSuppliedSimulatorWda} from './supplied-simulator-wda.js';
import {getWdaLogTail, sanitizeDiagnostic} from './wda-readiness.js';

export interface ManagedSimulatorWdaOptions {
  udid: string;
  platform: 'ios' | 'tvos';
  runtime: string;
  artifact: string;
  toolchain: string;
  retryPermanentFailure?: boolean;
  suppliedApp?: SimulatorWdaApp;
}

export function createSimulatorWdaIdentity(options: ManagedSimulatorWdaOptions): SimulatorWdaIdentity {
  return {
    udid: options.udid,
    platform: options.platform,
    runtime: options.runtime,
    artifact: options.artifact,
    toolchain: options.toolchain,
  };
}

export async function hasBusyXctestOwner(udid: string): Promise<boolean> {
  // The bundled WDA default reset uses broad pgrep patterns for every xcodebuild,
  // XCTRunner, and xctest process containing this UDID. Detect and refuse before
  // startup; never delegate to that destructive default.
  let stdout: string;
  try {
    ({stdout} = await exec('pgrep', ['-ifl', udid], {timeout: 5000}));
  } catch (error) {
    if ((error as {code?: string})?.code === '1') {
      return false;
    }
    throw error;
  }
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  return lines.some((line) => /(xcodebuild|xctest|xctrunner|testmanagerd)/i.test(line));
}

export async function makeManagedWda(
  identity: SimulatorWdaIdentity,
  port: number,
  suppliedApp?: SimulatorWdaApp,
): Promise<{wda: WebDriverAgent; endpoint: SimulatorWdaEndpoint; getSuppliedFailure: () => Promise<Error> | undefined}> {
  const endpoint = {url: `http://127.0.0.1:${port}`, port};
  let suppliedRunner: Awaited<ReturnType<typeof startSuppliedSimulatorWda>> | undefined;
  let reportSuppliedFailure: ((error: Error) => void) | undefined;
  const suppliedFailure = suppliedApp ? new Promise<Error>((resolve) => { reportSuppliedFailure = resolve; }) : undefined;
  const simulatorHostOps: SimulatorHostOps = {
    async resetTestProcesses({udid}) {
      let busy: boolean;
      try {
        busy = await hasBusyXctestOwner(udid);
      } catch (error) {
        throw new Error(`Could not verify XCTest ownership for simulator ${udid}; refusing startup without signaling processes.`, {cause: error});
      }
      if (busy) {
        throw new Error(`Simulator ${udid} is busy with another XCTest owner; WDA was not launched and no processes were signaled.`);
      }
      // Deliberately omit the bundled broad reset operation. The managed facade
      // proceeds to xcodebuild start after this ownership gate.
    },
    async launchPreinstalled({udid, bundleId}) {
      if (!suppliedApp || bundleId !== suppliedApp.bundleId || udid !== identity.udid) {
        throw new Error('Refusing to launch an unvalidated WDA app or a different simulator.');
      }
      if (suppliedRunner) {
        throw new Error('The supplied WDA XCTest runner is already owned by this managed startup.');
      }
      suppliedRunner = await startSuppliedSimulatorWda({app: suppliedApp, udid, port});
      void suppliedRunner.failure.then((error) => reportSuppliedFailure?.(error));
    },
    async terminate({udid, bundleId}) {
      if (!suppliedApp || bundleId !== suppliedApp.bundleId || udid !== identity.udid) {
        throw new Error('Refusing to terminate an app not owned by this managed WDA launch.');
      }
      await suppliedRunner?.stop();
      suppliedRunner = undefined;
    },
  };
  const args: WebDriverAgentArgs = {
    device: {udid: identity.udid},
    realDevice: false,
    platformName: identity.platform === 'tvos' ? 'tvOS' : 'iOS',
    platformVersion: identity.runtime,
    wdaLocalPort: port,
    wdaRemotePort: port,
    wdaBaseUrl: endpoint.url,
    wdaLaunchTimeout: 120_000,
    usePreinstalledWDA: Boolean(suppliedApp),
    updatedWDABundleId: suppliedApp?.bundleId,
    updatedWDABundleIdSuffix: suppliedApp ? '' : undefined,
    hostOps: {simulator: simulatorHostOps},
  };
  const wda = new WebDriverAgent(args, log);
  return {wda, endpoint, getSuppliedFailure: () => suppliedFailure};
}

export async function isEndpointOwnedBySimulator(port: number, udid: string): Promise<boolean> {
  const {stdout: listeners} = await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {timeout: 5000});
  const pids = [...listeners.matchAll(/^p(\d+)$/gm)].map((match) => match[1]);
  if (pids.length !== 1) {
    return false;
  }
  const {stdout: processInfo} = await exec('ps', ['-p', pids[0], '-o', 'command='], {timeout: 5000});
  return processInfo.split(/\s+/).some((part) => part.includes(`/CoreSimulator/Devices/${udid}/`));
}

export const simulatorWdaLifecycleDependencies: Pick<SimulatorWdaLifecycleDependencies, 'startManaged' | 'isEndpointReady' | 'hasBusyTestOwner'> = {
  async startManaged(identity, suppliedApp?: SimulatorWdaApp) {
    const port = await findFreePort();
    const {wda, endpoint, getSuppliedFailure} = await makeManagedWda(identity, port, suppliedApp);
    const attemptStartedAt = new Date();
    try {
      const launch = wda.launch(`appium-mcp-${identity.udid}`);
      const suppliedFailure = getSuppliedFailure();
      const status = suppliedFailure
        ? await Promise.race([
          launch.then((value) => ({kind: 'launch' as const, value})),
          suppliedFailure.then((error) => ({kind: 'failure' as const, error})),
        ]).then((result) => {
          if (result.kind === 'failure') {
            throw result.error;
          }
          return result.value;
        })
        : await launch;
      if (!status) {
        const logEvidence = await getWdaLogTail(identity.udid, undefined, attemptStartedAt);
        const diagnostics = `${suppliedFailure ? 'The supplied xcodebuild process remained active but WDA did not become ready. ' : ''}Bounded current-attempt simulator log evidence: ${sanitizeDiagnostic(logEvidence)}`;
        throw new Error(`Managed WebDriverAgent exited before readiness for simulator ${identity.udid}. ${diagnostics}`);
      }
      releaseReservedPort(port);
      return {
        endpoint,
        cleanup: async () => {
          await wda.quit();
          releaseReservedPort(port);
        },
      };
    } catch (error) {
      await wda.quit().catch(() => undefined);
      releaseReservedPort(port);
      const original = error instanceof Error ? error.message : String(error);
      const diagnostics = await getWdaLogTail(identity.udid, undefined, attemptStartedAt);
      throw new Error(`${original}\nBounded current-attempt simulator log evidence: ${sanitizeDiagnostic(diagnostics)}`, {cause: error});
    }
  },
  async isEndpointReady(endpoint, identity) {
    try {
      if (!(await isEndpointOwnedBySimulator(endpoint.port, identity.udid))) {
        return false;
      }
      const response = await fetch(`${endpoint.url}/status`, {signal: AbortSignal.timeout(3000)});
      if (!response.ok) {
        return false;
      }
      const payload = (await response.json()) as {value?: {build?: {productBundleIdentifier?: string}; ios?: {simulatorVersion?: string}; os?: {name?: string}}};
      const value = payload.value;
      // WebDriverAgent's /status response does not include a simulator UDID.
      // Attribution to this simulator comes from the private endpoint allocated
      // for, and returned by, this managed launch—not from a nonexistent status field.
      const productMatches = Boolean(value?.build?.productBundleIdentifier?.includes('WebDriverAgentRunner'));
      const platformMatches = identity.platform === 'tvos'
        ? value?.os?.name?.toLowerCase() === 'tvos'
        : value?.os?.name?.toLowerCase() === 'ios' && typeof value?.ios?.simulatorVersion === 'string';
      return productMatches && platformMatches;
    } catch {
      return false;
    }
  },
  async hasBusyTestOwner(identity) {
    try {
      return await hasBusyXctestOwner(identity.udid);
    } catch (error) {
      if ((error as {code?: string})?.code === '1') {
        return false;
      }
      throw error;
    }
  },
};

export async function startManagedSimulatorWda(options: ManagedSimulatorWdaOptions): Promise<SimulatorWdaPrepareResult> {
  const identity = createSimulatorWdaIdentity(options);
  const suppliedApp = options.suppliedApp;
  return await prepareSimulatorWda(identity, simulatorWdaLifecycleDependencies, {
    retryPermanentFailure: options.retryPermanentFailure,
    startContext: suppliedApp,
  });
}
