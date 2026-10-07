/**
 * Tools Registration Module
 *
 * This file registers all available MCP tools with the server.
 *
 * ADDING A NEW TOOL:
 * 1. Create your tool file in src/tools/
 * 2. Import it at the top of this file
 * 3. Call it in the registerTools function below
 *
 * See docs/CONTRIBUTING.md for detailed instructions.
 * See src/tools/README.md for tool organization.
 * See src/tools/metadata/README.md for YAML metadata approach.
 */
import type {ContentResult, FastMCP} from 'fastmcp';
import {z} from 'zod';

import log from '../logger.js';
import {getSessionInfo} from '../session-store.js';
import {
  admissionResult,
  isLocalSimulatorSession,
  isLocalAppiumEndpoint,
  managedContextFromArgs,
  withManagedToolAdmission,
} from '../utils/managed-tool-guard.js';
import {redactForLogging, redactUrlCredentials} from '../utils/sensitive.js';
import ai from './ai/ai.js';
import {isAIEnabled, assertAIConfig} from './ai/config.js';
import app from './app-management/app.js';
import mobilePermissions from './app-management/permissions.js';
import context from './context/context.js';
import dragAndDrop from './gestures/drag-and-drop.js';
import gesture from './gestures/gesture.js';
import performActionsTool from './gestures/perform-actions.js';
import getActiveElement from './interactions/active-element.js';
import clipboard from './interactions/clipboard.js';
import findElement from './interactions/find.js';
import getElementAttribute from './interactions/get-element-attribute.js';
import getPageSource from './interactions/get-page-source.js';
import getText from './interactions/get-text.js';
import alert from './interactions/handle-alert.js';
import keyboard from './interactions/keyboard.js';
import orientation from './interactions/orientation.js';
import pressKey from './interactions/press-key.js';
import screenRecording from './interactions/screen-recording.js';
import screenshot from './interactions/screenshot.js';
import setValue from './interactions/set-value.js';
import getWindowSize from './interactions/window-size.js';
import cleanupIosSimulator from './ios/cleanup-ios-simulator.js';
import prepareIosRealDevice from './ios/prepare-ios-real-device.js';
import prepareIosSimulator from './ios/prepare-ios-simulator.js';
import mobileDeviceControl from './session/device-control.js';
import deviceInfo from './session/device-info.js';
import driverSettings from './session/driver-settings.js';
import fileTransfer from './session/file-transfer.js';
import geolocation from './session/geolocation.js';
import selectDevice from './session/select-device.js';
import session from './session/session.js';
import generateTest from './test-generation/generate-tests.js';
import generateLocators from './test-generation/locators.js';

type RegisteredTool = Parameters<FastMCP['addTool']>[0];

