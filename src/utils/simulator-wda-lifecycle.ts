import {createHash} from 'node:crypto';
import {mkdir, readFile, rename, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';

export type SimulatorWdaFailureKind = 'busy-owner' | 'missing-framework' | 'early-exit' | 'startup-error' | 'transient-timeout';
export type SimulatorWdaFailurePermanence = 'permanent' | 'transient';

export interface SimulatorWdaIdentity {
  udid: string;
  platform: 'ios' | 'tvos';
  runtime: string;
  artifact: string;
  toolchain: string;
}

export interface SimulatorWdaEndpoint {
  url: string;
  port: number;
}

export interface SimulatorWdaFailure {
  kind: SimulatorWdaFailureKind;
  permanence: SimulatorWdaFailurePermanence;
  message: string;
  evidence?: string;
}

export interface SimulatorWdaStartResult {
  endpoint: SimulatorWdaEndpoint;
  cleanup?: () => Promise<void>;
}

export interface SimulatorWdaLifecycleRecord {
  identity: SimulatorWdaIdentity;
  state: 'starting' | 'ready' | 'stopping' | 'failed';
  endpoint?: SimulatorWdaEndpoint;
  failure?: SimulatorWdaFailure;
  owned: boolean;
  updatedAt: string;
}

export interface SimulatorWdaLifecycleDependencies {
  startManaged(identity: SimulatorWdaIdentity, context?: {path: string; bundleId: string}): Promise<SimulatorWdaStartResult>;
  isEndpointReady(endpoint: SimulatorWdaEndpoint, identity: SimulatorWdaIdentity): Promise<boolean>;
  /** Returns true when another process owns XCTest activity for this simulator. */
  hasBusyTestOwner(identity: SimulatorWdaIdentity): Promise<boolean>;
  stateFile?: string;
  now?: () => number;
  maxPersistentFailures?: number;
}

export type SimulatorWdaPrepareResult =
  | {status: 'ready' | 'already-running'; record: SimulatorWdaLifecycleRecord}
  | {status: 'failed'; record: SimulatorWdaLifecycleRecord; failure: SimulatorWdaFailure; suppressed: boolean};

const MAX_EVIDENCE_CHARS = 1200;
const MAX_FAILURE_MESSAGE_CHARS = 500;
const DEFAULT_MAX_FAILURES = 32;
const DEFAULT_STATE_FILE = path.join(homedir(), '.cache', 'appium-mcp', 'wda-lifecycle-failures.json');
const inFlight = new Map<string, Promise<SimulatorWdaPrepareResult>>();
const records = new Map<string, SimulatorWdaLifecycleRecord>();
const cleanupHandles = new Map<string, () => Promise<void>>();
const persistenceQueues = new Map<string, Promise<void>>();
const cleanupQueues = new Map<string, Promise<boolean>>();
const activeSessionLeases = new Map<string, Set<string>>();

function keyFor(identity: SimulatorWdaIdentity): string {
  return `${identity.platform}:${identity.udid}`;
}

export function simulatorWdaFailureKey(identity: SimulatorWdaIdentity): string {
  return createHash('sha256')
    .update(JSON.stringify([identity.udid, identity.platform, identity.runtime, identity.artifact, identity.toolchain]))
    .digest('hex');
}

export function classifySimulatorWdaFailure(error: unknown): SimulatorWdaFailure {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const sanitized = raw
    .replace(/(?:\/Users\/|\/home\/)[^\s/:]+/g, '<user>')
    .replace(/(password|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(-MAX_EVIDENCE_CHARS);
  if (/xctest\.framework|library not loaded|dyld:.*library missing|image not found/i.test(raw)) {
    return {
      kind: 'missing-framework',
      permanence: 'permanent',
      message: 'The WebDriverAgent runner cannot load a required XCTest framework. Repair the Xcode/simulator compatibility, then explicitly retry WDA preparation.',
      evidence: sanitized,
    };
  }
  if (/busy.*(xctest|test process)|xctest.*busy|another.*test owner/i.test(raw)) {
    return {kind: 'busy-owner', permanence: 'transient', message: sanitized.slice(-MAX_FAILURE_MESSAGE_CHARS), evidence: sanitized};
  }
  if (/early exit|exited before|process.*terminated/i.test(raw)) {
    return {
      kind: 'early-exit',
      permanence: /xctest\.framework|dyld|library missing/i.test(raw) ? 'permanent' : 'transient',
      message: sanitized.slice(-MAX_FAILURE_MESSAGE_CHARS),
      evidence: sanitized,
    };
  }
  if (/timeout|timed out|not ready/i.test(raw)) {
    return {kind: 'transient-timeout', permanence: 'transient', message: sanitized.slice(-MAX_FAILURE_MESSAGE_CHARS), evidence: sanitized};
  }
  return {kind: 'startup-error', permanence: 'transient', message: sanitized.slice(-MAX_FAILURE_MESSAGE_CHARS), evidence: sanitized};
}

async function readFailureMap(filePath: string): Promise<Record<string, SimulatorWdaFailure>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    const failures = (parsed as {failures?: unknown}).failures;
    if (!failures || typeof failures !== 'object' || Array.isArray(failures)) {
      return {};
    }
    return failures as Record<string, SimulatorWdaFailure>;
  } catch {
    return {};
  }
}

async function writeFailureMap(filePath: string, failureMap: Record<string, SimulatorWdaFailure>): Promise<void> {
  await mkdir(path.dirname(filePath), {recursive: true});
  const tempPath = `${filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(tempPath, JSON.stringify({version: 1, failures: failureMap}), {mode: 0o600});
  await rename(tempPath, filePath);
}

async function withFailureMapLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  const previous = persistenceQueues.get(filePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  persistenceQueues.set(filePath, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (persistenceQueues.get(filePath) === queued) {
      persistenceQueues.delete(filePath);
    }
  }
}

function makeRecord(identity: SimulatorWdaIdentity, state: SimulatorWdaLifecycleRecord['state'], now: () => number): SimulatorWdaLifecycleRecord {
  return {identity, state, owned: state !== 'failed', updatedAt: new Date(now()).toISOString()};
}

export async function prepareSimulatorWda(
  identity: SimulatorWdaIdentity,
  deps: SimulatorWdaLifecycleDependencies,
  options: {retryPermanentFailure?: boolean; startContext?: {path: string; bundleId: string}} = {},
): Promise<SimulatorWdaPrepareResult> {
  const key = keyFor(identity);
  const cleanup = cleanupQueues.get(key);
  if (cleanup) {
    await cleanup;
  }
  const running = inFlight.get(key);
  if (running) {
    return running;
  }
  const promise = prepareOnce(identity, deps, options);
  inFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key);
    }
  }
}

async function prepareOnce(
  identity: SimulatorWdaIdentity,
  deps: SimulatorWdaLifecycleDependencies,
  options: {retryPermanentFailure?: boolean; startContext?: {path: string; bundleId: string}},
): Promise<SimulatorWdaPrepareResult> {
  const key = keyFor(identity);
  const now = deps.now ?? Date.now;
  const stateFile = deps.stateFile ?? DEFAULT_STATE_FILE;
  const failureKey = simulatorWdaFailureKey(identity);
  const persisted = await readFailureMap(stateFile);
  const knownFailure = persisted[failureKey];
  if (knownFailure && !options.retryPermanentFailure) {
    const record: SimulatorWdaLifecycleRecord = {
      ...makeRecord(identity, 'failed', now),
      owned: false,
      failure: knownFailure,
    };
    records.set(key, record);
    return {status: 'failed', record, failure: knownFailure, suppressed: true};
  }
  if (options.retryPermanentFailure && knownFailure) {
    await withFailureMapLock(stateFile, async () => {
      const current = await readFailureMap(stateFile);
      delete current[failureKey];
      await writeFailureMap(stateFile, current);
    });
  }

  const previous = records.get(key);
  if (previous?.state === 'ready' && previous.endpoint && (await deps.isEndpointReady(previous.endpoint, identity))) {
    return {status: 'already-running', record: previous};
  }

  records.set(key, makeRecord(identity, 'starting', now));
  try {
    if (await deps.hasBusyTestOwner(identity)) {
      throw new Error('Simulator is busy with another XCTest owner; WDA startup was not attempted and no process was signaled.');
    }
    const started = await deps.startManaged(identity, options.startContext);
    if (!(await deps.isEndpointReady(started.endpoint, identity))) {
      const error = new Error('Managed WebDriverAgent process exited before its endpoint became ready.');
      Object.assign(error, {cleanup: started.cleanup});
      throw error;
    }
    const ready: SimulatorWdaLifecycleRecord = {
      ...makeRecord(identity, 'ready', now),
      owned: true,
      endpoint: started.endpoint,
    };
    records.set(key, ready);
    if (started.cleanup) {
      cleanupHandles.set(key, started.cleanup);
    }
    return {status: 'ready', record: ready};
  } catch (error) {
    const failure = classifySimulatorWdaFailure(error);
    const cleanup = (error as {cleanup?: () => Promise<void>})?.cleanup;
    if (cleanup) {
      await cleanup().catch(() => undefined);
    }
    const failed: SimulatorWdaLifecycleRecord = {
      ...makeRecord(identity, 'failed', now),
      owned: false,
      failure,
    };
    records.set(key, failed);
    if (failure.permanence === 'permanent') {
      await withFailureMapLock(stateFile, async () => {
        const current = await readFailureMap(stateFile);
        current[failureKey] = failure;
        const bounded = Object.fromEntries(Object.entries(current).slice(-Math.max(1, deps.maxPersistentFailures ?? DEFAULT_MAX_FAILURES)));
        await writeFailureMap(stateFile, bounded);
      });
    }
    return {status: 'failed', record: failed, failure, suppressed: false};
  }
}

/** Mark a session as using a managed runner so explicit cleanup cannot stop it. */
export function attachSimulatorWdaSession(udid: string, platform: 'ios' | 'tvos', sessionId: string): boolean {
  const key = `${platform}:${udid}`;
  const record = records.get(key);
  if (!record || record.state !== 'ready' || !record.owned || !record.endpoint || inFlight.has(key) || cleanupQueues.has(key)) {return false;}
  const leases = activeSessionLeases.get(key) ?? new Set<string>();
  leases.add(sessionId);
  activeSessionLeases.set(key, leases);
  return true;
}

/** Atomically replace a provisional lease with the created session lease. */
export function transferSimulatorWdaSessionLease(from: string, to: string): boolean {
  for (const leases of activeSessionLeases.values()) {
    if (!leases.has(from)) {continue;}
    leases.delete(from);
    leases.add(to);
    return true;
  }
  return false;
}

/** Lease a service-owned ready endpoint before session creation can yield. */
export function leaseSimulatorWdaEndpoint(url: string, leaseId: string): {udid: string; platform: 'ios' | 'tvos'} | null | undefined {
  for (const [key, record] of records) {
    if (record.endpoint?.url !== url || !record.owned || !/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(url)) {continue;}
    if (record.state !== 'ready' || cleanupQueues.has(key)) {return null;}
    const [platform, udid] = key.split(':', 2) as ['ios' | 'tvos', string];
    if (!attachSimulatorWdaSession(udid, platform, leaseId)) {return null;}
    return {udid, platform};
  }
  return undefined;
}

/** Release a managed-runner session lease after deletion or failed creation. */
export function releaseSimulatorWdaSession(sessionId: string): void {
  for (const [key, leases] of activeSessionLeases) {
    leases.delete(sessionId);
    if (leases.size === 0) {activeSessionLeases.delete(key);}
  }
}

/** Stop only an idle runner started and recorded as owned by this service. */
export async function cleanupOwnedSimulatorWda(udid: string, platform?: 'ios' | 'tvos'): Promise<boolean> {
  const matches = platform ? [`${platform}:${udid}`] : [...records.keys()].filter((key) => key.endsWith(`:${udid}`));
  if (matches.length !== 1) {return false;}
  const key = matches[0];
  // An in-flight readiness check is using this runner. Refuse cleanup rather
  // than invalidating the endpoint that preparation is about to return.
  if (inFlight.has(key)) { return false; }
  const previous = cleanupQueues.get(key);
  if (previous) {return previous;}
  const operation = (async () => {
    const record = records.get(key);
    const cleanup = cleanupHandles.get(key);
    if (!record || record.state !== 'ready' || !record.owned || !cleanup || activeSessionLeases.get(key)?.size) {return false;}
    const stopping: SimulatorWdaLifecycleRecord = {...record, state: 'stopping', updatedAt: new Date().toISOString()};
    records.set(key, stopping);
    try {
      await cleanup();
      if (records.get(key) === stopping && cleanupHandles.get(key) === cleanup) {
        cleanupHandles.delete(key);
        records.delete(key);
      }
      return true;
    } catch (error) {
      if (records.get(key) === stopping && cleanupHandles.get(key) === cleanup) {
        records.set(key, record);
      }
      throw error;
    }
  })();
  cleanupQueues.set(key, operation);
  try { return await operation; }
  finally { if (cleanupQueues.get(key) === operation) {cleanupQueues.delete(key);} }
}

export function getSimulatorWdaLifecycleRecord(udid: string, platform: 'ios' | 'tvos' = 'ios'): SimulatorWdaLifecycleRecord | undefined {
  return records.get(`${platform}:${udid}`);
}
