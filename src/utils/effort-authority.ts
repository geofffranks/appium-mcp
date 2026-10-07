import {execFile, spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 5000;

export type EffortCommand =
  | 'acquire'
  | 'status'
  | 'begin'
  | 'finish'
  | 'resource-add'
  | 'resource-remove'
  | 'resources'
  | 'reconcile'
  | 'release'
  | 'recover';

export interface EffortResponse {
  ok: boolean;
  status: string;
  message?: string;
  resource?: string;
  limit?: number;
  currentUsage?: number;
  retryAfterSeconds?: number;
  token?: string;
  record?: Record<string, any>;
  [key: string]: unknown;
}

/** Invoke the host's authority CLI with one JSON object on stdin. */
export async function callEffortAuthority(
  command: EffortCommand,
  request: Record<string, unknown>,
): Promise<EffortResponse> {
  const executable = await resolveEffortExecutable();
  const stdout = await invokeJsonCli(executable, command, {version: 1, ...request});
  try {
    const parsed: unknown = JSON.parse(stdout);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid response');
    }
    return parsed as EffortResponse;
  } catch {
    throw new Error(
      `Effort authority command '${command}' returned invalid JSON; preserve the simulator and reconcile before retrying.`,
    );
  }
}

function invokeJsonCli(executable: string, command: EffortCommand, request: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['effort', command], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
      env: {...process.env},
    });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => child.kill('SIGKILL'), COMMAND_TIMEOUT_MS);
    const fail = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(
          `Effort authority command '${command}' could not be completed; preserve the simulator and retry status/reconciliation.`,
        ),
      );
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
      }
    });
    child.once('error', fail);
    child.once('close', (code) => {
      if (code !== 0 || Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        return fail();
      }
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(stdout);
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

export function newOperationId(): string {
  return randomUUID();
}
export async function canonicalWorktree(): Promise<string> {
  return await realpath(process.cwd());
}

export async function managedEffortStatus(): Promise<EffortResponse> {
  return await callEffortAuthority('status', {});
}

export function managedLocalEffort(status: EffortResponse): boolean {
  return (
    status.ok === true &&
    status.status === 'owned' &&
    typeof status.record?.udid === 'string' &&
    status.record.udid.length > 0
  );
}

export async function beginManagedOperation(
  token: string,
  udid: string,
  operation: string,
  operationId = newOperationId(),
): Promise<{operationId: string; response: EffortResponse}> {
  const response = await callEffortAuthority('begin', {
    token,
    worktree: await canonicalWorktree(),
    udid,
    operation,
    operationId,
  });
  if (response.status !== 'admitted') {
    throw new Error(response.message ?? `Effort operation denied (${response.status}).`);
  }
  return {operationId, response};
}

export async function finishManagedOperation(
  token: string,
  operationId: string,
  outcome: 'complete' | 'uncertain',
): Promise<EffortResponse> {
  return await callEffortAuthority('finish', {token, operationId, outcome});
}

async function resolveEffortExecutable(): Promise<string> {
  const configured = process.env.APPIUM_MCP_EFFORT_CLI_PATH?.trim();
  if (configured) {
    if (!path.isAbsolute(configured)) {
      throw new Error('APPIUM_MCP_EFFORT_CLI_PATH must be an absolute executable path.');
    }
    return configured;
  }
  try {
    const {stdout} = await execFileAsync('which', ['ios-app-dev-mcp'], {
      encoding: 'utf8',
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 4096,
      windowsHide: true,
    });
    const executable = stdout.trim();
    if (executable) {
      return executable;
    }
  } catch {
    // The configured binary may be discoverable only through the explicit override.
  }
  throw new Error(
    'Effort authority executable was not found. Set APPIUM_MCP_EFFORT_CLI_PATH or add ios-app-dev-mcp to PATH.',
  );
}
