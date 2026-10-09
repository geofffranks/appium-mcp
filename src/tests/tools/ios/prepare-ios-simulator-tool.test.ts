import {describe, expect, jest, test} from '@jest/globals';

import {sanitizeDiagnostic as realSanitizeDiagnostic} from '../../../utils/wda-readiness.js';

const mockWaitForWdaReady = jest.fn(async () => ({
  ready: false,
  elapsedMs: 30_000,
  lastProbe: 'Request error: Error: token=[REDACTED]',
}));
const mockGetWdaLogTail = jest.fn(async () => 'WDA log authorization=[REDACTED]');
const mockExec = jest.fn(async (command: string, args: string[], _options?: {timeout: number}) => ({
  stdout: command === 'plutil' ? '{}' : args.includes('listapps') ? '<?xml version="1.0"?><plist><dict/></plist>' : '',
}));
jest.unstable_mockModule('../../../utils/effort-authority.js', () => ({callEffortAuthority: async () => ({ok: true, status: 'updated'})}));
const mockAddTool = jest.fn();
const mockIOSManager = {
  getInstance: () => ({listSimulators: async () => [{udid: 'test-udid', name: 'iPhone', state: 'Booted'}]}),
};

jest.unstable_mockModule('../../../devicemanager/ios-manager.js', () => ({IOSManager: mockIOSManager}));
jest.unstable_mockModule('node-simctl', () => ({Simctl: class {}}));
jest.unstable_mockModule('teen_process', () => ({exec: mockExec}));
jest.unstable_mockModule('../../../utils/ports.js', () => ({
  findFreePort: async () => 8101,
  releaseReservedPort: jest.fn(),
}));
jest.unstable_mockModule('../../../utils/wda-readiness.js', () => ({
  getWdaLogTail: mockGetWdaLogTail,
  sanitizeDiagnostic: realSanitizeDiagnostic,
  waitForWdaReady: mockWaitForWdaReady,
}));
jest.unstable_mockModule('../../../logger.js', () => ({default: {info: jest.fn(), error: jest.fn()}}));
jest.unstable_mockModule('@appium/support', () => ({
  fs: {hasAccess: async () => true, readdir: async () => [], mkdirp: async () => {}, unlink: async () => {}},
  net: {},
  plist: {parsePlistFile: async () => ({CFBundleIdentifier: 'com.example.wda'})},
  zip: {},
}));
jest.unstable_mockModule('../../../utils/paths.js', () => ({resolveAppiumMcpCachePath: () => '/cache/wda'}));
jest.unstable_mockModule('../../../tools/tool-response.js', () => ({
  textResult: (text: string) => ({content: [{type: 'text', text}]}),
}));

const {default: registerPrepareIosSimulator} = await import('../../../tools/ios/prepare-ios-simulator.js');

describe('prepare_ios_simulator tool failure composition', () => {
  test('fails closed when plutil returns malformed simulator inventory', async () => {
    mockAddTool.mockReset();
    mockExec.mockImplementation(async (command: string, args: string[]) => ({
      stdout: command === 'plutil' ? '{malformed' : args.includes('listapps') ? '<?xml version="1.0"?><plist><dict/></plist>' : '',
    }));
    registerPrepareIosSimulator({addTool: mockAddTool} as any);
    const definition = mockAddTool.mock.calls[0][0] as {execute: (args: any) => Promise<any>};
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {configurable: true, value: 'darwin'});
    let result: any;
    try {
      result = await definition.execute({udid: 'test-udid', platform: 'ios', effortToken: 'test-owner', operationId: 'prepare', worktree: process.cwd()});
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
    }
    const parsed = JSON.parse(result.content[0].text as string);

    expect(parsed.wda_install.status).toBe('failed');
    expect(parsed.wda_install.detail).toContain('installation state could not be verified');
    expect(mockExec).not.toHaveBeenCalledWith('xcrun', expect.arrayContaining(['install', 'test-udid']));
  });

  test('returns readiness diagnostics and a sanitized bounded WDA log tail', async () => {
    mockAddTool.mockReset();
    mockExec.mockReset();
    mockExec.mockImplementation(async (command: string, args: string[]) => ({
      stdout: command === 'plutil' ? '{}' : args.includes('listapps') ? '<?xml version="1.0"?><plist><dict/></plist>' : '',
    }));
    registerPrepareIosSimulator({addTool: mockAddTool} as any);
    const definition = mockAddTool.mock.calls[0][0] as {execute: (args: any) => Promise<any>};
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {configurable: true, value: 'darwin'});
    let result: any;
    try {
      result = await definition.execute({udid: 'test-udid', platform: 'ios', effortToken: 'test-owner', operationId: 'prepare', worktree: process.cwd()});
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
    }
    const text = result.content[0].text as string;
    const parsed = JSON.parse(text);

    expect(parsed.ready).toBe(false);
    expect(parsed.wda_install.status).toBe('failed');
    expect(mockExec).toHaveBeenCalledWith('xcrun', ['simctl', 'listapps', 'test-udid']);
    expect(mockExec).toHaveBeenCalledWith(
      'plutil',
      ['-convert', 'json', '-o', '-', '--', expect.stringMatching(/listapps\.plist$/)],
      {timeout: 5000},
    );
    expect(parsed.udid).toBe('test-udid');
    expect(parsed.wda_install.detail).toContain('phase=readiness');
    expect(parsed.wda_install.detail).toContain('elapsedMs=30000');
    expect(parsed.wda_install.detail).toContain('lastProbe=Request error');
    expect(parsed.wda_install.detail).not.toContain('probe-secret');
    expect(parsed.wda_install.detail).not.toContain('log-secret');
    expect(parsed.wda_install.detail).toContain('authorization=[REDACTED]');
  });
});
