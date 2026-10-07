import {realpath} from 'node:fs/promises';

import {beforeEach, expect, jest, test} from '@jest/globals';
const authority = jest.fn<(...args: any[]) => Promise<any>>();
const execute = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../../../utils/effort-authority.js', () => ({
  callEffortAuthority: authority,
  finishManagedOperation: jest.fn(),
}));
jest.unstable_mockModule('teen_process', () => ({exec: execute}));
const {cleanupOwnedWda} = await import('../../../tools/ios/cleanup-ios-simulator.js');
const args = {effortToken: 'owner', worktree: process.cwd(), operationId: 'cleanup', udid: 'assigned'};
let record: any;
beforeEach(async () => {
  record = {
    worktree: await realpath(process.cwd()),
    udid: 'assigned',
    resources: [{kind: 'wda', id: 'wda:prepare', owned: true, udid: 'assigned', bundleId: 'com.example.wda'}],
  };
  authority
    .mockReset()
    .mockImplementation(async (command) =>
      command === 'status' ? {ok: true, status: 'owned', record} : {ok: true, status: 'removed'},
    );
  execute.mockReset().mockResolvedValue({stdout: ''});
});
test('stops only registered WDA and requires authority absence verification', async () => {
  const result = await cleanupOwnedWda(args);
  expect(result.isError).not.toBe(true);
  expect(execute).toHaveBeenCalledWith('xcrun', ['simctl', 'terminate', 'assigned', 'com.example.wda'], {
    timeout: 5000,
  });
  expect(authority).toHaveBeenCalledWith('resource-remove', {
    token: 'owner',
    operationId: 'cleanup',
    id: 'wda:prepare',
  });
});
test('preserves WDA while sessions remain or launch intent is uncertain', async () => {
  record.resources.push({kind: 'appiumSession'});
  expect((await cleanupOwnedWda(args)).structuredContent.ok).toBe(false);
  expect(execute).not.toHaveBeenCalled();
  record.resources = [{kind: 'wda', pending: true}];
  expect((await cleanupOwnedWda(args)).structuredContent.status).toBe('recovery_required');
  expect(execute).not.toHaveBeenCalled();
});
test('failed verification retains ownership as recovery required', async () => {
  authority.mockImplementation(async (command) =>
    command === 'status' ? {ok: true, record} : {ok: false, status: 'recovery_required'},
  );
  expect((await cleanupOwnedWda(args)).structuredContent.status).toBe('recovery_required');
});
