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
