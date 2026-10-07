import {mkdtemp, rm, writeFile, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, describe, expect, test} from '@jest/globals';

import {callEffortAuthority, siblingEffortExecutable} from '../../utils/effort-authority.js';

let directory: string;
let originalExecutable: string | undefined;
let originalArgsFile: string | undefined;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'appium-effort-authority-'));
  originalExecutable = process.env.APPIUM_MCP_EFFORT_CLI_PATH;
  originalArgsFile = process.env.EFFORT_TEST_ARGS_FILE;
  process.env.EFFORT_TEST_ARGS_FILE = join(directory, 'args.json');
});

afterEach(async () => {
  if (originalExecutable === undefined) {
    delete process.env.APPIUM_MCP_EFFORT_CLI_PATH;
  } else {
    process.env.APPIUM_MCP_EFFORT_CLI_PATH = originalExecutable;
  }
  if (originalArgsFile === undefined) {
    delete process.env.EFFORT_TEST_ARGS_FILE;
  } else {
    process.env.EFFORT_TEST_ARGS_FILE = originalArgsFile;
  }
  await rm(directory, {recursive: true, force: true});
});

async function createCli(contents: string): Promise<string> {
  const executable = join(directory, 'ios-app-dev-mcp');
  await writeFile(executable, `#!/usr/bin/env node\n${contents}\n`);
  await chmod(executable, 0o700);
  process.env.APPIUM_MCP_EFFORT_CLI_PATH = executable;
  return executable;
}

describe('effort authority CLI adapter', () => {
  test('repository fallback is relative to installed module, not caller cwd', () => {
    expect(siblingEffortExecutable('file:///workspace/appium-mcp/dist/utils/effort-authority.js'))
      .toBe('/workspace/ios-app-dev-mcp/bin/ios-app-dev-mcp');
    expect(siblingEffortExecutable('file:///workspace/appium-mcp/src/utils/effort-authority.ts'))
      .toBe('/workspace/ios-app-dev-mcp/bin/ios-app-dev-mcp');
  });
  test('sends one strict JSON request on stdin without placing token in argv or env', async () => {
    await createCli(`
      let input = '';
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', async () => {
        const {writeFileSync} = await import('node:fs');
        writeFileSync(process.env.EFFORT_TEST_ARGS_FILE, JSON.stringify({args: process.argv.slice(2), input}));
        process.stdout.write(JSON.stringify({ok: true, status: 'admitted'}));
      });
    `);

    const response = await callEffortAuthority('begin', {token: 'secret-token', operationId: 'op-1'});
    expect(response).toEqual({ok: true, status: 'admitted'});
    const invocation = JSON.parse(
      await (await import('node:fs/promises')).readFile(process.env.EFFORT_TEST_ARGS_FILE!, 'utf8'),
    );
    expect(invocation.args).toEqual(['effort', 'begin']);
    expect(JSON.parse(invocation.input)).toEqual({version: 1, token: 'secret-token', operationId: 'op-1'});
  });

  test('rejects invalid JSON and does not include child diagnostics or credentials in error', async () => {
    await createCli(`
      let input = '';
      process.stdin.on('data', chunk => input += chunk);
      process.stdin.on('end', () => {
        process.stderr.write(input);
        process.stdout.write('not-json');
      });
    `);

    await expect(callEffortAuthority('status', {token: 'must-not-leak'})).rejects.toThrow('returned invalid JSON');
    await expect(callEffortAuthority('status', {token: 'must-not-leak'})).rejects.not.toThrow('must-not-leak');
  });

  test('requires an absolute explicit executable path', async () => {
    process.env.APPIUM_MCP_EFFORT_CLI_PATH = './ios-app-dev-mcp';
    await expect(callEffortAuthority('status', {})).rejects.toThrow('must be an absolute executable path');
  });
});
