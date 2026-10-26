import {access, readdir} from 'node:fs/promises';
import path from 'node:path';

import {plist} from '@appium/support';
import {exec} from 'teen_process';

export interface SimulatorWdaApp {
  path: string;
  bundleId: string;
}

/** Validate a supplied simulator WDA app and its XCTest bundle. */
export async function validateSimulatorWdaApp(appPath: string): Promise<SimulatorWdaApp> {
  const resolvedPath = path.resolve(appPath);
  if (!resolvedPath.endsWith('.app')) {
    throw new Error(`The supplied WDA artifact '${appPath}' is not an .app bundle.`);
  }
  const infoPlist = path.join(resolvedPath, 'Info.plist');
  let manifest: Record<string, unknown>;
  try {
    manifest = (await plist.parsePlistFile(infoPlist)) as Record<string, unknown>;
  } catch {
    throw new Error(`The supplied WDA app '${appPath}' has no readable Info.plist.`);
  }
  const bundleId = manifest.CFBundleIdentifier;
  const executableName = manifest.CFBundleExecutable;
  if (typeof bundleId !== 'string' || !bundleId.includes('WebDriverAgentRunner') || typeof executableName !== 'string' || path.basename(executableName) !== executableName) {
    throw new Error(`The supplied app '${appPath}' is not an identifiable WebDriverAgentRunner bundle.`);
  }
  const appPlatform = manifest.DTPlatformName;
  if (typeof appPlatform === 'string' && !['iphonesimulator', 'appletvsimulator'].includes(appPlatform.toLowerCase())) {
    throw new Error(`The supplied WDA app targets '${appPlatform}', not a simulator platform.`);
  }
  const executablePath = path.join(resolvedPath, executableName);
  await access(executablePath);
  await exec('lipo', ['-verify_arch', 'arm64', executablePath], {timeout: 5000});
  await validateSimulatorMachO(executablePath);
  const pluginPath = path.join(resolvedPath, 'PlugIns');
  const tests = (await readdir(pluginPath, {withFileTypes: true})).filter((entry) => entry.isDirectory() && entry.name.endsWith('.xctest'));
  if (tests.length !== 1) {
    throw new Error(`The supplied WDA app must contain exactly one PlugIns/*.xctest bundle; found ${tests.length}.`);
  }
  const testPath = path.join(pluginPath, tests[0].name);
  const testManifest = (await plist.parsePlistFile(path.join(testPath, 'Info.plist'))) as Record<string, unknown>;
  const testExecutable = testManifest.CFBundleExecutable;
  if (typeof testExecutable !== 'string' || path.basename(testExecutable) !== testExecutable) {
    throw new Error(`The supplied XCTest bundle '${testPath}' has an invalid CFBundleExecutable.`);
  }
  const testBinary = path.join(testPath, testExecutable);
  await access(testBinary);
  await exec('lipo', ['-verify_arch', 'arm64', testBinary], {timeout: 5000});
  await validateSimulatorMachO(testBinary);
  return {path: resolvedPath, bundleId};
}

async function validateSimulatorMachO(binary: string): Promise<void> {
  const {stdout} = await exec('otool', ['-l', binary], {timeout: 5000});
  const platforms = [...stdout.matchAll(/\bplatform\s+(\d+)/g)].map((match) => Number(match[1]));
  if (platforms.length && platforms.some((platform) => ![7, 8].includes(platform))) {
    throw new Error(`The supplied WDA executable '${binary}' contains a non-simulator Mach-O platform slice.`);
  }
}
