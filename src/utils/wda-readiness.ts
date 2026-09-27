import {performance} from 'node:perf_hooks';

import {exec} from 'teen_process';

const WDA_READY_TIMEOUT_MS = 30_000;
const WDA_LOG_TAIL_MAX_CHARS = 4_000;
const WDA_LOG_TAIL_MAX_LINES = 40;

export interface WdaReadiness {
  ready: boolean;
  elapsedMs: number;
  lastProbe: string;
}

/** Poll WDA until ready or the bounded readiness budget expires. */
export async function waitForWdaReady(
  port: number,
  deps: {
    fetch: typeof fetch;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
  } = {
    fetch,
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<WdaReadiness> {
  const start = deps.now();
  let lastProbe = 'No probe completed';
  while (deps.now() - start < WDA_READY_TIMEOUT_MS) {
    const remainingMs = WDA_READY_TIMEOUT_MS - (deps.now() - start);
    try {
      const res = await deps.fetch(`http://127.0.0.1:${port}/status`, {
        signal: AbortSignal.timeout(Math.min(2000, remainingMs)),
      });
      lastProbe = `HTTP ${res.status}${res.ok ? ' OK' : ' not ready'}`;
      if (res.ok) {
        return {ready: true, elapsedMs: Math.round(deps.now() - start), lastProbe};
      }
    } catch (error) {
      lastProbe = `Request error: ${sanitizeDiagnostic(String(error))}`;
    }
    const timeLeftMs = WDA_READY_TIMEOUT_MS - (deps.now() - start);
    if (timeLeftMs > 0) {
      await deps.sleep(Math.min(1000, timeLeftMs));
    }
  }
  return {ready: false, elapsedMs: Math.round(deps.now() - start), lastProbe};
}

export function sanitizeDiagnostic(value: string): string {
  return value
    .replace(/(?:\/Users\/|\/home\/)[^\s/:]+/g, '<user>')
    .replace(/((?:authorization|token|password|secret)(?:[=:]|\s+)\s*)(?:Bearer\s+)?\S+/gi, '$1<redacted>')
    .slice(0, WDA_LOG_TAIL_MAX_CHARS);
}

export async function getWdaLogTail(udid: string, run: typeof exec = exec): Promise<string> {
  try {
    const {stdout} = await run(
      'xcrun',
      [
        'simctl',
        'spawn',
        udid,
        'log',
        'show',
        '--last',
        '2m',
        '--style',
        'compact',
        '--predicate',
        'process CONTAINS[c] "WebDriverAgent"',
      ],
      {timeout: 5000},
    );
    const lines = stdout.split(/\r?\n/).filter(Boolean).slice(-WDA_LOG_TAIL_MAX_LINES);
    return sanitizeDiagnostic(lines.join('\n').slice(-WDA_LOG_TAIL_MAX_CHARS)) || 'No matching WDA log entries';
  } catch (error) {
    return `Unavailable: ${sanitizeDiagnostic(String(error))}`;
  }
}
