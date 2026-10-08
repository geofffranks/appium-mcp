import {realpath} from 'node:fs/promises';

import {afterEach, beforeEach, describe, expect, jest, test} from '@jest/globals';

const update = jest.fn<(...args: any[]) => Promise<any>>();
const sessionInfo = jest.fn<(...args: any[]) => any>();
const bind = jest.fn();
jest.unstable_mockModule('../../utils/effort-authority.js', () => ({callEffortAuthority: update}));
jest.unstable_mockModule('../../session-store.js', () => ({getSessionInfo: sessionInfo, bindManagedSession: bind}));
jest.unstable_mockModule('../../utils/session-inventory.js', () => ({
  startSessionInventory: async () => 'http://127.0.0.1:12345',
}));
const {recordSessionIntent, recordCreatedSession, verifySessionDeleteBinding, recordDeletedSession} =
  await import('../../utils/managed-session.js');

const assignedUdid = '1039344E-E738-402A-B78A-6C81E1293589';
const censusRunner = jest.fn(async (command: string, _args: string[]) => {
  if (command === 'lsof') {return {stdout: 'p84571\nn*:8101\n', stderr: 'IPv6 listener warning'} as any;}
  if (command === 'xcrun') {return {stdout: '84571 0 UIKitApplication:com.facebook.WebDriverAgentRunner.xctrunner[0721][rb-legacy]\n'} as any;}
  return {stdout: '84571 Wed Oct  7 22:44:51 2026 /Users/runner/Library/Developer/CoreSimulator/Devices/1039344E-E738-402A-B78A-6C81E1293589/data/Containers/Bundle/Application/ABC/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner\n'} as any;
}) as any;

beforeEach(() => {
  update.mockReset().mockImplementation(async (command) => command === 'resources'
    ? {ok: true, record: {resources: [{kind: 'wda', owned: true, udid: '1039344E-E738-402A-B78A-6C81E1293589', endpoint: 'http://127.0.0.1:8101'}]}}
    : {ok: true, status: 'updated'});
  jest.spyOn(globalThis, 'fetch').mockResolvedValue({ok: true, json: async () => ({value: {device: 'iPhone Simulator'}})} as Response);
  censusRunner.mockClear();
  sessionInfo.mockReset();
  bind.mockClear();
});
afterEach(() => {
  jest.clearAllMocks();
  jest.restoreAllMocks();
});

const args = {effortToken: 'secret', worktree: process.cwd(), operationId: 'create-op', udid: assignedUdid};
const capabilities = {'appium:udid': assignedUdid, 'appium:webDriverAgentUrl': 'http://127.0.0.1:8101'};

describe('managed embedded session lifetime', () => {
  test('records pending durable intent then promotes the real session ID without retargeting', async () => {
    const binding = await recordSessionIntent(args, capabilities, {run: censusRunner});
    expect(update.mock.calls[1]).toEqual([
      'resource-add',
      {
        token: 'secret',
        operationId: 'create-op',
        kind: 'appiumSession',
        id: 'appium:create-op',
        owned: true,
        pending: true,
        lifetime: 'keepalive',
        udid: assignedUdid,
        endpoint: 'http://127.0.0.1:12345',
      },
    ]);
    await recordCreatedSession('actual-session', binding);
    expect(bind).toHaveBeenCalledWith('actual-session', binding);
    expect(update.mock.calls[2][1]).toMatchObject({
      sessionId: 'actual-session',
      endpoint: 'http://127.0.0.1:12345',
      udid: assignedUdid,
    });
  });
  test('rejects changed device or unprepared WDA before recording an intent', async () => {
    await expect(recordSessionIntent(args, {...capabilities, 'appium:udid': 'other'}, {run: censusRunner})).rejects.toThrow(
      'assigned simulator',
    );
    await expect(recordSessionIntent(args, {'appium:udid': assignedUdid}, {run: censusRunner})).rejects.toThrow('prepared WDA');
    expect(update).not.toHaveBeenCalled();
  });
  test('rejects another device endpoint before creating any session intent', async () => {
    await expect(recordSessionIntent(args, {...capabilities, 'appium:webDriverAgentUrl': 'http://127.0.0.1:8102'})).rejects.toThrow('owned by this effort');
    expect(update).not.toHaveBeenCalledWith('resource-add', expect.anything());
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  test.each([
    'http://192.0.2.10:8101',
    'http://user:pass@127.0.0.1:8101',
    'https://127.0.0.1:8101',
    'http://localhost:8101',
    'http://[::1]:8101',
    'http://127.0.0.1:8101/status',
    'http://127.0.0.1:8101/..',
    'http://127.0.0.1:8101/',
    'http://127.0.0.1:8101?redirect=1',
    'http://127.0.0.1:8101#fragment',
  ])('rejects unsupported WDA endpoint %s before census or fetch', async (endpoint) => {
    await expect(recordSessionIntent(args, {...capabilities, 'appium:webDriverAgentUrl': endpoint}, {run: censusRunner})).rejects.toThrow('literal local HTTP endpoint');
    expect(censusRunner).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  test('rejects an authority-approved remote same-port endpoint before census or fetch', async () => {
    update.mockResolvedValueOnce({ok: true, record: {resources: [{
      kind: 'wda', owned: true, udid: assignedUdid, endpoint: 'http://192.0.2.10:8101',
    }]}});
    await expect(recordSessionIntent(args, {...capabilities, 'appium:webDriverAgentUrl': 'http://192.0.2.10:8101'}, {run: censusRunner})).rejects.toThrow('literal local HTTP endpoint');
    expect(censusRunner).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  test('rejects a registered endpoint whose current WDA identifies another device', async () => {
    jest.mocked(globalThis.fetch).mockResolvedValue({ok: true, json: async () => ({value: {device: {udid: 'other'}}})} as Response);
    await expect(recordSessionIntent(args, capabilities, {run: censusRunner})).rejects.toThrow('conflicts');
    expect(update).not.toHaveBeenCalledWith('resource-add', expect.anything());
  });
  test('deletion requires explicit session and owner binding and uses deletion operation for verified removal', async () => {
    const binding = {...args, worktree: await realpath(args.worktree), inventoryEndpoint: 'http://127.0.0.1:12345'};
    sessionInfo.mockReturnValue(binding);
    await expect(verifySessionDeleteBinding(undefined, args)).rejects.toThrow('explicit session');
    await expect(verifySessionDeleteBinding('actual-session', {...args, effortToken: 'foreign'})).rejects.toThrow(
      'owning effort',
    );
    const verified = await verifySessionDeleteBinding('actual-session', {...args, operationId: 'delete-op'});
    expect(verified).toEqual(binding);
    await recordDeletedSession(binding, 'delete-op');
    expect(update).toHaveBeenCalledWith('resource-remove', {
      token: 'secret',
      operationId: 'delete-op',
      id: 'appium:create-op',
    });
  });
  test('authority failure does not claim a successful resource transition or expose a credential', async () => {
    update.mockResolvedValue({ok: false, status: 'recovery_required', message: 'secret'});
    await expect(recordSessionIntent(args, capabilities)).rejects.toThrow('preserve ownership');
    await expect(recordSessionIntent(args, capabilities)).rejects.not.toThrow('secret');
  });
});
