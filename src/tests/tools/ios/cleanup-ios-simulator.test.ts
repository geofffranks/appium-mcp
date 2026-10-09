import {beforeEach, expect, jest, test} from '@jest/globals';
const execute = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('teen_process', () => ({exec: execute}));
const {cleanupOwnedWda} = await import('../../../tools/ios/cleanup-ios-simulator.js');
beforeEach(() => { execute.mockReset().mockResolvedValue({stdout: ''}); });
test('stops WDA on the requested simulator without admission credentials', async () => {
  const result = await cleanupOwnedWda({udid: 'assigned'});
  expect(result.isError).not.toBe(true);
  expect(execute).toHaveBeenCalledWith('xcrun', ['simctl', 'terminate', 'assigned', 'com.facebook.WebDriverAgentRunner.xctrunner'], {
    timeout: 5000,
  });
});
