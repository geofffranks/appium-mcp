import {performance} from 'node:perf_hooks';

import {exec} from 'teen_process';

import {isSensitiveKey, redactUrlCredentials} from './sensitive.js';

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

/** Redact secrets and URL credentials, then retain only a bounded diagnostic tail. */
export function sanitizeDiagnostic(value: string): string {
  const withRedactedJson = redactEmbeddedJson(value);
  const withRedactedTextKeys = withRedactedJson.replace(
    /([\w.-]+)\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^,;\s}\]]+))/g,
    (match, key: string) => (isSensitiveKey(key) ? `${key}=[REDACTED]` : match),
  );
  return redactUrlCredentials(withRedactedTextKeys)
    .replace(/(?:\/Users\/|\/home\/)[^\s/:]+/g, '<user>')
    .slice(-WDA_LOG_TAIL_MAX_CHARS);
}

function redactEmbeddedJson(value: string): string {
  let output = '';
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (start < 0) {
      if (character === '{' || character === '[') {
        start = index;
        depth = 1;
      } else {
        output += character;
      }
      continue;
    }
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{' || character === '[') {
      depth++;
    } else if (character === '}' || character === ']') {
      depth--;
    }
    if (depth === 0) {
      const candidate = value.slice(start, index + 1);
      try {
        output += JSON.stringify(redactJsonValue(JSON.parse(candidate)));
      } catch {
        output += candidate;
      }
      start = -1;
    }
  }
  return output + (start < 0 ? '' : value.slice(start));
}

function redactJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactJsonValue);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, isSensitiveKey(key) ? '[REDACTED]' : redactJsonValue(nested)]),
    );
  }
  return typeof value === 'string' ? redactUrlCredentials(value) : value;
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
      {timeout: 5000, maxStdoutBufferSize: WDA_LOG_TAIL_MAX_CHARS},
    );
    const lines = stdout.split(/\r?\n/).filter(Boolean).slice(-WDA_LOG_TAIL_MAX_LINES);
    return sanitizeDiagnostic(lines.join('\n').slice(-WDA_LOG_TAIL_MAX_CHARS)) || 'No matching WDA log entries';
  } catch (error) {
    return `Unavailable: ${sanitizeDiagnostic(String(error))}`;
  }
}
