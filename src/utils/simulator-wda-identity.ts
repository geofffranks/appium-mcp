import {createHash} from 'node:crypto';
import {readFile, readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {plist} from '@appium/support';
import {exec} from 'teen_process';

import type {SimulatorWdaApp} from './simulator-wda-app.js';

const MAX_HASHED_FILE_BYTES = 128 * 1024 * 1024;
const MAX_SOURCE_FILES = 128;

async function hashFiles(paths: string[]): Promise<string> {
  const hash = createHash('sha256');
  for (const filePath of paths.sort()) {
    const content = await readFile(filePath);
    if (content.byteLength > MAX_HASHED_FILE_BYTES) {
      throw new Error(`WDA identity input exceeds the ${MAX_HASHED_FILE_BYTES}-byte limit: ${path.basename(filePath)}`);
    }
    hash.update(path.basename(filePath)).update('\0').update(content).update('\0');
  }
  return hash.digest('hex');
}

async function listRelevantPackageFiles(packageRoot: string): Promise<string[]> {
  const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8')) as {version?: string};
  const paths = [path.join(packageRoot, 'package.json')];
  for (const directory of ['build', 'lib', 'WebDriverAgent']) {
    const root = path.join(packageRoot, directory);
    const pending = [root];
    while (pending.length && paths.length < MAX_SOURCE_FILES) {
      const current = pending.pop();
      if (!current) {
        break;
      }
      try {
        const entries = await readdir(current, {withFileTypes: true});
        for (const entry of entries) {
          const entryPath = path.join(current, entry.name);
          if (entry.isDirectory()) {
            pending.push(entryPath);
          } else if (entry.isFile() && /\.(?:js|cjs|mjs|json|swift|xctest)$/.test(entry.name)) {
            paths.push(entryPath);
            if (paths.length >= MAX_SOURCE_FILES) {
              break;
            }
          }
        }
      } catch {
        // Not all package versions ship every source directory.
      }
    }
  }
  const digest = await hashFiles(paths);
  return [`appium-webdriveragent@${packageJson.version ?? 'unknown'}:${digest}`];
}

async function bundledWdaFingerprint(): Promise<string> {
  let directory = path.dirname(new URL(import.meta.resolve('appium-webdriveragent')).pathname);
  while (directory !== path.dirname(directory)) {
    try {
      await readFile(path.join(directory, 'package.json'));
      break;
    } catch {
      directory = path.dirname(directory);
    }
  }
  return (await listRelevantPackageFiles(directory))[0];
}

async function suppliedWdaFingerprint(app: SimulatorWdaApp): Promise<string> {
  const infoPath = path.join(app.path, 'Info.plist');
  const appManifest = (await plist.parsePlistFile(infoPath)) as Record<string, unknown>;
  const files = [infoPath];
  const appManifestJson = appManifest;
  const executable = appManifestJson.CFBundleExecutable;
  if (typeof executable !== 'string' || path.basename(executable) !== executable) {
    throw new Error('Supplied WDA app has an invalid executable while computing its content identity.');
  }
  files.push(path.join(app.path, executable));
  const plugins = path.join(app.path, 'PlugIns');
  const testDirs = (await readdir(plugins, {withFileTypes: true})).filter((entry) => entry.isDirectory() && entry.name.endsWith('.xctest'));
  if (testDirs.length !== 1) {
    throw new Error(`The supplied WDA app must contain exactly one PlugIns/*.xctest bundle; found ${testDirs.length}.`);
  }
  const testDir = path.join(plugins, testDirs[0].name);
  const testInfoPath = path.join(testDir, 'Info.plist');
  const testManifest = (await plist.parsePlistFile(testInfoPath)) as Record<string, unknown>;
  const testExecutable = testManifest.CFBundleExecutable;
  if (typeof testExecutable !== 'string' || path.basename(testExecutable) !== testExecutable) {
    throw new Error('Supplied WDA XCTest bundle has an invalid executable while computing its content identity.');
  }
  files.push(testInfoPath, path.join(testDir, testExecutable));
  const contentHash = await hashFiles(files);
  return createHash('sha256').update(JSON.stringify([app.path, app.bundleId, appManifest, contentHash])).digest('hex');
}

export async function createSimulatorWdaArtifactIdentity(options: {
  platform: 'ios' | 'tvos';
  runtime: string;
  suppliedApp?: SimulatorWdaApp;
}): Promise<{artifact: string; toolchain: string}> {
  const [{stdout: xcodePath}, {stdout: xcodeVersion}, {stdout: architecture}] = await Promise.all([
    exec('xcode-select', ['-p'], {timeout: 5000}),
    exec('xcodebuild', ['-version'], {timeout: 5000}),
    exec('uname', ['-m'], {timeout: 5000}),
  ]);
  const version = xcodeVersion.match(/Xcode\s+([\d.]+).*?Build version\s+(\S+)/s);
  if (!version) {
    throw new Error('Could not determine the selected Xcode version and build number.');
  }
  const artifact = options.suppliedApp
    ? `supplied:${options.suppliedApp.bundleId}:${await suppliedWdaFingerprint(options.suppliedApp)}`
    : await bundledWdaFingerprint();
  return {
    artifact: `${artifact}:${options.platform}:${options.runtime}:${os.arch()}:${architecture.trim()}`,
    toolchain: `${path.resolve(xcodePath.trim())}:Xcode ${version[1]} (${version[2]})`,
  };
}
