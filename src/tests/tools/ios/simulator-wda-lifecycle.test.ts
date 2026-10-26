import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

import {afterEach, describe, expect, jest, test} from '@jest/globals';

import {
  cleanupOwnedSimulatorWda,
  classifySimulatorWdaFailure,
  leaseSimulatorWdaEndpoint,
  getSimulatorWdaLifecycleRecord,
  prepareSimulatorWda,
  simulatorWdaFailureKey,
  type SimulatorWdaIdentity,
} from '../../../utils/simulator-wda-lifecycle.js';

const identity: SimulatorWdaIdentity = {
  udid: 'simulator-test-udid',
  platform: 'ios',
  runtime: '26.5',
  artifact: 'bundled-wda-16.12.8',
  toolchain: 'Xcode-26.2',
};
const endpoint = {url: 'http://127.0.0.1:8123', port: 8123};
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, {recursive: true, force: true})));
});

async function stateFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'simulator-wda-lifecycle-'));
  tempDirs.push(dir);
  return path.join(dir, 'failures.json');
}

describe('simulator WDA lifecycle', () => {
  test('converges concurrent same-UDID requests on one managed startup', async () => {
    const startManaged = jest.fn(async () => ({endpoint}));
    const deps = {
      startManaged,
      isEndpointReady: jest.fn(async () => true),
      hasBusyTestOwner: jest.fn(async () => false),
      stateFile: await stateFile(),
    };

    const results = await Promise.all([
      prepareSimulatorWda(identity, deps),
      prepareSimulatorWda(identity, deps),
      prepareSimulatorWda(identity, deps),
    ]);

    expect(startManaged).toHaveBeenCalledTimes(1);
    expect(results.map(({status}) => status)).toEqual(['ready', 'ready', 'ready']);
    expect(results[0].record.endpoint).toEqual(endpoint);
    expect(results[0].record.owned).toBe(true);
  });

  test('rejects busy XCTest owner without invoking managed startup', async () => {
    const startManaged = jest.fn(async () => ({endpoint}));
    const deps = {
      startManaged,
      isEndpointReady: jest.fn(async () => true),
      hasBusyTestOwner: jest.fn(async () => true),
      stateFile: await stateFile(),
    };

    const result = await prepareSimulatorWda({...identity, udid: 'busy-test-udid'}, deps);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') {
      throw new Error('expected failure');
    }
    expect(result.failure.kind).toBe('busy-owner');
    expect(result.failure.permanence).toBe('transient');
    expect(result.failure.message).toMatch(/no process was signaled/i);
    expect(startManaged).not.toHaveBeenCalled();
  });

  test('persists permanent loader failure and suppresses unchanged automatic retry', async () => {
    const file = await stateFile();
    const startManaged = jest.fn(async () => {
      throw new Error('dyld: Library not loaded: @rpath/XCTest.framework/XCTest');
    });
    const deps = {
      startManaged,
      isEndpointReady: jest.fn(async () => false),
      hasBusyTestOwner: jest.fn(async () => false),
      stateFile: file,
    };

    const first = await prepareSimulatorWda(identity, deps);
    const second = await prepareSimulatorWda(identity, deps);

    expect(first.status).toBe('failed');
    expect(second.status).toBe('failed');
    if (first.status !== 'failed' || second.status !== 'failed') {
      throw new Error('expected failures');
    }
    expect(first.failure.kind).toBe('missing-framework');
    expect(second.suppressed).toBe(true);
    expect(startManaged).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(stored.failures)).toEqual([simulatorWdaFailureKey(identity)]);
    expect(JSON.stringify(stored)).not.toContain('/Users/');
  });

  test('explicit retry clears known permanent failure and retries', async () => {
    const file = await stateFile();
    let attempts = 0;
    const deps = {
      startManaged: jest.fn(async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('XCTest.framework is missing');
        }
        return {endpoint};
      }),
      isEndpointReady: jest.fn(async () => true),
      hasBusyTestOwner: jest.fn(async () => false),
      stateFile: file,
    };

    await prepareSimulatorWda(identity, deps);
    const retry = await prepareSimulatorWda(identity, deps, {retryPermanentFailure: true});

    expect(retry.status).toBe('ready');
    expect(attempts).toBe(2);
  });

  test('serializes permanent failures from distinct simulators into the shared state file', async () => {
    const file = await stateFile();
    const fail = (udid: string) => prepareSimulatorWda({...identity, udid}, {
      startManaged: jest.fn(async () => { throw new Error('XCTest.framework is missing'); }),
      isEndpointReady: jest.fn(async () => false),
      hasBusyTestOwner: jest.fn(async () => false),
      stateFile: file,
    });
    await Promise.all([fail('parallel-a'), fail('parallel-b')]);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(stored.failures)).toEqual(expect.arrayContaining([
      simulatorWdaFailureKey({...identity, udid: 'parallel-a'}),
      simulatorWdaFailureKey({...identity, udid: 'parallel-b'}),
    ]));
  });

  test('input changes use a distinct suppression key', async () => {
    expect(simulatorWdaFailureKey(identity)).not.toBe(
      simulatorWdaFailureKey({...identity, runtime: '26.6'}),
    );
  });

  test('transient timeout is not persisted as permanent', async () => {
    const file = await stateFile();
    const deps = {
      startManaged: jest.fn(async () => {
        throw new Error('WDA readiness timed out');
      }),
      isEndpointReady: jest.fn(async () => false),
      hasBusyTestOwner: jest.fn(async () => false),
      stateFile: file,
    };

    const result = await prepareSimulatorWda({...identity, udid: 'transient-test-udid'}, deps);

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') {
      throw new Error('expected failure');
    }
    expect(result.failure.kind).toBe('transient-timeout');
    await expect(readFile(file, 'utf8')).rejects.toMatchObject({code: 'ENOENT'});
  });

  test('refuses to attach a session lease without an owned ready record', async () => {
    const {attachSimulatorWdaSession} = await import('../../../utils/simulator-wda-lifecycle.js');
    expect(attachSimulatorWdaSession('missing-lease-udid', 'ios', 'missing-record-session')).toBe(false);
  });

  test('runs the actual managed cleanup handle once and clears owned lifecycle state', async () => {
    const cleanup = jest.fn(async () => {});
    const deps = {
      startManaged: jest.fn(async () => ({endpoint, cleanup})),
      isEndpointReady: jest.fn(async () => true),
      hasBusyTestOwner: jest.fn(async () => false),
      stateFile: await stateFile(),
    };
    await prepareSimulatorWda({...identity, udid: 'owned-test-udid'}, deps);

    await expect(cleanupOwnedSimulatorWda('owned-test-udid')).resolves.toBe(true);
    await expect(cleanupOwnedSimulatorWda('owned-test-udid')).resolves.toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(getSimulatorWdaLifecycleRecord('owned-test-udid')).toBeUndefined();
  });

  test('cleanup cannot overtake a concurrent readiness check for an existing runner', async () => {
    const udid = 'readiness-cleanup-reverse-order-udid';
    const isolatedEndpoint = {url: 'http://127.0.0.1:19347', port: 19347};
    const cleanup = jest.fn(async () => {});
    let finishReadiness!: (ready: boolean) => void;
    let markProbeEntered!: () => void;
    const probeEntered = new Promise<void>((resolve) => { markProbeEntered = resolve; });
    const deps = {
      startManaged: jest.fn(async () => ({endpoint: isolatedEndpoint, cleanup})),
      isEndpointReady: jest.fn<(...args: any[]) => Promise<boolean>>()
        .mockResolvedValueOnce(true)
        .mockImplementationOnce(() => {
          markProbeEntered();
          return new Promise<boolean>((resolve) => { finishReadiness = resolve; });
        }),
      hasBusyTestOwner: jest.fn(async () => false),
      stateFile: await stateFile(),
    };
    await prepareSimulatorWda({...identity, udid}, deps);

    const preparing = prepareSimulatorWda({...identity, udid}, deps);
    await probeEntered;
    await expect(cleanupOwnedSimulatorWda(udid)).resolves.toBe(false);
    finishReadiness(true);
    await expect(preparing).resolves.toMatchObject({status: 'already-running', record: {endpoint: isolatedEndpoint, state: 'ready'}});
    expect(cleanup).not.toHaveBeenCalled();
    expect(getSimulatorWdaLifecycleRecord(udid)).toMatchObject({endpoint: isolatedEndpoint, state: 'ready'});
    await expect(cleanupOwnedSimulatorWda(udid)).resolves.toBe(true);
    await expect(cleanupOwnedSimulatorWda(udid)).resolves.toBe(false);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test('refuses cleanup while a managed simulator session holds a lease', async () => {
    const cleanup = jest.fn(async () => {});
    await prepareSimulatorWda({...identity, udid: 'leased-test-udid'}, {
      startManaged: jest.fn(async () => ({endpoint, cleanup})),
      isEndpointReady: jest.fn(async () => true),
      hasBusyTestOwner: jest.fn(async () => false),
      stateFile: await stateFile(),
    });
    const {attachSimulatorWdaSession, releaseSimulatorWdaSession} = await import('../../../utils/simulator-wda-lifecycle.js');
    attachSimulatorWdaSession('leased-test-udid', 'ios', 'lease-session');
    await expect(cleanupOwnedSimulatorWda('leased-test-udid')).resolves.toBe(false);
    releaseSimulatorWdaSession('lease-session');
    await expect(cleanupOwnedSimulatorWda('leased-test-udid')).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test('prepare waits for cleanup and retains the new record after old stop completes', async () => {
    let finish!: () => void;
    let starts = 0;
    const cleanup = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const deps = {
      startManaged: jest.fn(async () => ({endpoint, ...(starts++ === 0 ? {cleanup} : {})})),
      isEndpointReady: jest.fn(async () => true),
      hasBusyTestOwner: jest.fn(async () => false),
      stateFile: await stateFile(),
    };
    await prepareSimulatorWda({...identity, udid: 'cleanup-prepare-udid'}, deps);
    const stopping = cleanupOwnedSimulatorWda('cleanup-prepare-udid');
    await Promise.resolve();
    const preparing = prepareSimulatorWda({...identity, udid: 'cleanup-prepare-udid'}, deps);
    expect(deps.startManaged).toHaveBeenCalledTimes(1);
    finish();
    await expect(stopping).resolves.toBe(true);
    await expect(preparing).resolves.toMatchObject({status: 'ready'});
    expect(deps.startManaged).toHaveBeenCalledTimes(2);
    expect(getSimulatorWdaLifecycleRecord('cleanup-prepare-udid')).toMatchObject({state: 'ready'});
  });

  test('transfers an existing lease atomically without opening a cleanup gap', async () => {
    const udid = 'lease-transfer-udid';
    const cleanup = jest.fn(async () => {});
    await prepareSimulatorWda({...identity, udid}, {
      startManaged: jest.fn(async () => ({endpoint, cleanup})),
      isEndpointReady: jest.fn(async () => true),
      hasBusyTestOwner: jest.fn(async () => false),
      stateFile: await stateFile(),
    });
    const {attachSimulatorWdaSession, transferSimulatorWdaSessionLease, releaseSimulatorWdaSession} = await import('../../../utils/simulator-wda-lifecycle.js');
    expect(attachSimulatorWdaSession(udid, 'ios', 'creating-session')).toBe(true);
    expect(transferSimulatorWdaSessionLease('missing-lease', 'created-session')).toBe(false);
    expect(transferSimulatorWdaSessionLease('creating-session', 'created-session')).toBe(true);
    await expect(cleanupOwnedSimulatorWda(udid)).resolves.toBe(false);
    releaseSimulatorWdaSession('created-session');
    await expect(cleanupOwnedSimulatorWda(udid)).resolves.toBe(true);
  });

  test('refuses endpoint lease during readiness and preserves cleanup until readiness settles', async () => {
    const udid = 'url-lease-readiness-race-udid';
    const raceEndpoint = {url: 'http://127.0.0.1:19001', port: 19001};
    let finishReadiness!: (ready: boolean) => void;
    let markProbeEntered!: () => void;
    const probeEntered = new Promise<void>((resolve) => { markProbeEntered = resolve; });
    const cleanup = jest.fn(async () => {});
    const deps = {
      startManaged: jest.fn(async () => ({endpoint: raceEndpoint, cleanup})),
      isEndpointReady: jest.fn<(...args: any[]) => Promise<boolean>>()
        .mockResolvedValueOnce(true)
        .mockImplementationOnce(() => {
          markProbeEntered();
          return new Promise<boolean>((resolve) => { finishReadiness = resolve; });
        }),
      hasBusyTestOwner: jest.fn(async () => false),
      stateFile: await stateFile(),
    };
    await prepareSimulatorWda({...identity, udid}, deps);
    const preparing = prepareSimulatorWda({...identity, udid}, deps);
    await probeEntered;

    expect(leaseSimulatorWdaEndpoint(raceEndpoint.url, 'during-readiness')).toBeNull();
    await expect(cleanupOwnedSimulatorWda(udid)).resolves.toBe(false);
    finishReadiness(true);
    await expect(preparing).resolves.toMatchObject({status: 'already-running'});
    expect(leaseSimulatorWdaEndpoint(raceEndpoint.url, 'after-readiness')).toEqual({udid, platform: 'ios'});
    await expect(cleanupOwnedSimulatorWda(udid)).resolves.toBe(false);
  });

  test('leases only an exact owned ready endpoint and refuses it during cleanup', async () => {
    const endpoint = {url: 'http://127.0.0.1:18234', port: 18234};
    let finish!: () => void;
    const cleanup = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await prepareSimulatorWda({...identity, udid: 'url-lease-udid'}, {
      startManaged: jest.fn(async () => ({endpoint, cleanup})),
      isEndpointReady: jest.fn(async () => true),
      hasBusyTestOwner: jest.fn(async () => false),
      stateFile: await stateFile(),
    });
    expect(leaseSimulatorWdaEndpoint('http://localhost:8123', 'external')).toBeUndefined();
    expect(leaseSimulatorWdaEndpoint(endpoint.url, 'session-lease')).toEqual({udid: 'url-lease-udid', platform: 'ios'});
    const {releaseSimulatorWdaSession} = await import('../../../utils/simulator-wda-lifecycle.js');
    releaseSimulatorWdaSession('session-lease');
    const stopping = cleanupOwnedSimulatorWda('url-lease-udid');
    await Promise.resolve();
    expect(leaseSimulatorWdaEndpoint(endpoint.url, 'during-stop')).toBeNull();
    finish();
    await stopping;
    expect(getSimulatorWdaLifecycleRecord('url-lease-udid')).toBeUndefined();
  });

  test('cleanup is serialized and resolves tvOS by UDID when platform is omitted', async () => {
    let finish!: () => void;
    const cleanup = jest.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    await prepareSimulatorWda({...identity, udid: 'tvos-cleanup-udid', platform: 'tvos'}, {
      startManaged: jest.fn(async () => ({endpoint, cleanup})),
      isEndpointReady: jest.fn(async () => true),
      hasBusyTestOwner: jest.fn(async () => false),
      stateFile: await stateFile(),
    });
    const first = cleanupOwnedSimulatorWda('tvos-cleanup-udid');
    const second = cleanupOwnedSimulatorWda('tvos-cleanup-udid', 'tvos');
    await Promise.resolve();
    finish();
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test('classifies loader errors as permanent and bounded', () => {
    const failure = classifySimulatorWdaFailure(new Error(`XCTest.framework missing ${'x'.repeat(2000)}`));
    expect(failure.kind).toBe('missing-framework');
    expect(failure.permanence).toBe('permanent');
    expect(failure.evidence?.length).toBeLessThanOrEqual(1200);
  });
});
