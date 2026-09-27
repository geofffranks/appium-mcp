import {describe, expect, jest, test} from '@jest/globals';

import {sanitizeDiagnostic as realSanitizeDiagnostic} from '../../../utils/wda-readiness.js';

const mockWaitForWdaReady = jest.fn(async () => ({
  ready: false,
  elapsedMs: 30_000,
  lastProbe: 'Request error: Error: token=[REDACTED]',
}));
const mockGetWdaLogTail = jest.fn(async () => 'WDA log authorization=[REDACTED]');
const mockExec = jest.fn(async () => ({stdout: ''}));
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
  test('returns readiness diagnostics and a sanitized bounded WDA log tail', async () => {
    mockAddTool.mockReset();
    registerPrepareIosSimulator({addTool: mockAddTool} as any);
    const definition = mockAddTool.mock.calls[0][0] as {execute: (args: any) => Promise<any>};
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {configurable: true, value: 'darwin'});
    let result: any;
    try {
      result = await definition.execute({udid: 'test-udid', platform: 'ios'});
    } finally {
      if (platformDescriptor) {
        Object.defineProperty(process, 'platform', platformDescriptor);
      }
    }
    const text = result.content[0].text as string;
    const parsed = JSON.parse(text);

    expect(parsed.ready).toBe(false);
    expect(parsed.wda_install.status).toBe('failed');
    expect(parsed.udid).toBe('test-udid');
    expect(parsed.wda_install.detail).toContain('phase=readiness');
    expect(parsed.wda_install.detail).toContain('elapsedMs=30000');
    expect(parsed.wda_install.detail).toContain('lastProbe=Request error');
    expect(parsed.wda_install.detail).not.toContain('probe-secret');
    expect(parsed.wda_install.detail).not.toContain('log-secret');
    expect(parsed.wda_install.detail).toContain('authorization=[REDACTED]');
  });
});
