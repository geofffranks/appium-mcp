import {describe, expect, test} from '@jest/globals';

import {
  admissionResult,
  isLocalSimulatorSession,
  isLocalAppiumEndpoint,
  withManagedToolAdmission,
  type AdmissionAdapter,
} from '../../utils/managed-tool-guard.js';

const context = {
  effortToken: 'opaque',
  worktree: process.cwd(),
  udid: 'sim-1',
  sessionId: 'session-1',
  operationId: 'stable-op',
};
const finish = async () => ({ok: true, status: 'complete'});

describe('managed tool guard', () => {
  test.each(['http://[::1]:4723', 'http://127.0.0.2:4723', 'http://localhost:4723', 'http://[::ffff:127.0.0.1]:4723', 'http://[::ffff:7f00:2]:4723'])('local endpoint %s cannot use misleading platform hints', async (remoteServerUrl) => {
    expect(await isLocalAppiumEndpoint(remoteServerUrl)).toBe(true);
    expect(isLocalSimulatorSession({remoteServerUrl, metadata: {platform: 'android', capabilities: {'appium:isSimulator': false}}})).toBe(true);
  });
  test('requires credential and explicit target before authority or execution', async () => {
    let began = false;
    let ran = false;
    const adapter: AdmissionAdapter = {
      begin: async () => {
        began = true;
        return {ok: true, status: 'admitted'};
      },
      finish,
    };
    const result = await withManagedToolAdmission(
      {...context, effortToken: undefined},
      'appium',
      async () => {
        ran = true;
      },
      adapter,
    );
    expect(result.response?.status).toBe('denied');
    expect(began).toBe(false);
    expect(ran).toBe(false);
  });

  test('does not execute on worktree mismatch', async () => {
    let ran = false;
    const adapter: AdmissionAdapter = {
      begin: async (request) =>
        request.worktree === process.cwd()
          ? {ok: false, status: 'denied', message: 'worktree mismatch'}
          : {ok: true, status: 'admitted'},
      finish,
    };
    const result = await withManagedToolAdmission(
      context,
      'appium',
      async () => {
        ran = true;
      },
      adapter,
    );
    expect(result.response?.status).toBe('denied');
    expect(ran).toBe(false);
  });

  test('preserves structured busy details and does not execute', async () => {
    const busy = {
      ok: false,
      status: 'busy',
      resource: 'Mac effort',
      limit: 1,
      currentUsage: 1,
      retryAfterSeconds: 1200,
      message: 'Nothing started',
    };
    let ran = false;
    const adapter: AdmissionAdapter = {begin: async () => busy, finish};
    const result = await withManagedToolAdmission(
      context,
      'device',
      async () => {
        ran = true;
      },
      adapter,
    );
    expect(result.response).toEqual(busy);
    expect(admissionResult(result.response!).structuredContent).toEqual(busy);
    expect(ran).toBe(false);
  });

  test('exposes bounded redacted preparation diagnostics while requiring recovery', async () => {
    const adapter: AdmissionAdapter = {begin: async () => ({ok: true, status: 'admitted'}), finish};
    const detail = `Request failed token=super-secret at https://user:password@example.test/path ${'x'.repeat(2000)}`;
    const result = await withManagedToolAdmission(
      context,
      'device',
      async () => ({content: [{type: 'text', text: JSON.stringify({ready: false, wda_install: {status: 'failed', detail}})}]}),
      adapter,
    );

    expect(result.admitted).toBe(false);
    expect(result.response?.status).toBe('recovery_required');
    expect(result.response?.diagnostic).toContain('wda_install: Request failed');
    expect(result.response?.diagnostic).toContain('token=[REDACTED]');
    expect(result.response?.diagnostic).toContain('https://[REDACTED]@example.test/path');
    expect(result.response?.diagnostic).not.toContain('super-secret');
    expect(result.response?.diagnostic).not.toContain('password');
    const diagnostic = result.response?.diagnostic;
    if (typeof diagnostic !== 'string') {throw new Error('Expected a recovery diagnostic');}
    expect(diagnostic.length).toBeLessThanOrEqual(1000);
    expect(result.response?.message).toContain('preserve resources and reconcile');
  });

  test('exposes sanitized thrown diagnostics without completing an uncertain operation', async () => {
    const adapter: AdmissionAdapter = {begin: async () => ({ok: true, status: 'admitted'}), finish};
    const result = await withManagedToolAdmission(context, 'device', async () => {
      throw new Error('WDA launch failed api_key=super-secret');
    }, adapter);

    expect(result.admitted).toBe(false);
    expect(result.response?.status).toBe('recovery_required');
    expect(result.response?.diagnostic).toBe('WDA launch failed api_key=[REDACTED]');
    expect(result.response?.diagnostic).not.toContain('super-secret');
  });

  test('authority uncertainty fails closed and classifies iOS local/remote sessions', async () => {
    const adapter: AdmissionAdapter = {
      begin: async () => {
        throw new Error('offline');
      },
      finish,
    };
    const result = await withManagedToolAdmission(context, 'device', async () => 'ran', adapter);
    expect(result.response?.status).toBe('recovery_required');
    expect(isLocalSimulatorSession({metadata: {platform: 'iOS', capabilities: {'appium:isSimulator': true}}})).toBe(
      true,
    );
    expect(
      isLocalSimulatorSession({
        metadata: {platform: 'iOS', capabilities: {}},
        remoteServerUrl: 'http://127.0.0.1:4723',
      }),
    ).toBe(true);
    expect(
      isLocalSimulatorSession({
        metadata: {platform: 'iOS', capabilities: {}},
        remoteServerUrl: 'https://192.0.2.1',
      }),
    ).toBe(false);
  });
});
