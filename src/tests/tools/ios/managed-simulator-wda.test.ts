import {afterAll, afterEach, describe, expect, jest, test} from '@jest/globals';

const mockExec = jest.fn(async (_command: string, _args: string[], _options?: {timeout?: number}) => ({stdout: '451 xcodebuild -destination id=busy-simulator'}));
class MockSubProcess {
  isRunning = false;
  async start() {}
  async stop() {}
  async join() {}
}
const mockWdaConstructor = jest.fn();
const mockLaunch = jest.fn(async () => true);
const mockQuit = jest.fn(async () => {});
const mockReleasePort = jest.fn();
const mockFetch = jest.fn<typeof fetch>();
const originalFetch = global.fetch;
global.fetch = mockFetch;
jest.unstable_mockModule('teen_process', () => ({exec: mockExec, SubProcess: MockSubProcess}));
jest.unstable_mockModule('appium-webdriveragent', () => ({
  WebDriverAgent: class {
    constructor(args: any) { mockWdaConstructor(args); }
    launch(_name: string) { return mockLaunch(); }
    quit() { return mockQuit(); }
  },
}));
jest.unstable_mockModule('../../../logger.js', () => ({default: {info: jest.fn()}}));
jest.unstable_mockModule('../../../utils/ports.js', () => ({findFreePort: async () => 8101, releaseReservedPort: mockReleasePort}));

const {makeManagedWda, createSimulatorWdaIdentity, isEndpointOwnedBySimulator, simulatorWdaLifecycleDependencies} = await import('../../../utils/managed-simulator-wda.js');

afterAll(() => { global.fetch = originalFetch; });

afterEach(() => {
  mockExec.mockReset().mockResolvedValue({stdout: '451 xcodebuild -destination id=busy-simulator'});
  mockLaunch.mockReset().mockResolvedValue(true);
  mockQuit.mockReset().mockResolvedValue();
  mockReleasePort.mockReset();
  mockFetch.mockReset();
});

const makeIdentity = (udid = 'busy-simulator') => createSimulatorWdaIdentity({udid, platform: 'ios', runtime: '26.5', artifact: 'bundled', toolchain: 'Xcode 26'});

describe('managed simulator WDA adapter', () => {
  test('injected reset hook rejects busy XCTest owner without invoking any reset or launch', async () => {
    mockExec.mockResolvedValue({stdout: '451 xcodebuild -destination id=busy-simulator'});
    await makeManagedWda(makeIdentity(), 8101);
    const args = mockWdaConstructor.mock.calls.at(-1)?.[0] as any;
    await expect(args.hostOps.simulator.resetTestProcesses({udid: 'busy-simulator', isSimulator: true})).rejects.toThrow(/busy with another XCTest owner/);
    expect(mockExec).toHaveBeenCalledWith('pgrep', ['-ifl', 'busy-simulator'], {timeout: 5000});
    expect(mockExec.mock.calls.some(([command]) => command === 'kill')).toBe(false);
  });

  test('injected reset hook treats pgrep no-match as clear and fails closed on other errors', async () => {
    mockExec.mockRejectedValueOnce(Object.assign(new Error('no matches'), {code: '1'}));
    await makeManagedWda(makeIdentity(), 8101);
    const args = mockWdaConstructor.mock.calls.at(-1)?.[0] as any;
    const hook = args.hostOps.simulator.resetTestProcesses;
    await expect(hook({udid: 'busy-simulator', isSimulator: true})).resolves.toBeUndefined();
    mockExec.mockRejectedValueOnce(Object.assign(new Error('permission denied'), {code: '2'}));
    await expect(hook({udid: 'busy-simulator', isSimulator: true})).rejects.toThrow(/Could not verify XCTest ownership/);
  });

  test('uses explicit simulator UDID and tvOS scheme identity', async () => {
    mockExec.mockResolvedValue({stdout: ''});
    await makeManagedWda({...makeIdentity('tv-simulator'), platform: 'tvos'}, 8123);
    const args = mockWdaConstructor.mock.calls.at(-1)?.[0] as any;
    expect(args.device.udid).toBe('tv-simulator');
    expect(args.platformName).toBe('tvOS');
    expect(args.wdaLocalPort).toBe(8123);
  });

  test('attributes a listening endpoint only to the exact simulator process path', async () => {
    mockExec.mockImplementation(async (command, args) => {
      if (command === 'lsof') {
        return {stdout: 'p123\n'};
      }
      if (command === 'ps') {
        return {stdout: args[1] === '123' ? '/Applications/Xcode.app/.../CoreSimulator/Devices/expected-simulator/data/Applications/WDA.app/WDA' : ''};
      }
      return {stdout: ''};
    });
    await expect(isEndpointOwnedBySimulator(8101, 'expected-simulator')).resolves.toBe(true);
    await expect(isEndpointOwnedBySimulator(8101, 'other-simulator')).resolves.toBe(false);
    mockExec.mockImplementation(async (command) => ({stdout: command === 'lsof' ? '' : ''}));
    await expect(isEndpointOwnedBySimulator(8101, 'expected-simulator')).resolves.toBe(false);
  });

  test('accepts the actual WDA simulator status shape, which has no UDID field', async () => {
    mockExec.mockImplementation(async (command) => ({stdout: command === 'lsof' ? 'p123\n' : '/CoreSimulator/Devices/expected-simulator/data/Applications/WDA.app/WDA'}));
    const identity = makeIdentity('expected-simulator');
    const endpoint = {url: 'http://127.0.0.1:8101', port: 8101};
    mockFetch.mockResolvedValue({ok: true, json: async () => ({value: {
      ready: true,
      os: {name: 'iOS', version: '26.5'},
      ios: {simulatorVersion: '26.5', ip: '127.0.0.1'},
      build: {productBundleIdentifier: 'com.facebook.WebDriverAgentRunner'},
      device: 'iphone',
    }})} as Response);
    await expect(simulatorWdaLifecycleDependencies.isEndpointReady(endpoint, identity)).resolves.toBe(true);

    mockFetch.mockResolvedValue({ok: true, json: async () => ({value: {
      os: {name: 'iOS'},
      build: {productBundleIdentifier: 'com.example.NotWDA'},
    }})} as Response);
    await expect(simulatorWdaLifecycleDependencies.isEndpointReady(endpoint, identity)).resolves.toBe(false);

    mockFetch.mockResolvedValue({ok: true, json: async () => ({value: {
      os: {name: 'tvOS'},
      build: {productBundleIdentifier: 'com.facebook.WebDriverAgentRunner'},
    }})} as Response);
    await expect(simulatorWdaLifecycleDependencies.isEndpointReady(endpoint, identity)).resolves.toBe(false);
  });

  test('persists current-attempt loader logs when launch rejects and releases resources', async () => {
    mockLaunch.mockRejectedValue(new Error('launch failed after process start'));
    mockExec.mockImplementation(async (command) => ({stdout: command === 'xcrun' ? 'dyld: Library missing XCTest.framework' : ''}));
    await expect(simulatorWdaLifecycleDependencies.startManaged(makeIdentity())).rejects.toThrow(/launch failed[\s\S]*current-attempt simulator log evidence[\s\S]*XCTest\.framework/);
    const logCall = mockExec.mock.calls.find(([command]) => command === 'xcrun');
    expect(logCall?.[1]).toContain('--start');
    expect(logCall?.[1]).toContain('process CONTAINS[c] "WebDriverAgent"');
    expect(mockQuit).toHaveBeenCalledTimes(1);
    expect(mockReleasePort).toHaveBeenCalledWith(8101);
  });
});
