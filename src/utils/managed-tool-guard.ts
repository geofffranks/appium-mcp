import {realpath} from 'node:fs/promises';

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
  } catch {
    return {
      admitted: false,
      response: {
        ok: false,
        status: 'recovery_required',
        message:
          'Effort authority could not confirm admission. Preserve the simulator and reconcile status before retrying.',
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

export function isLocalSimulatorSession(
  info: {
    metadata?: {platform?: string | null; capabilities?: Record<string, unknown>};
    remoteServerUrl?: string;
  } | null,
): boolean {
  if (!info || !/ios/i.test(info.metadata?.platform ?? '')) {
    return false;
  }
  const caps = info.metadata?.capabilities ?? {};
  const simulator = caps['appium:isSimulator'] ?? caps.isSimulator;
  if (simulator === true) {
    return true;
  }
  if (simulator === false) {
    return false;
  }
  const url = info.remoteServerUrl;
  if (!url) {
    return true;
  } // Embedded XCUITest session; treat unknown local iOS as managed.
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.endsWith('.localhost')) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}
