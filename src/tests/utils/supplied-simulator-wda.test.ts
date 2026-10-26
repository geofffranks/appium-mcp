import {EventEmitter} from 'node:events';
import {afterEach, describe, expect, jest, test} from '@jest/globals';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mockExec = jest.fn(async (_command?: string, _args?: string[], _options?: {timeout?: number}) => ({stdout: '/Applications/Selected-Xcode.app/Contents/Developer'}));
const mockStart = jest.fn(async () => {});
const mockStop = jest.fn(async (_signal?: string) => {});
let mockChild: EventEmitter & {isRunning: boolean};
jest.unstable_mockModule('teen_process', () => ({
  exec: mockExec,
  SubProcess: class extends EventEmitter {
    args: string[];
    isRunning = true;
    constructor(_command: string, args: string[], options: {env: NodeJS.ProcessEnv}) {
      super();
      this.args = args;
      mockChild = {emit: (...args: Parameters<EventEmitter['emit']>) => {
        if (args[0] === 'exit') { this.isRunning = false; }
        return this.emit(...args);
      }, removeAllListeners: () => this.removeAllListeners()} as unknown as EventEmitter & {isRunning: boolean};
      mockStart.mockImplementation(async () => {
        const runPath = args[1];
        const content = await readFile(runPath, 'utf8');
        mockProcessData = {args, env: options.env, content};
      });
    }
    start = mockStart;
    stop = mockStop;
  },
}));
let mockProcessData: {args: string[]; env: NodeJS.ProcessEnv; content: string} | undefined;
const {startSuppliedSimulatorWda} = await import('../../utils/supplied-simulator-wda.js');

let scratch: string;
let appPath: string;
const oldPort = process.env.USE_PORT;

afterEach(async () => {
  await rm(scratch, {recursive: true, force: true});
  delete process.env.USE_PORT;
  if (oldPort !== undefined) {
    process.env.USE_PORT = oldPort;
  }
  mockProcessData = undefined;
  mockExec.mockClear();
  mockStart.mockClear();
  mockStop.mockClear();
  mockChild?.removeAllListeners();
});

describe('supplied simulator WDA XCTest runner', () => {
  test('generates an xctestrun using selected non-default Xcode for a tvOS runner', async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'supplied-wda-test-'));
    appPath = path.join(scratch, 'Runner.app');
    const testPath = path.join(appPath, 'PlugIns', 'Runner.xctest');
    await mkdir(testPath, {recursive: true});
    await writeFile(path.join(appPath, 'Info.plist'), 'app');
    await writeFile(path.join(appPath, 'Runner'), 'binary');
    await writeFile(path.join(testPath, 'Info.plist'), 'test');
    await writeFile(path.join(testPath, 'RunnerTests'), 'binary');
    const parsePlist = jest.spyOn((await import('@appium/support')).plist, 'parsePlistFile')
      .mockImplementation(async (filePath: string) => filePath.includes('.xctest') ? {CFBundleExecutable: 'RunnerTests'} : {CFBundleExecutable: 'Runner', DTPlatformName: 'AppleTVSimulator'} as any);
    try {
      const runner = await startSuppliedSimulatorWda({app: {path: appPath, bundleId: 'com.facebook.WebDriverAgentRunner'}, udid: 'selected-udid', port: 8123});
      expect(mockProcessData?.args).toEqual(['-xctestrun', expect.any(String), '-destination', 'id=selected-udid', 'test-without-building']);
      const runPath = mockProcessData!.args[1];
      parsePlist.mockRestore();
      const generated = JSON.parse(await readFile(runPath, 'utf8')) as any;
      const target = generated.TestConfigurations[0].TestTargets[0];
      expect(generated.__xctestrun_metadata__.FormatVersion).toBe(2);
      expect(target.BlueprintName).toBe('Runner');
      expect(target.TestHostPath).toMatch(/appium-mcp-wda-.*Runner\.app$/);
      expect(target.TestHostPath).not.toBe(appPath);
      expect(await readFile(path.join(target.TestHostPath, 'Runner'), 'utf8')).toBe('binary');
      expect(target.TestBundlePath).toBe(path.join(target.TestHostPath, 'PlugIns', 'Runner.xctest'));
      expect(target.TestHostBundleIdentifier).toBe('com.facebook.WebDriverAgentRunner');
      expect(target.IsXCTRunnerHostedTestBundle).toBe(true);
      expect(target.UseUITargetAppProvidedByTests).toBe(true);
      expect(target.TestingEnvironmentVariables.USE_PORT).toBe('8123');
      expect(target.TestingEnvironmentVariables.DYLD_FRAMEWORK_PATH).toBe('/Applications/Selected-Xcode.app/Contents/Developer/Platforms/AppleTVSimulator.platform/Developer/Library/Frameworks');
      expect(target.TestingEnvironmentVariables.DYLD_LIBRARY_PATH).toBe('/Applications/Selected-Xcode.app/Contents/Developer/Platforms/AppleTVSimulator.platform/Developer/usr/lib');
      expect(mockExec).toHaveBeenCalledWith('xcode-select', ['-p'], {timeout: 5000});
      expect(mockProcessData?.env.USE_PORT).toBe('8123');
      expect(runner).toHaveProperty('failure');
      mockChild.emit('output', 'runner-start-error', 'dyld: Library missing');
      mockChild.isRunning = false;
      mockChild.emit('exit', 1, null);
      await expect(runner.failure).resolves.toThrow(/code 1[\s\S]*runner-start-error[\s\S]*Library missing/);
      await runner.stop();
      expect(mockStop).not.toHaveBeenCalled();
    } finally {
      parsePlist.mockRestore();
    }
  });

  test('rejects a missing XCTest plugin before starting xcodebuild', async () => {
    scratch = await mkdtemp(path.join(os.tmpdir(), 'supplied-wda-test-'));
    appPath = path.join(scratch, 'Runner.app');
    await mkdir(appPath);
    await writeFile(path.join(appPath, 'Runner'), 'binary');
    const parsePlist = jest.spyOn((await import('@appium/support')).plist, 'parsePlistFile')
      .mockResolvedValue({CFBundleExecutable: 'Runner', DTPlatformName: 'iPhoneSimulator'} as any);
    try {
      await expect(startSuppliedSimulatorWda({app: {path: appPath, bundleId: 'com.facebook.WebDriverAgentRunner'}, udid: 'selected-udid', port: 8123})).rejects.toThrow(/PlugIns\/\*\.xctest/);
      expect(mockStart).not.toHaveBeenCalled();
    } finally {
      parsePlist.mockRestore();
    }
  });
});
