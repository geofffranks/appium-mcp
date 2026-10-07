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

beforeEach(() => {
  update.mockReset().mockResolvedValue({ok: true, status: 'updated'});
  sessionInfo.mockReset();
  bind.mockClear();
});
afterEach(() => {
  jest.clearAllMocks();
});

const args = {effortToken: 'secret', worktree: process.cwd(), operationId: 'create-op', udid: 'assigned'};
const capabilities = {'appium:udid': 'assigned', 'appium:webDriverAgentUrl': 'http://127.0.0.1:8101'};

describe('managed embedded session lifetime', () => {
  test('records pending durable intent then promotes the real session ID without retargeting', async () => {
    const binding = await recordSessionIntent(args, capabilities);
    expect(update.mock.calls[0]).toEqual([
      'resource-add',
      {
        token: 'secret',
        operationId: 'create-op',
        kind: 'appiumSession',
        id: 'appium:create-op',
        owned: true,
        pending: true,
        lifetime: 'keepalive',
        udid: 'assigned',
        endpoint: 'http://127.0.0.1:12345',
      },
    ]);
    await recordCreatedSession('actual-session', binding);
    expect(bind).toHaveBeenCalledWith('actual-session', binding);
    expect(update.mock.calls[1][1]).toMatchObject({
      sessionId: 'actual-session',
      endpoint: 'http://127.0.0.1:12345',
      udid: 'assigned',
    });
  });
  test('rejects changed device or unprepared WDA before recording an intent', async () => {
    await expect(recordSessionIntent(args, {...capabilities, 'appium:udid': 'other'})).rejects.toThrow(
      'assigned simulator',
    );
    await expect(recordSessionIntent(args, {'appium:udid': 'assigned'})).rejects.toThrow('prepared WDA');
    expect(update).not.toHaveBeenCalled();
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
