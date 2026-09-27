import {describe, expect, jest, test} from '@jest/globals';

import {getWdaLogTail, sanitizeDiagnostic, waitForWdaReady} from '../../../utils/wda-readiness.js';

describe('waitForWdaReady', () => {
  test('reports ready when status succeeds', async () => {
    const result = await waitForWdaReady(8100, {
      fetch: jest.fn(async () => ({ok: true, status: 200}) as Response),
      now: () => 0,
      sleep: jest.fn(async () => {}),
    });

    expect(result).toEqual({ready: true, elapsedMs: 0, lastProbe: 'HTTP 200 OK'});
  });

  test('returns false at the deadline with the last HTTP probe', async () => {
    let now = 0;
    const fetch = jest.fn(async () => ({ok: false, status: 503}) as Response);
    const result = await waitForWdaReady(8100, {
      fetch,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    expect(result).toEqual({ready: false, elapsedMs: 30_000, lastProbe: 'HTTP 503 not ready'});
    expect(fetch).toHaveBeenCalledTimes(30);
  });

  test('records request errors as the last probe', async () => {
    let now = 0;
    const result = await waitForWdaReady(8100, {
      fetch: jest.fn(async () => {
        throw new Error('socket crashed');
      }),
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });

    expect(result.ready).toBe(false);
    expect(result.lastProbe).toContain('Request error: Error: socket crashed');
  });

  test('redacts nested JSON secrets and credentialed URLs, including objects inside arrays', () => {
    const diagnostic = sanitizeDiagnostic(
      'response={"message":"password=ordinary-text","items":[{"api_key":"nested-value"},"safe"],"url":"https://user:pass@example.test"}',
    );

    expect(diagnostic).toContain('"api_key":"[REDACTED]"');
    expect(diagnostic).not.toContain('nested-value');
    expect(diagnostic).not.toContain('user:pass');
    expect(diagnostic).toContain('"message":"password=ordinary-text"');
  });

  test('redacts secrets in escaped JSON fragments without changing surrounding text', () => {
    const diagnostic = sanitizeDiagnostic(
      'before {\\"apiKey\\":\\"escaped-secret\\"} between {"api_key":"plain-json-secret"} after',
    );

    expect(diagnostic).toBe('before {\\"apiKey\\":\\"[REDACTED]\\"} between {"api_key":"[REDACTED]"} after');
    expect(diagnostic).not.toContain('escaped-secret');
    expect(diagnostic).not.toContain('plain-json-secret');
  });

  test('bounds diagnostics after redaction', () => {
    expect(sanitizeDiagnostic('x'.repeat(5000)).length).toBeLessThanOrEqual(4000);
  });
});

describe('getWdaLogTail', () => {
  test('reports unavailable when simulator logs cannot be read', async () => {
    const run = jest.fn(async (..._args: any[]) => {
      throw new Error('log unavailable');
    }) as any;

    await expect(getWdaLogTail('sim-udid', run as any)).resolves.toContain('Unavailable: Error: log unavailable');
    expect(run).toHaveBeenCalledTimes(1);
  });

  test('returns only the bounded tail of simulator logs', async () => {
    const run = jest.fn(async () => ({stdout: Array.from({length: 50}, (_, index) => `line-${index}`).join('\n')}));

    const result = await getWdaLogTail('sim-udid', run as any);

    expect(result).not.toContain('line-0');
    expect(result).toContain('line-49');
    expect(result.length).toBeLessThanOrEqual(4000);
  });
});

describe('sanitizeDiagnostic', () => {
  test('redacts user paths and credential values and truncates output', () => {
    const sanitized = sanitizeDiagnostic(
      `failed authorization=Bearer credential ${'x'.repeat(5000)} /Users/alice/private`,
    );

    expect(sanitized).toContain('<user>');
    expect(sanitized).not.toContain('/Users/alice');
    expect(sanitized).not.toContain('credential');
    expect(sanitized.length).toBeLessThanOrEqual(4000);
  });
});
