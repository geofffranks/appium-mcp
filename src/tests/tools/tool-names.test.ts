import {describe, expect, jest, test} from '@jest/globals';

// create-session.ts statically imports these appium drivers; mock them so the
// module loads cleanly in tests without real driver binaries.
jest.unstable_mockModule('appium-uiautomator2-driver', () => ({
  AndroidUiautomator2Driver: class {},
}));

jest.unstable_mockModule('appium-xcuitest-driver', () => ({
  XCUITestDriver: class {},
}));

jest.unstable_mockModule('webdriver', () => ({
  default: {newSession: jest.fn(), attachToSession: jest.fn()},
}));

// appium-webdriveragent transitively loads @appium/base-driver, which calls
// @appium/support.fs.readPackageJsonFrom at import time — not in our mock.
jest.unstable_mockModule('appium-webdriveragent', () => ({
  BOOTSTRAP_PATH: '/mock/wda',
}));

// node-simctl loads asyncbox → p-limit (pure ESM), which fails on older Node.
// prepare-ios-simulator.ts imports Simctl directly, so mock the package itself.
jest.unstable_mockModule('node-simctl', () => ({
  Simctl: class {},
}));

// adb-manager and ios-manager wrap native CLI tools; mock them to keep the
// test portable across environments without ADB or simctl installed.
jest.unstable_mockModule('../../devicemanager/adb-manager', () => ({
  ADBManager: {getInstance: jest.fn()},
}));

jest.unstable_mockModule('../../devicemanager/ios-manager', () => ({
  IOSManager: {getInstance: jest.fn()},
}));

const authority = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../../utils/effort-authority.js', () => ({
  callEffortAuthority: authority,
  finishManagedOperation: jest.fn(),
}));
const {default: registerTools} = await import('../../tools/index.js');
const {setSession, detachSession} = await import('../../session-store.js');

// Update this list when a tool is added, removed, or renamed — that is the
// point of this test.
const EXPECTED_TOOL_NAMES = [
  // Session / Device
  'select_device',
  'appium_session_management',
  'appium_mobile_device_control',
  'appium_geolocation',
  'appium_mobile_device_info',
  'appium_mobile_file',
  'appium_driver_settings',
  // iOS Setup
  'prepare_ios_simulator',
  'cleanup_ios_simulator',
  'appium_prepare_ios_real_device',
  // Gestures
  'appium_gesture',
  'appium_drag_and_drop',
  'appium_perform_actions',
  // Element Interactions
  'appium_find_element',
  'appium_mobile_press_key',
  'appium_set_value',
  'appium_mobile_keyboard',
  'appium_get_text',
  'appium_get_element_attribute',
  'appium_mobile_clipboard',
  'appium_get_active_element',
  'appium_get_page_source',
  'appium_orientation',
  'appium_alert',
  'appium_screenshot',
  'appium_get_window_size',
  'appium_screen_recording',
  // App Management
  'appium_app_lifecycle',
  'appium_mobile_permissions',
  // Context
  'appium_context',
  // Test Generation
  'generate_locators',
  'appium_generate_tests',
  // appium_ai is intentionally absent — gated by AI_VISION_ENABLED env var
];

describe('registered MCP tool names', () => {
  test.each(['http://[::1]:4723', 'http://127.0.0.2:4723', 'http://[::ffff:127.0.0.1]:4723', 'http://[::ffff:7f00:2]:4723'])('tokenless setup and interaction reject local endpoint %s', async (remoteServerUrl) => {
    const definitions = new Map<string, any>();
    registerTools({addTool: (definition: any) => definitions.set(definition.name, definition)} as any);
    authority.mockReset();
    for (const action of ['create', 'attach']) {
      const result = await definitions.get('appium_session_management').execute({action, platform: 'android', remoteServerUrl, sessionId: 'foreign', capabilities: '{"platformName":"iOS","appium:isSimulator":false}'}, {});
      expect(result.structuredContent.status).toBe('denied');
      expect(result.isError).toBe(false);
    }
    const getPageSource = jest.fn();
    await setSession({getPageSource} as any, 'local-bypass-test', {platformName: 'iOS'}, 'attached', remoteServerUrl);
    try {
      const result = await definitions.get('appium_get_page_source').execute({sessionId: 'local-bypass-test'}, {});
      expect(result.structuredContent.status).toBe('denied');
      expect(getPageSource).not.toHaveBeenCalled();
      expect(authority).not.toHaveBeenCalled();
    } finally {
      detachSession('local-bypass-test');
    }
  });
  test('matches expected set', () => {
    const names: string[] = [];
    const mockServer = {
      addTool: ({name}: {name: string}) => {
        names.push(name);
      },
    };

    registerTools(mockServer as any);

    expect(names.sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  test('all session operations expose caller credentials and local setup rejects before mutation', async () => {
    const definitions = new Map<string, any>();
    registerTools({addTool: (definition: any) => definitions.set(definition.name, definition)} as any);
    for (const [name, definition] of definitions) {
      if (name === 'appium_prepare_ios_real_device') {
        continue;
      }
      const shape = definition.parameters.shape;
      expect(shape.effortToken).toBeDefined();
      expect(shape.operationId).toBeDefined();
      expect(shape.worktree).toBeDefined();
      expect(shape.sessionId).toBeDefined();
    }
    authority.mockReset();
    const prepare = await definitions.get('prepare_ios_simulator').execute({udid: 'assigned'}, {});
    expect(prepare.structuredContent.status).toBe('denied');
    const create = await definitions
      .get('appium_session_management')
      .execute({action: 'create', platform: 'ios', capabilities: '{"appium:udid":"assigned"}'}, {});
    expect(create.structuredContent.status).toBe('denied');
    expect(authority).not.toHaveBeenCalled();
    const busy = {
      ok: false,
      status: 'busy',
      resource: 'native',
      limit: 1,
      currentUsage: 1,
      retryAfterSeconds: 1200,
      message: 'Nothing started',
    };
    authority.mockResolvedValue(busy);
    const rejected = await definitions
      .get('prepare_ios_simulator')
      .execute({udid: 'assigned', effortToken: 'owner', operationId: 'prepare', worktree: process.cwd()}, {});
    expect(rejected.structuredContent).toEqual(busy);
    expect(authority).toHaveBeenCalledTimes(1);
  });
});
