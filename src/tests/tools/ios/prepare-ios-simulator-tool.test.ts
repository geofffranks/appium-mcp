import {describe, expect, jest, test} from '@jest/globals';

const mockAddTool = jest.fn();
const mockExec = jest.fn(async (command: string, args: string[] = []) => ({stdout: command === 'xcodebuild' ? 'Xcode 26.2\nBuild version 17C123' : args.some((arg) => arg.includes('CFBundleIdentifier')) ? 'com.facebook.WebDriverAgentRunner' : 'WebDriverAgentRunner-Runner'}));
const mockManagedStart = jest.fn(async (options: any) => ({
  status: 'ready',
  record: {identity: {udid: options.udid}, state: 'ready', owned: true, endpoint: {url: 'http://127.0.0.1:8123', port: 8123}},
}));
const mockBootDevice = jest.fn(async () => {});
const mockStartBootMonitor = jest.fn(async () => {});
const mockIOSManager = {
  getInstance: () => ({listSimulators: async () => [{udid: 'test-udid', name: 'iPhone', state: 'Booted', platform: '26.5'}]}),
};
jest.unstable_mockModule('../../../devicemanager/ios-manager.js', () => ({IOSManager: mockIOSManager}));
jest.unstable_mockModule('node-simctl', () => ({Simctl: class {udid = ''; bootDevice = mockBootDevice; startBootMonitor = mockStartBootMonitor;}}));
jest.unstable_mockModule('teen_process', () => ({exec: mockExec}));
jest.unstable_mockModule('../../../utils/managed-simulator-wda.js', () => ({startManagedSimulatorWda: mockManagedStart}));
jest.unstable_mockModule('../../../utils/simulator-wda-identity.js', () => ({createSimulatorWdaArtifactIdentity: async () => ({artifact: 'test-artifact', toolchain: 'test-toolchain'})}));
jest.unstable_mockModule('../../../utils/simulator-wda-app.js', () => ({validateSimulatorWdaApp: async (appPath: string) => ({path: appPath, bundleId: 'com.facebook.WebDriverAgentRunner'})}));
jest.unstable_mockModule('../../../utils/wda-readiness.js', () => ({sanitizeDiagnostic: (text: string) => text}));
jest.unstable_mockModule('../../../logger.js', () => ({default: {info: jest.fn()}}));
jest.unstable_mockModule('../../../tools/tool-response.js', () => ({textResult: (text: string) => ({content: [{type: 'text', text}]})}));
const {default: registerPrepareIosSimulator} = await import('../../../tools/ios/prepare-ios-simulator.js');

async function toolExecute() {
  mockAddTool.mockReset();
  registerPrepareIosSimulator({addTool: mockAddTool} as any);
  return (mockAddTool.mock.calls[0][0] as {execute: (args: any) => Promise<any>}).execute;
}

async function withDarwin<T>(action: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {configurable: true, value: 'darwin'});
  try {
    return await action();
  } finally {
    if (descriptor) {
      Object.defineProperty(process, 'platform', descriptor);
    }
  }
}

describe('prepare_ios_simulator tool', () => {
  test('returns managed WDA endpoint and attach capabilities for the selected UDID', async () => {
    mockManagedStart.mockClear();
    const execute = await toolExecute();
    const result = await withDarwin(() => execute({udid: 'test-udid', platform: 'ios'}));
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ready).toBe(true);
    expect(parsed.webDriverAgentUrl).toBe('http://127.0.0.1:8123');
    expect(parsed.capabilitiesHint['appium:webDriverAgentUrl']).toBe('http://127.0.0.1:8123');
    expect(parsed.capabilitiesHint['appium:noReset']).toBe(true);
    expect(mockManagedStart).toHaveBeenCalledWith(expect.objectContaining({udid: 'test-udid', platform: 'ios', runtime: '26.5'}));
  });

  test('skipWda only boots and never invokes managed startup', async () => {
    mockManagedStart.mockClear();
    const execute = await toolExecute();
    const result = await withDarwin(() => execute({udid: 'test-udid', skipWda: true}));
    const parsed = JSON.parse(result.content[0].text as string);
    expect(parsed.ready).toBe(true);
    expect(parsed.wda_install.detail).toBe('skipWda=true');
    expect(mockManagedStart).not.toHaveBeenCalled();
  });

  test('force refresh does not activate deliberate permanent-failure retry', async () => {
    mockManagedStart.mockClear();
    const execute = await toolExecute();
    await withDarwin(() => execute({udid: 'test-udid', forceRefreshWda: true}));
    expect(mockManagedStart).toHaveBeenCalledWith(expect.objectContaining({retryPermanentFailure: false}));
  });

  test('retryWda is passed only when explicitly requested', async () => {
    mockManagedStart.mockClear();
    const execute = await toolExecute();
    await withDarwin(() => execute({udid: 'test-udid', retryWda: true}));
    expect(mockManagedStart).toHaveBeenCalledWith(expect.objectContaining({retryPermanentFailure: true}));
  });

  test('passes a supplied .app override to the Xcode-managed XCTest startup', async () => {
    const oldPath = process.env.APPIUM_MCP_WDA_APP_PATH;
    process.env.APPIUM_MCP_WDA_APP_PATH = '/tmp/runner.app';
    mockManagedStart.mockClear();
    const execute = await toolExecute();
    try {
      const result = await withDarwin(() => execute({udid: 'test-udid'}));
      expect(result.content[0].text).toContain('"ready":true');
      expect(mockManagedStart).toHaveBeenCalledWith(expect.objectContaining({suppliedApp: {path: '/tmp/runner.app', bundleId: expect.any(String)}}));
    } finally {
      if (oldPath === undefined) {
        delete process.env.APPIUM_MCP_WDA_APP_PATH;
      } else {
        process.env.APPIUM_MCP_WDA_APP_PATH = oldPath;
      }
    }
  });
});
