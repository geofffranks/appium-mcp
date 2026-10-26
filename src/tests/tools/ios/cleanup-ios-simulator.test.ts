import {expect, test} from '@jest/globals';

import {cleanupOwnedWda} from '../../../tools/ios/cleanup-ios-simulator.js';

test('does not signal a runner when this server has no owned lifecycle handle', async () => {
  const result = await cleanupOwnedWda({udid: 'unowned-simulator'});
  expect(result.isError).not.toBe(true);
  expect(JSON.stringify(result)).toContain('no process was signaled');
});
