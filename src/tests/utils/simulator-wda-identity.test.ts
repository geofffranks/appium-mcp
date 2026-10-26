import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {plist} from '@appium/support';
import {afterEach, describe, expect, jest, test} from '@jest/globals';

jest.unstable_mockModule('teen_process', () => ({exec: async (command: string) => ({stdout: command === 'xcode-select' ? '/Applications/Xcode.app/Contents/Developer\n' : command === 'uname' ? 'arm64\n' : 'Xcode 26.2\nBuild version 17C123'})}));
const {createSimulatorWdaArtifactIdentity} = await import('../../utils/simulator-wda-identity.js');
jest.spyOn(plist, 'parsePlistFile').mockImplementation(async (filePath?: string) => {
  if (!filePath) {
    throw new Error('Expected a plist path');
  }
  return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
});

let scratch: string | undefined;
afterEach(async () => {
  if (scratch) {
    await rm(scratch, {recursive: true, force: true});
  }
  scratch = undefined;
});

async function makeApp(binaryContent: string): Promise<{path: string; bundleId: string}> {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'wda-identity-'));
  const appPath = path.join(scratch, 'WebDriverAgentRunner-Runner.app');
  const testPath = path.join(appPath, 'PlugIns', 'WebDriverAgentRunner.xctest');
  await mkdir(testPath, {recursive: true});
  await writeFile(path.join(appPath, 'Info.plist'), plist.createPlist({CFBundleIdentifier: 'com.example.WebDriverAgentRunner', CFBundleExecutable: 'Runner'}));
  await writeFile(path.join(appPath, 'Runner'), 'runner-binary');
  await writeFile(path.join(testPath, 'Info.plist'), plist.createPlist({CFBundleExecutable: 'Tests'}));
  await writeFile(path.join(testPath, 'Tests'), binaryContent);
  return {path: appPath, bundleId: 'com.example.WebDriverAgentRunner'};
}

describe('simulator WDA artifact identity', () => {
  test('is stable for unchanged supplied content and changes when XCTest binary content is repaired', async () => {
    const app = await makeApp('before');
    const unchanged = await createSimulatorWdaArtifactIdentity({platform: 'ios', runtime: '26.5', suppliedApp: app});
    const same = await createSimulatorWdaArtifactIdentity({platform: 'ios', runtime: '26.5', suppliedApp: app});
    expect(same).toEqual(unchanged);
    await writeFile(path.join(app.path, 'PlugIns', 'WebDriverAgentRunner.xctest', 'Tests'), 'repaired');
    const repaired = await createSimulatorWdaArtifactIdentity({platform: 'ios', runtime: '26.5', suppliedApp: app});
    expect(repaired.artifact).not.toBe(unchanged.artifact);
    expect(repaired.toolchain).toBe(unchanged.toolchain);
  });

  test('bundle label cannot disguise changed bytes; platform and runtime are identity inputs', async () => {
    const first = await makeApp('first');
    const firstId = await createSimulatorWdaArtifactIdentity({platform: 'ios', runtime: '26.5', suppliedApp: first});
    await writeFile(path.join(first.path, 'PlugIns', 'WebDriverAgentRunner.xctest', 'Tests'), 'second');
    const changed = await createSimulatorWdaArtifactIdentity({platform: 'ios', runtime: '26.5', suppliedApp: first});
    const otherRuntime = await createSimulatorWdaArtifactIdentity({platform: 'ios', runtime: '26.6', suppliedApp: first});
    const otherPlatform = await createSimulatorWdaArtifactIdentity({platform: 'tvos', runtime: '26.5', suppliedApp: first});
    expect(changed.artifact).not.toBe(firstId.artifact);
    expect(otherRuntime.artifact).not.toBe(changed.artifact);
    expect(otherPlatform.artifact).not.toBe(changed.artifact);
  });
});