export default function registerTools(server: FastMCP): void {
  // Wrap addTool to inject logging around tool execution
  const originalAddTool = server.addTool.bind(server);
  server.addTool = ((toolDef: RegisteredTool): void => {
    const toolName = toolDef?.name ?? 'unknown_tool';
    const originalExecute = toolDef?.execute;
    if (typeof originalExecute !== 'function') {
      return originalAddTool(toolDef);
    }
    const guarded = toolName !== 'appium_prepare_ios_real_device';
    const parameters =
      guarded && toolDef.parameters instanceof z.ZodObject
        ? toolDef.parameters.safeExtend({
            effortToken: z.string().optional().describe('Effort credential for managed local simulator operations.'),
            worktree: z.string().optional().describe('Canonical absolute host worktree bound to the effort.'),
            operationId: z.string().optional().describe('Stable operation identifier for reconciliation.'),
            sessionId: z
              .string()
              .optional()
              .describe('Explicit Appium session identifier; required for managed local simulator operations.'),
          })
        : toolDef.parameters;
    return originalAddTool({
      ...toolDef,
      parameters,
      execute: async (args, context) => {
        const start = Date.now();
        log.info(`[TOOL START] ${toolName}`, redactForLogging(args));
        try {
          if (guarded && isManagedMutation(toolName, args)) {
            const explicit = managedContextFromArgs(args);
            const values = args as Record<string, unknown>;
            const action = values.action;
            const setup =
              toolName === 'prepare_ios_simulator' ||
              toolName === 'cleanup_ios_simulator' ||
              toolName === 'select_device' ||
              (toolName === 'appium_session_management' && (action === 'create' || action === 'attach'));
            if (setup) {
              // Discovery does not admit work or change the selected-device default.
              if (toolName === 'select_device' && !values.deviceUdid) {
                return originalExecute(args, context);
              }
              let capabilities: Record<string, unknown> = {};
              if (typeof values.capabilities === 'string') {
                try {
                  capabilities = JSON.parse(values.capabilities) as Record<string, unknown>;
                } catch {
                  return admissionResult({
                    ok: false,
                    status: 'denied',
                    message: 'Invalid capabilities; nothing started.',
                  });
                }
              }
              if (typeof values.remoteServerUrl === 'string') {
                if (await isLocalAppiumEndpoint(values.remoteServerUrl)) {
                  return admissionResult({
                    ok: false,
                    status: 'denied',
                    message:
                      'Unknown local/loopback Appium attachment is not supported by managed admission; nothing started.',
                  });
                }
              } else {
                const platform = String(values.platform ?? 'ios');
                const localIOS =
                  toolName === 'prepare_ios_simulator' ||
                  (/ios|tvos/i.test(platform) && values.iosDeviceType !== 'real');
                if (localIOS) {
                  const assigned =
                    explicit?.udid ??
                    (typeof values.deviceUdid === 'string' ? values.deviceUdid : undefined) ??
                    (typeof capabilities['appium:udid'] === 'string' ? capabilities['appium:udid'] : undefined);
                  const admitted = await withManagedToolAdmission(
                    {...explicit, udid: assigned},
                    toolOperation(toolName),
                    () => originalExecute(args, context),
                  );
                  if (!admitted.admitted) {
                    return admissionResult(admitted.response ?? {ok: false, status: 'denied'});
                  }
                  return admitted.result;
                }
              }
            }
            const explicitSessionId = explicit?.sessionId;
            const session = getSessionInfo(explicitSessionId);
            const local = session?.remoteServerUrl ? await isLocalAppiumEndpoint(session.remoteServerUrl) : isLocalSimulatorSession(session);
            const defaultSession = getSessionInfo();
            const defaultLocal = !explicitSessionId && (defaultSession?.remoteServerUrl ? await isLocalAppiumEndpoint(defaultSession.remoteServerUrl) : isLocalSimulatorSession(defaultSession));
            if (defaultLocal) {
              return admissionResult({
                ok: false,
                status: 'denied',
                message:
                  'Local simulator calls must specify sessionId; the active-session default is disabled for managed simulators.',
              });
            }
            if (local) {
              if (!explicit) {
                return admissionResult({
                  ok: false,
                  status: 'denied',
                  message: 'Managed simulator calls require explicit effortToken, worktree, and sessionId.',
                });
              }
              if (
                !session?.effortToken ||
                explicit.effortToken !== session.effortToken ||
                explicit.worktree !== session.worktree
              ) {
                return admissionResult({
                  ok: false,
                  status: 'denied',
                  message: 'Session is not bound to this effort/worktree; nothing started.',
                });
              }
              const contextWithDevice = {...explicit, udid: session.udid};
              if (!contextWithDevice.udid) {
                return admissionResult({
                  ok: false,
                  status: 'denied',
                  message: 'Managed simulator call requires an explicit simulator UDID.',
                });
              }
              const admitted = await withManagedToolAdmission(contextWithDevice, toolOperation(toolName), () =>
                originalExecute(args, context),
              );
              if (!admitted.admitted) {
                return admissionResult(admitted.response ?? {ok: false, status: 'denied'});
              }
              return admitted.result;
            }
            if (explicit?.sessionId && !session && !setup) {
              return admissionResult({
                ok: false,
                status: 'denied',
                message: 'Unknown iOS session target; local simulator status cannot be established safely.',
              });
            }
          }
          const result = await originalExecute(args, context);
          const durationMs = Date.now() - start;
          log.info(
            JSON.stringify({
              tool: toolName,
              durationMs,
              sessionId: sessionIdFromToolArgs(args),
              isError: isErrorFromToolResult(result),
            }),
          );
          return result;
        } catch (err: unknown) {
          const durationMs = Date.now() - start;
          log.info(
            JSON.stringify({
              tool: toolName,
              durationMs,
              sessionId: sessionIdFromToolArgs(args),
              isError: true,
            }),
          );
          const msg = err instanceof Error ? err.stack || err.message : String(err);
          log.error(`[TOOL ERROR] ${toolName} (${durationMs}ms): ${redactUrlCredentials(msg)}`);
          throw err;
        }
      },
    });
  }) as FastMCP['addTool'];

  // Session Management
  selectDevice(server);
  session(server);
  mobileDeviceControl(server);
  geolocation(server);
  deviceInfo(server);
  fileTransfer(server);
  driverSettings(server);

  // iOS Setup
  prepareIosSimulator(server);
  cleanupIosSimulator(server);
  prepareIosRealDevice(server);

  // Gestures (touch input)
  gesture(server);
  dragAndDrop(server);
  performActionsTool(server);

  // Element Interactions
  // PRIORITY ORDER FOR ELEMENT SEARCH:
  // 1. getActiveElement    - Get currently focused element (efficient, instant)
  // 2. findElement         - Find specific element by strategy/selector
  // 3. generateLocators    - Generate all locators (heavyweight, for debugging only)
  findElement(server);
  pressKey(server);
  setValue(server);
  keyboard(server);
  getText(server);
  getElementAttribute(server);
  clipboard(server);
  getActiveElement(server);
  getPageSource(server);
  orientation(server);
  alert(server);
  screenshot(server);
  getWindowSize(server);
  screenRecording(server);

  // App Management
  app(server);
  mobilePermissions(server);

  // Context Management
  context(server);

  // Test Generation
  generateLocators(server);
  generateTest(server);

  // AI (vision-based fallback) — gated; only registered when explicitly enabled.
  assertAIConfig();
  if (isAIEnabled()) {
    ai(server);
    log.info('appium_ai tool registered (AI_VISION_ENABLED=true)');
  } else {
    log.info('appium_ai tool NOT registered (set AI_VISION_ENABLED=true to enable)');
  }

  log.info('All tools registered');
}

function isManagedMutation(toolName: string, args: unknown): boolean {
  if (
    [
      'appium_get_active_element',
      'appium_get_page_source',
      'appium_get_text',
      'appium_get_element_attribute',
      'appium_screenshot',
      'appium_get_window_size',
    ].includes(toolName)
  ) {
    return true;
  }
  if (toolName === 'appium_session_management') {
    const action = (args as {action?: string} | null)?.action;
    return action !== 'list';
  }
  return true;
}

function toolOperation(toolName: string): string {
  return toolName.includes('prepare') || toolName.includes('select_device') ? 'device' : 'appium';
}

function sessionIdFromToolArgs(args: unknown): string | undefined {
  if (
    args &&
    typeof args === 'object' &&
    'sessionId' in args &&
    typeof (args as {sessionId?: unknown}).sessionId === 'string'
  ) {
    return (args as {sessionId: string}).sessionId;
  }
  return undefined;
}

function isErrorFromToolResult(result: unknown): boolean {
  if (
    result &&
    typeof result === 'object' &&
    'content' in result &&
    Array.isArray((result as {content: unknown}).content)
  ) {
    return (result as ContentResult).isError === true;
  }
  return false;
}
