import {describe, expect, jest, test} from '@jest/globals';

import {
  captureWdaCensus,
  parseLaunchctlWdaPid,
  parseLsofListenerPid,
  parseWdaProcess,
  parseWdaStatusDevice,
  sameWdaCensus,
} from '../../utils/wda-binding.js';

const udid = '1039344E-E738-402A-B78A-6C81E1293589';
const executable = `/Users/runner/Library/Developer/CoreSimulator/Devices/${udid}/data/Containers/Bundle/Application/ABC/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner`;
const processLine = `84571 Wed Oct  7 22:44:51 2026 ${executable}\n`;

describe('WDA process binding', () => {
  test('parses observed listener, launchctl and process evidence', async () => {
    const run = jest.fn(async (command: string) => {
      if (command === 'lsof') {return {stdout: 'p84571\n', stderr: 'lsof: IPv6 warning'} as any;}
      if (command === 'xcrun') {return {stdout: '84571 0 UIKitApplication:com.facebook.WebDriverAgentRunner.xctrunner[0721][rb-legacy]\n'} as any;}
      return {stdout: processLine} as any;
    }) as any;
    const census = await captureWdaCensus(udid, 52120, run);
    expect(census).toMatchObject({listenerPid: 84571, launchctlPid: 84571, process: {pid: 84571, birth: 'Wed Oct  7 22:44:51 2026', executable}});
    expect(run).toHaveBeenCalledTimes(3);
  });

  test.each([
    ['', 52120],
    ['p1\np2\n', 52120],
    ['p84571\np84571\n', 52120],
  ])('fails closed on malformed or ambiguous lsof output', (output, port) => {
    expect(() => parseLsofListenerPid(output, port)).toThrow('ambiguous');
  });

  test('fails closed on malformed and multiple WDA process records', () => {
    expect(() => parseLaunchctlWdaPid('no WDA process')).toThrow('ambiguous');
    expect(() => parseLaunchctlWdaPid('84571 0 UIKitApplication:com.facebook.WebDriverAgentRunner.xctrunner[1]\n84572 0 UIKitApplication:com.facebook.WebDriverAgentRunner.xctrunner[2]')).toThrow('ambiguous');
    expect(() => parseWdaProcess('bad row', 84571, udid)).toThrow('malformed');
  });

  test('rejects wrong-device executable, reused PID identity, and non-WDA executable', () => {
    expect(() => parseWdaProcess(processLine.replace(udid, '00000000-0000-0000-0000-000000000000'), 84571, udid)).toThrow('bind');
    expect(() => parseWdaProcess(processLine, 84572, udid)).toThrow('bind');
    expect(() => parseWdaProcess(processLine.replace('WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner', 'Other.app/Other'), 84571, udid)).toThrow('bind');
  });

  test('allows missing status UDID but rejects explicit conflicts and malformed status', () => {
    expect(() => parseWdaStatusDevice({value: {device: 'iPhone Simulator'}}, udid)).not.toThrow();
    expect(() => parseWdaStatusDevice({value: {device: {udid}}}, udid)).not.toThrow();
    expect(() => parseWdaStatusDevice({value: {device: {udid: 'other'}}}, udid)).toThrow('conflicts');
    expect(() => parseWdaStatusDevice({value: {device: null}}, udid)).toThrow('malformed');
  });

  test('compares process birth and executable as well as PIDs', () => {
    const left = {listenerPid: 1, launchctlPid: 1, process: {pid: 1, birth: 'born', executable: '/a'}};
    expect(sameWdaCensus(left, structuredClone(left))).toBe(true);
    expect(sameWdaCensus(left, {...left, process: {...left.process, birth: 'reused'}})).toBe(false);
  });
});
