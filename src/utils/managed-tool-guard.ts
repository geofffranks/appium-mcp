import {realpath} from 'node:fs/promises';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {networkInterfaces} from 'node:os';

import {callEffortAuthority, finishManagedOperation} from './effort-authority.js';
import type {EffortResponse} from './effort-authority.js';

export interface ManagedToolContext {
  effortToken?: string;
  worktree?: string;
  udid?: string;
  sessionId?: string;
  operationId?: string;
}

export interface AdmissionAdapter {
  begin(request: Record<string, unknown>): Promise<EffortResponse>;
  finish(token: string, operationId: string, outcome: 'complete' | 'uncertain'): Promise<EffortResponse>;
}

const authorityAdapter: AdmissionAdapter = {
  begin: (request) => callEffortAuthority('begin', request),
  finish: finishManagedOperation,
};

export interface ManagedToolOutcome<T> {
  admitted: boolean;
  result?: T;
  response?: EffortResponse;
  operationId?: string;
}

/** Admit before running a managed simulator operation and finish only after its result is known. */
export async function withManagedToolAdmission<T>(
  context: ManagedToolContext,
  operation: string,
  execute: () => Promise<T>,
  adapter: AdmissionAdapter = authorityAdapter,
): Promise<ManagedToolOutcome<T>> {
  if (!context.effortToken || !context.worktree || !context.udid || !context.operationId) {
    return {
      admitted: false,
      response: {
        ok: false,
        status: 'denied',
        message: 'Managed simulator calls require effortToken, canonical worktree, UDID, and stable operationId.',
      },
    };
  }
  const operationId = context.operationId;
  let admission: EffortResponse;
  try {
    admission = await adapter.begin({
      token: context.effortToken,
      worktree: await realpath(context.worktree),
      udid: context.udid,
      operation,
      operationId,
    });
  } catch (error) {
    const diagnostic = error instanceof Error && /^(Effort authority|APPIUM_MCP_EFFORT)/.test(error.message)
      ? ` ${error.message}` : '';
    return {
      admitted: false,
      response: {
        ok: false,
        status: 'recovery_required',
        message:
          `Effort authority could not confirm admission. Preserve the simulator and reconcile status before retrying.${diagnostic}`,
      },
    };
  }
  if (admission.status !== 'admitted') {
    return {admitted: false, response: admission};
  }

  let result: T | undefined;
  let outcome: 'complete' | 'uncertain' = 'uncertain';
  try {
    result = await execute();
    outcome = isVerifiedToolSuccess(result) ? 'complete' : 'uncertain';
  } catch {
    // A thrown tool may have started a side effect; never declare its lifetime closed.
  }
  try {
    const finished = await adapter.finish(context.effortToken, operationId, outcome);
    if (!finished.ok || outcome !== 'complete') {
      return {
        admitted: false,
        operationId,
        response: {
          ok: false,
          status: 'recovery_required',
          message: 'Managed operation or finalization is uncertain; preserve resources and reconcile before retrying.',
        },
      };
    }
  } catch {
    return {
      admitted: false,
      operationId,
      response: {
        ok: false,
        status: 'recovery_required',
        message: 'Managed operation finalization could not be confirmed; preserve resources and reconcile.',
      },
    };
  }
  return {admitted: true, result, operationId};
}

function isVerifiedToolSuccess(result: unknown): boolean {
  if (!result || typeof result !== 'object') {
    return false;
  }
  const value = result as {
    isError?: boolean;
    structuredContent?: {ok?: boolean};
    content?: Array<{type: string; text?: string}>;
  };
  if (value.structuredContent?.ok === false) {
    return false;
  }
  if (value.isError) {
    return false;
  }
  for (const block of value.content ?? []) {
    if (block.type !== 'text' || !block.text) {
      continue;
    }
    try {
      const parsed = JSON.parse(block.text) as {ready?: boolean; ok?: boolean};
      if (parsed.ready === false || parsed.ok === false) {
        return false;
      }
    } catch {
      /* Ordinary successful text is not a JSON envelope. */
    }
  }
  return true;
}

export function admissionResult(response: EffortResponse): {
  content: Array<{type: 'text'; text: string}>;
  isError: false;
  structuredContent: EffortResponse;
} {
  return {
    content: [{type: 'text', text: response.message ?? `Managed simulator operation ${response.status}.`}],
    isError: false,
    structuredContent: response,
  };
}

export function managedContextFromArgs(args: unknown): ManagedToolContext | null {
  if (!args || typeof args !== 'object') {
    return null;
  }
  const value = args as Record<string, unknown>;
  return {
    effortToken: stringValue(value.effortToken),
    worktree: stringValue(value.worktree),
    sessionId: stringValue(value.sessionId),
    udid: stringValue(value.udid),
    operationId: stringValue(value.operationId),
  };
}

function localAddress(address: string): boolean {
  let normalized = address.toLowerCase().replace(/^\[|\]$/g, '');
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normalized);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    normalized = `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
  }
  if (normalized === '::1' || normalized.startsWith('127.') || normalized.startsWith('::ffff:127.')) {return true;}
  return Object.values(networkInterfaces()).flat().some((entry) => entry?.address.toLowerCase() === normalized);
}

export async function isLocalAppiumEndpoint(endpoint: string): Promise<boolean> {
  try {
    const host = new URL(endpoint).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || localAddress(host)) {return true;}
    if (isIP(host)) {return false;}
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const addresses = await Promise.race([
        lookup(host, {all: true}),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 2000); }),
      ]);
      return addresses.length === 0 || addresses.some((entry) => localAddress(entry.address));
    } finally {
      if (timer) {clearTimeout(timer);}
    }
  } catch {
    // An unresolved endpoint cannot establish a remote exemption.
    return true;
  }
}

export function isLocalSimulatorSession(
  info: {
    metadata?: {platform?: string | null; capabilities?: Record<string, unknown>};
    remoteServerUrl?: string;
  } | null,
): boolean {
  if (!info) {return false;}
  if (info.remoteServerUrl) {
    try {
      const host = new URL(info.remoteServerUrl).hostname.toLowerCase().replace(/^\[|\]$/g, '');
      return host === 'localhost' || host.endsWith('.localhost') || localAddress(host) || !isIP(host);
    } catch { return true; }
  }
  const caps = info.metadata?.capabilities ?? {};
  return /ios|tvos/i.test(info.metadata?.platform ?? String(caps.platformName ?? '')) || /xcuitest/i.test(String(caps['appium:automationName'] ?? ''));
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
