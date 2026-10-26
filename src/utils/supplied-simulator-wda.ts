import {access, cp, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import type {Dirent} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {plist} from '@appium/support';
import {exec, SubProcess} from 'teen_process';

import type {SimulatorWdaApp} from './simulator-wda-app.js';
import {sanitizeDiagnostic} from './wda-readiness.js';

export interface SuppliedWdaRunOptions {
  app: SimulatorWdaApp;
  udid: string;
  port: number;
}

export interface SuppliedWdaRunHandle {
  /** Resolves with bounded xcodebuild diagnostics if the runner exits. */
  failure: Promise<Error>;
  stop: () => Promise<void>;
}

/** Run a supplied simulator XCTest app with Xcode's XCTest runner lifecycle. */
export async function startSuppliedSimulatorWda({app, udid, port}: SuppliedWdaRunOptions): Promise<SuppliedWdaRunHandle> {
  const infoPath = path.join(app.path, 'Info.plist');
  const manifest = (await plist.parsePlistFile(infoPath)) as Record<string, unknown>;
  const executable = manifest.CFBundleExecutable;
  if (typeof executable !== 'string' || path.basename(executable) !== executable) {
    throw new Error(`The supplied WDA app '${app.path}' has an invalid CFBundleExecutable.`);
  }
  const binary = path.join(app.path, executable);
  await access(binary);
  await exec('lipo', ['-verify_arch', 'arm64', binary], {timeout: 5000});
  const appPlatform = manifest.DTPlatformName;
  if (typeof appPlatform !== 'string' || !['iphonesimulator', 'appletvsimulator'].includes(appPlatform.toLowerCase())) {
    throw new Error(`The supplied WDA app targets '${String(appPlatform)}', not a supported simulator platform.`);
  }
  const platformDirectory = appPlatform.toLowerCase() === 'appletvsimulator' ? 'AppleTVSimulator.platform' : 'iPhoneSimulator.platform';
  const {stdout: selectedDeveloperDir} = await exec('xcode-select', ['-p'], {timeout: 5000});
  const developerDir = process.env.DEVELOPER_DIR || selectedDeveloperDir.trim();
  const pluginDir = path.join(app.path, 'PlugIns');
  let bundles: Dirent<string>[];
  try {
    bundles = await readdir(pluginDir, {withFileTypes: true});
  } catch {
    throw new Error(`The supplied WDA app must contain exactly one PlugIns/*.xctest bundle; found 0.`);
  }
  bundles = bundles.filter((entry) => entry.isDirectory() && entry.name.endsWith('.xctest'));
  if (bundles.length !== 1) {
    throw new Error(`The supplied WDA app must contain exactly one PlugIns/*.xctest bundle; found ${bundles.length}.`);
  }
  const bundlePath = path.join(pluginDir, bundles[0].name);
  const testManifest = (await plist.parsePlistFile(path.join(bundlePath, 'Info.plist'))) as Record<string, unknown>;
  const testExecutable = testManifest.CFBundleExecutable;
  if (typeof testExecutable !== 'string' || path.basename(testExecutable) !== testExecutable) {
    throw new Error(`The supplied XCTest bundle '${bundlePath}' has an invalid CFBundleExecutable.`);
  }
  const testBinary = path.join(bundlePath, testExecutable);
  await access(testBinary);
  await exec('lipo', ['-verify_arch', 'arm64', testBinary], {timeout: 5000});

  const scratch = await mkdtemp(path.join(os.tmpdir(), 'appium-mcp-wda-'));
  const stagedAppPath = path.join(scratch, path.basename(app.path));
  await cp(app.path, stagedAppPath, {recursive: true});
  const stagedBundlePath = path.join(stagedAppPath, 'PlugIns', bundles[0].name);
  const runPath = path.join(scratch, 'supplied-wda.xctestrun');
  const testName = path.basename(bundlePath, '.xctest');
  const run = {
    __xctestrun_metadata__: {FormatVersion: 2},
    TestConfigurations: [{Name: 'WDA', TestTargets: [{
      BlueprintName: testName,
      TestBundlePath: stagedBundlePath,
      TestHostPath: stagedAppPath,
      TestHostBundleIdentifier: app.bundleId,
      IsUITestBundle: true,
      IsXCTRunnerHostedTestBundle: true,
      UseUITargetAppProvidedByTests: true,
      EnvironmentVariables: {USE_PORT: String(port)},
      TestingEnvironmentVariables: {
        USE_PORT: String(port),
        DYLD_FRAMEWORK_PATH: path.join(developerDir, 'Platforms', platformDirectory, 'Developer/Library/Frameworks'),
        DYLD_LIBRARY_PATH: path.join(developerDir, 'Platforms', platformDirectory, 'Developer/usr/lib'),
      },
      TestingEnabled: true,
      SkipTestIdentifiers: [],
    }]}],
  };
  await writeFile(runPath, plist.createPlist(run), 'utf8');
  const child = new SubProcess('xcodebuild', ['-xctestrun', runPath, '-destination', `id=${udid}`, 'test-without-building'], {
    env: {...process.env, USE_PORT: String(port)},
  });
  let output = '';
  const failure = new Promise<Error>((resolve) => {
    child.on('output', (stdout: string, stderr: string) => { output = `${output}${stdout || ''}${stderr || ''}`.slice(-8000); });
    child.once('exit', (code: number | null, signal: string | null) => {
      resolve(new Error(`Supplied WDA XCTest runner exited (code ${code}, signal ${signal}). ${sanitizeDiagnostic(output)}`));
    });
  });
  try {
    await child.start();
  } catch (error) {
    await rm(scratch, {recursive: true, force: true});
    throw error;
  }
  // Observe from immediately after spawn and keep the result available to the
  // managed WDA launch race, including exits that happen well after start.
  const joined = failure;
  return {
    failure,
    stop: async () => {
      try {
        if (child.isRunning) {
          await child.stop('SIGTERM');
        }
        await joined.catch(() => undefined);
      } finally {
        await rm(scratch, {recursive: true, force: true});
      }
    },
  };
}
