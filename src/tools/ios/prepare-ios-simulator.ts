import type {ContentResult, FastMCP} from 'fastmcp';
import {Simctl} from 'node-simctl';
import {z} from 'zod';

import {IOSManager} from '../../devicemanager/ios-manager.js';
import log from '../../logger.js';
import {startManagedSimulatorWda} from '../../utils/managed-simulator-wda.js';
import {validateSimulatorWdaApp} from '../../utils/simulator-wda-app.js';
import {createSimulatorWdaArtifactIdentity} from '../../utils/simulator-wda-identity.js';
import {sanitizeDiagnostic} from '../../utils/wda-readiness.js';
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
  wdaLocalPort?: number;
  webDriverAgentUrl?: string;
  capabilitiesHint?: Record<string, unknown>;
}

async function installWdaStep(
  result: PrepareResult,
  simulator: {udid: string; platform?: string},
  platform: 'ios' | 'tvos',
  retryWda: boolean,
): Promise<void> {
  const udid = simulator.udid;
  try {
    const override = process.env.APPIUM_MCP_WDA_APP_PATH?.trim();
    const suppliedApp = override ? await validateSimulatorWdaApp(override) : undefined;

    const identity = await createSimulatorWdaArtifactIdentity({platform, runtime: simulator.platform || 'unknown', suppliedApp});
    const startup = await startManagedSimulatorWda({
      udid,
      platform,
      runtime: simulator.platform || 'unknown',
      ...identity,
      retryPermanentFailure: retryWda,
      suppliedApp,
    });
    if (startup.status === 'failed') {
      result.wda_install = {
        status: 'failed',
        detail: `WDA startup failed (kind=${startup.failure.kind}, permanence=${startup.failure.permanence}, suppressed=${startup.suppressed}, UDID=${udid}). ${startup.failure.message} Evidence: ${startup.failure.evidence || 'none'}`,
      };
      return;
    }
    const endpoint = startup.record.endpoint;
    if (!endpoint) {
      result.wda_install = {status: 'failed', detail: 'Managed WDA reported ready without an endpoint.'};
      return;
    }
    result.wdaLocalPort = endpoint.port;
    result.webDriverAgentUrl = endpoint.url;
    result.capabilitiesHint = {
      'appium:webDriverAgentUrl': endpoint.url,
      'appium:udid': udid,
      'appium:useNewWDA': false,
      'appium:noReset': true,
    };
    result.wda_install = {
      status: startup.status === 'already-running' ? 'skipped' : 'completed',
      detail: `Managed WDA is ready on ${endpoint.url} for simulator ${udid}.`,
    };
    result.ready = true;
  } catch (error: unknown) {
    result.wda_install = {status: 'failed', detail: sanitizeDiagnostic(String(error))};
  }
}

async function prepareSimulator(
  udid: string,
  skipWda: boolean,
  forceRefreshWda: boolean,
  platform: 'ios' | 'tvos' = 'ios',
  retryWda = false,
): Promise<PrepareResult> {
  const result: PrepareResult = {
    boot: {status: 'skipped', detail: ''},
    wda_download: {status: 'skipped', detail: ''},
    wda_install: {status: 'skipped', detail: ''},
    ready: false,
    udid,
  };

  let simulator: Awaited<ReturnType<ReturnType<typeof IOSManager.getInstance>['listSimulators']>>[number] | undefined;
  try {
    simulator = (await IOSManager.getInstance().listSimulators()).find((item) => item.udid === udid);
    if (!simulator) {
      result.boot = {
        status: 'failed',
        detail: `Simulator with UDID "${udid}" not found. Use select_device to get a valid UDID.`,
      };
      return result;
    }
    if (simulator.state === 'Booted') {
      result.boot = {status: 'skipped', detail: `${simulator.name} is already booted`};
    } else {
      log.info(`Booting simulator ${simulator.name} (${udid})...`);
      const simctl = new Simctl();
      simctl.udid = udid;
      await simctl.bootDevice();
      await simctl.startBootMonitor({timeout: 120000});
      result.boot = {status: 'completed', detail: `${simulator.name} booted successfully`};
    }
  } catch (error: unknown) {
    result.boot = {status: 'failed', detail: sanitizeDiagnostic(String(error))};
    return result;
  }

  if (skipWda) {
    result.wda_download = {status: 'skipped', detail: 'skipWda=true'};
    result.wda_install = {status: 'skipped', detail: 'skipWda=true'};
    result.ready = true;
    return result;
  }

  // This legacy flag no longer bypasses permanent WDA failure suppression.
  result.wda_download = {
    status: 'skipped',
    detail: forceRefreshWda
      ? 'forceRefreshWda does not bypass a known permanent WDA startup failure.'
      : 'Using bundled Xcode-managed WebDriverAgent.',
  };
  await installWdaStep(result, simulator, platform, retryWda);
  return result;
}

const prepareIosSimulatorSchema = z.object({
  udid: z.string().describe('The UDID of the iOS simulator to prepare. Use select_device to get this.'),
  platform: z.enum(['ios', 'tvos']).optional().default('ios'),
  skipWda: z.boolean().optional().describe('If true, only boot the simulator without starting WDA.'),
  forceRefreshWda: z.boolean().optional().describe('Legacy refresh flag; does not clear permanent startup failures.'),
  retryWda: z.boolean().optional().describe('Deliberately retry a known permanent WDA failure after repairing inputs.'),
});

export default function prepareIosSimulator(server: FastMCP): void {
  server.addTool({
    name: 'prepare_ios_simulator',
    description:
      'Boot an iOS/tvOS simulator and start bundled WebDriverAgent through Xcode-managed XCTest. ' +
      'Pass capabilitiesHint to session creation to attach to the ready WDA without starting a second runner. ' +
      'Busy XCTest owners are preserved and reported as conflicts. skipWda=true only boots. ' +
      'Use retryWda=true only after repairing a known permanent startup failure. ' +
      'APPIUM_MCP_WDA_APP_PATH is preserved; incompatible artifacts receive an actionable error.',
    parameters: prepareIosSimulatorSchema,
    annotations: {readOnlyHint: false, openWorldHint: false},
    execute: async (args: z.infer<typeof prepareIosSimulatorSchema>): Promise<ContentResult> => {
      if (process.platform !== 'darwin') {
        throw new Error('iOS simulator preparation is only supported on macOS');
      }
      const {udid, platform = 'ios', skipWda = false, forceRefreshWda = false, retryWda = false} = args;
      log.info(`Preparing ${platform} simulator ${udid} (skipWda=${skipWda}, forceRefreshWda=${forceRefreshWda}, retryWda=${retryWda})`);
      const result = await prepareSimulator(udid, skipWda, forceRefreshWda, platform, retryWda);
      return textResult(JSON.stringify(result));
    },
  });
}
