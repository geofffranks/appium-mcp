import {realpath} from 'node:fs/promises';

import {bindManagedSession, getSessionInfo, type ManagedSessionBinding} from '../session-store.js';
import {callEffortAuthority} from './effort-authority.js';
import {startSessionInventory} from './session-inventory.js';
import {captureWdaCensus, parseWdaStatusDevice, sameWdaCensus} from './wda-binding.js';
import type {WdaCommandRunner} from './wda-binding.js';

export interface ManagedSessionArgs {
  effortToken?: string;
  worktree?: string;
  operationId?: string;
  udid?: string;
}

async function requireUpdate(
  command: 'resource-add' | 'resource-remove',
  request: Record<string, unknown>,
): Promise<void> {
  const result = await callEffortAuthority(command, request);
  if (!result.ok) {
    throw new Error(`Managed session ${command} failed (${result.status}); preserve ownership and reconcile.`);
  }
}

function requireSupportedWdaEndpoint(value: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error('Managed WDA endpoint must be a literal local HTTP endpoint; preserve ownership and reconcile.');
  }
  if (
    endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
    endpoint.username || endpoint.password || value !== endpoint.origin
  ) {
    throw new Error('Managed WDA endpoint must be a literal local HTTP endpoint without credentials or extra URL components.');
  }
  return endpoint;
}

export async function recordSessionIntent(
  args: ManagedSessionArgs,
  capabilities: Record<string, any>,
  deps: {run?: WdaCommandRunner} = {},
): Promise<ManagedSessionBinding> {
  if (!args.effortToken || !args.worktree || !args.operationId || !args.udid) {
    throw new Error('Managed simulator creation requires effortToken, worktree, operationId and explicit udid.');
  }
  if (capabilities['appium:udid'] !== args.udid) {
    throw new Error('Session capabilities do not target the assigned simulator.');
  }
  const suppliedEndpoint = capabilities['appium:webDriverAgentUrl'];
  if (typeof suppliedEndpoint !== 'string') {
    throw new Error('Managed simulator sessions require an explicitly prepared WDA endpoint.');
  }
  const requestedEndpoint = requireSupportedWdaEndpoint(suppliedEndpoint);
  const resources = await callEffortAuthority('resources', {token: args.effortToken});
  if (!resources.ok) {throw new Error('WDA authority lookup failed; preserve ownership and reconcile.');}
  const endpoint = requestedEndpoint.href;
  const ownedWda = resources.ok && resources.record?.resources?.find((resource: Record<string, unknown>) => {
    if (resource.kind !== 'wda' || resource.owned !== true || resource.pending || resource.udid !== args.udid || typeof resource.endpoint !== 'string') {
      return false;
    }
    try {
      return requireSupportedWdaEndpoint(resource.endpoint).href === endpoint;
    } catch {
      return false;
    }
  });
  if (!ownedWda) {
    throw new Error('WDA endpoint is not a ready resource owned by this effort and assigned simulator; nothing started.');
  }
  const port = requestedEndpoint.port ? Number(requestedEndpoint.port) : 80;
  const before = await captureWdaCensus(args.udid, port, deps.run);
  const response = await fetch(new URL('status', endpoint), {signal: AbortSignal.timeout(3000)});
  if (!response.ok) {throw new Error('Owned WDA endpoint is not healthy; preserve ownership and reconcile.');}
  const status: unknown = await response.json();
  parseWdaStatusDevice(status, args.udid);
  const after = await captureWdaCensus(args.udid, port, deps.run);
  if (!sameWdaCensus(before, after)) {
    throw new Error('WDA process changed during health verification; preserve ownership and reconcile.');
  }
  if (
    capabilities['appium:fullReset'] ||
    capabilities['appium:resetOnSessionStartOnly'] ||
    capabilities['appium:useNewWDA']
  ) {
    throw new Error('Managed acquisition does not authorize device data reset or WDA replacement.');
  }
  const binding: ManagedSessionBinding = {
    effortToken: args.effortToken,
    worktree: await realpath(args.worktree),
    operationId: args.operationId,
    udid: args.udid,
    inventoryEndpoint: await startSessionInventory(),
  };
  await requireUpdate('resource-add', {
    token: binding.effortToken,
    operationId: binding.operationId,
    kind: 'appiumSession',
    id: `appium:${binding.operationId}`,
    owned: true,
    pending: true,
    lifetime: 'keepalive',
    udid: binding.udid,
    endpoint: binding.inventoryEndpoint,
  });
  return binding;
}

export async function recordCreatedSession(sessionId: string, binding: ManagedSessionBinding): Promise<void> {
  // Inventory must expose the real driver session before the durable intent is promoted.
  bindManagedSession(sessionId, binding);
  await requireUpdate('resource-add', {
    token: binding.effortToken,
    operationId: binding.operationId,
    kind: 'appiumSession',
    id: `appium:${binding.operationId}`,
    owned: true,
    lifetime: 'keepalive',
    udid: binding.udid,
    endpoint: binding.inventoryEndpoint,
    sessionId,
  });
}

export async function verifySessionDeleteBinding(
  sessionId: string | undefined,
  args: ManagedSessionArgs,
): Promise<ManagedSessionBinding | undefined> {
  const session = getSessionInfo(sessionId);
  if (!session?.effortToken) {
    return undefined;
  }
  if (
    !sessionId ||
    args.effortToken !== session.effortToken ||
    !args.worktree ||
    !args.operationId ||
    (await realpath(args.worktree)) !== session.worktree
  ) {
    throw new Error('Managed deletion requires the explicit session and its owning effort/worktree.');
  }
  return {
    effortToken: session.effortToken,
    worktree: session.worktree!,
    operationId: session.operationId!,
    udid: session.udid!,
    inventoryEndpoint: session.inventoryEndpoint!,
  };
}

export async function recordDeletedSession(binding: ManagedSessionBinding, operationId: string): Promise<void> {
  await requireUpdate('resource-remove', {
    token: binding.effortToken,
    operationId,
    id: `appium:${binding.operationId}`,
  });
}
