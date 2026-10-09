import {describe, expect, jest, test} from '@jest/globals';

const driverState = {deleted: false, interactions: 0};
class MockDriver {
  async createSession() {return ['local-session', {}];}
  async getPageSource() {driverState.interactions += 1; return '<App/>';}
  async deleteSession() {driverState.deleted = true;}
}
jest.unstable_mockModule('appium-uiautomator2-driver', () => ({AndroidUiautomator2Driver: class {}}));
jest.unstable_mockModule('appium-xcuitest-driver', () => ({XCUITestDriver: class XCUITestDriver extends MockDriver {}}));
jest.unstable_mockModule('webdriver', () => ({default: {newSession: jest.fn(), attachToSession: jest.fn()}}));
jest.unstable_mockModule('appium-webdriveragent', () => ({BOOTSTRAP_PATH: '/mock/wda'}));
jest.unstable_mockModule('node-simctl', () => ({Simctl: class {async bootDevice() {} async startBootMonitor() {}}}));
jest.unstable_mockModule('../../devicemanager/adb-manager', () => ({ADBManager: {getInstance: jest.fn()}}));
jest.unstable_mockModule('../../devicemanager/ios-manager', () => ({
  IOSManager: {getInstance: () => ({listSimulators: async () => [{udid: 'assigned', name: 'iPhone', state: 'Booted'}], getDevicesByType: async () => [{udid: 'assigned'}]})},
}));
jest.unstable_mockModule('teen_process', () => ({exec: jest.fn(async (_command: string, args: string[]) => ({
  stdout: args.includes('listapps') ? '<?xml version="1.0"?><plist><dict/></plist>' : '',
}))}));
jest.unstable_mockModule('../../utils/ports.js', () => ({findFreePort: async () => 8101, releaseReservedPort: jest.fn(), releaseReservedPorts: jest.fn()}));
jest.unstable_mockModule('../../utils/wda-readiness.js', () => ({
  getWdaLogTail: async () => '', sanitizeDiagnostic: (value: string) => value, waitForWdaReady: async () => ({ready: true, elapsedMs: 1, lastProbe: 'ready'}),
}));
jest.unstable_mockModule('@appium/support', () => ({
  logger: {getLogger: () => ({info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), trace: jest.fn(), unwrap: () => ({stream: process.stderr})})},
  fs: {hasAccess: async () => true, readdir: async () => [], mkdirp: async () => {}, unlink: async () => {}},
  imageUtil: {requireSharp: () => jest.fn()}, util: {wrapElement: (id: string) => ({ELEMENT: id})},
  net: {downloadFile: async () => {}}, plist: {parsePlistFile: async () => ({CFBundleIdentifier: 'com.example.wda'})}, zip: {extractAllTo: async () => {}},
}));
jest.unstable_mockModule('../../utils/paths.js', () => ({resolveAppiumMcpCachePath: () => '/cache/wda', resolveAppiumMcpSessionsDir: () => null, resolveScreenshotDir: () => '/tmp', resolveAppiumResourcesPath: () => '/resources'}));
const {default: registerTools} = await import('../../tools/index.js');

const expectedNames = [
  'select_device', 'appium_session_management', 'appium_mobile_device_control', 'appium_geolocation',
  'appium_mobile_device_info', 'appium_mobile_file', 'appium_driver_settings', 'prepare_ios_simulator',
  'cleanup_ios_simulator', 'appium_prepare_ios_real_device', 'appium_gesture', 'appium_drag_and_drop',
  'appium_perform_actions', 'appium_find_element', 'appium_mobile_press_key', 'appium_set_value',
  'appium_mobile_keyboard', 'appium_get_text', 'appium_get_element_attribute', 'appium_mobile_clipboard',
  'appium_get_active_element', 'appium_get_page_source', 'appium_orientation', 'appium_alert', 'appium_screenshot',
  'appium_get_window_size', 'appium_screen_recording', 'appium_app_lifecycle', 'appium_mobile_permissions',
  'appium_context', 'generate_locators', 'appium_generate_tests',
];

function register() {
  const definitions = new Map<string, any>();
  registerTools({sessions: [], addTool: (definition: any) => definitions.set(definition.name, definition)} as any);
  return definitions;
}

describe('registered MCP tools', () => {
  test('matches expected tool names and omits retired session-binding arguments', () => {
    const definitions = register();
    expect([...definitions.keys()].sort()).toEqual([...expectedNames].sort());
    for (const definition of definitions.values()) {
      const shape = definition.parameters?.shape ?? {};
      expect(shape.effortToken).toBeUndefined();
      expect(shape.worktree).toBeUndefined();
      expect(shape.operationId).toBeUndefined();
    }
  });

  test('runs local prepare, create, interaction, and delete through registered wrappers without credentials', async () => {
    driverState.deleted = false;
    driverState.interactions = 0;
    const definitions = register();
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {configurable: true, value: 'darwin'});
    try {
      const prepared = await definitions.get('prepare_ios_simulator').execute({udid: 'assigned', skipWda: true}, {});
      expect(JSON.parse(prepared.content[0].text).ready).toBe(true);
      const created = await definitions.get('appium_session_management').execute({
        action: 'create', platform: 'ios', capabilities: '{"appium:udid":"assigned"}',
      }, {});
      expect(created.isError).not.toBe(true);
      const interacted = await definitions.get('appium_get_page_source').execute({}, {});
      expect(interacted.content[0].text).toContain('<App/>');
      const deleted = await definitions.get('appium_session_management').execute({action: 'delete'}, {});
      expect(deleted.isError).not.toBe(true);
      expect(driverState.interactions).toBe(1);
      expect(driverState.deleted).toBe(true);
    } finally {
      if (platformDescriptor) {Object.defineProperty(process, 'platform', platformDescriptor);}
    }
  });
});
