import {realpath} from 'node:fs/promises';

import {bindManagedSession, getSessionInfo, type ManagedSessionBinding} from '../session-store.js';
import {callEffortAuthority} from './effort-authority.js';
import {startSessionInventory} from './session-inventory.js';

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

export async function recordSessionIntent(
  args: ManagedSessionArgs,
  capabilities: Record<string, any>,
): Promise<ManagedSessionBinding> {
  if (!args.effortToken || !args.worktree || !args.operationId || !args.udid) {
    throw new Error('Managed simulator creation requires effortToken, worktree, operationId and explicit udid.');
  }
  if (capabilities['appium:udid'] !== args.udid) {
    throw new Error('Session capabilities do not target the assigned simulator.');
  }
  if (!capabilities['appium:webDriverAgentUrl']) {
    throw new Error('Managed simulator sessions require an explicitly prepared WDA endpoint.');
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
