import type {AndroidUiautomator2Driver} from 'appium-uiautomator2-driver';
import type {XCUITestDriver} from 'appium-xcuitest-driver';
import type {Client} from 'webdriver';

import log from './logger.js';
import {removePersistedSession, writePersistedSession} from './persistence.js';

export type DriverInstance = Client | AndroidUiautomator2Driver | XCUITestDriver;
export type NullableDriverInstance = DriverInstance | null;
export type SessionCapabilities = Record<string, any>;
export type SessionOwnership = 'owned' | 'attached';

export interface SessionInfo {
  driver: DriverInstance;
  sessionId: string;
  currentContext: string | null;
  isDeletingSession: boolean;
  ownership: SessionOwnership;
  metadata: SessionMetadata;
  remoteServerUrl?: string;
}

interface SessionMetadata {
  platform: string | null;
  automationName: string | null;
  deviceName: string | null;
  capabilities: SessionCapabilities;
}

const sessions = new Map<string, SessionInfo>();
let activeSessionId: string | null = null;

export const PLATFORM = {android: 'Android', ios: 'iOS'};

export function isRemoteDriverSession(driver: NullableDriverInstance): boolean {
  return !!driver && driver.constructor?.name !== 'AndroidUiautomator2Driver' && driver.constructor?.name !== 'XCUITestDriver';
}
export function isAndroidUiautomator2DriverSession(driver: NullableDriverInstance): driver is AndroidUiautomator2Driver {
  return driver?.constructor?.name === 'AndroidUiautomator2Driver';
}
export function isXCUITestDriverSession(driver: NullableDriverInstance): driver is XCUITestDriver {
  return driver?.constructor?.name === 'XCUITestDriver';
}
export async function setSession(d: DriverInstance, id: string | null, capabilities: SessionCapabilities = {}, ownership: SessionOwnership = 'owned', remoteServerUrl?: string): Promise<void> {
  await setSessionEntry(d, id, capabilities, ownership, remoteServerUrl);
}
export function getDriver(sessionId?: string): NullableDriverInstance {
  const id = sessionId ?? activeSessionId;
  return id ? sessions.get(id)?.driver ?? null : null;
}
export function getSessionId() {return activeSessionId;}
export function listSessions(): Array<{sessionId: string; currentContext: string | null; isActive: boolean; ownership: SessionOwnership; platform: string | null; automationName: string | null; deviceName: string | null; capabilities: SessionCapabilities}> {
  return Array.from(sessions.values()).map((session) => ({sessionId: session.sessionId, currentContext: session.currentContext, isActive: session.sessionId === activeSessionId, ownership: session.ownership, platform: session.metadata.platform, automationName: session.metadata.automationName, deviceName: session.metadata.deviceName, capabilities: session.metadata.capabilities}));
}
export function getSessionOwnership(sessionId?: string): SessionOwnership | null {
  const id = sessionId ?? activeSessionId;
  return id ? sessions.get(id)?.ownership ?? null : null;
}
export function setActiveSession(sessionId: string): boolean {
  if (!sessions.has(sessionId)) {return false;}
  activeSessionId = sessionId;
  return true;
}
export function setCurrentContext(context: string, sessionId?: string): boolean {
  const id = sessionId ?? activeSessionId;
  const session = id ? sessions.get(id) : undefined;
  if (!session) {return false;}
  session.currentContext = context;
  return true;
}
export function getSessionInfo(sessionId?: string): SessionInfo | null {
  const id = sessionId ?? activeSessionId;
  return id ? sessions.get(id) ?? null : null;
}
export function getCurrentContext(sessionId?: string): string | null {
  const id = sessionId ?? activeSessionId;
  return id ? sessions.get(id)?.currentContext ?? null : null;
}
export function isDeletingSessionInProgress(sessionId?: string) {
  const id = sessionId ?? activeSessionId;
  return id ? sessions.get(id)?.isDeletingSession ?? false : false;
}
export function hasActiveSession(): boolean {
  if (!activeSessionId) {return false;}
  const session = sessions.get(activeSessionId);
  return !!session && !session.isDeletingSession;
}
export function detachSession(sessionId?: string): void {
  const id = sessionId ?? activeSessionId;
  if (!id) {throw new Error('No active session to detach.');}
  const session = sessions.get(id);
  if (!session) {throw new Error(`Session ${id} not found.`);}
  if (session.ownership !== 'attached') {throw new Error(`Session ${id} is owned by MCP Appium. Use action=delete to remove it.`);}
  sessions.delete(id);
  activeSessionId = selectNextActiveSessionId(id);
  void removePersistedSession(id);
  log.info(`Session ${id} detached successfully.`);
}
export async function safeDeleteSession(sessionId?: string): Promise<boolean> {
  const id = sessionId ?? activeSessionId;
  if (!id) {log.info('No active session to delete.'); return false;}
  const session = sessions.get(id);
  if (!session) {log.info(`Session ${id} not found.`); return false;}
  if (session.isDeletingSession) {log.info(`Session ${id} deletion already in progress, skipping...`); return false;}
  session.isDeletingSession = true;
  try {
    log.info(`Deleting session ${id}`);
    await session.driver.deleteSession();
    sessions.delete(id);
    activeSessionId = selectNextActiveSessionId(id);
    void removePersistedSession(id);
    log.info(`Session ${id} deleted successfully.`);
    return true;
  } catch (error) {
    log.error('Error deleting session:', error);
    throw error;
  } finally {
    const existingSession = sessions.get(id);
    if (existingSession) {existingSession.isDeletingSession = false;}
  }
}
export async function safeDeleteAllSessions(): Promise<number> {
  let deletedCount = 0;
  for (const sessionId of Array.from(sessions.values()).filter((session) => session.ownership === 'owned').map((session) => session.sessionId)) {
    try {if (await safeDeleteSession(sessionId)) {deletedCount += 1;}}
    catch (error) {log.error(`Error deleting session ${sessionId}:`, error);}
  }
  return deletedCount;
}
async function setSessionEntry(d: DriverInstance, id: string | null, capabilities: SessionCapabilities, ownership: SessionOwnership, remoteServerUrl?: string): Promise<void> {
  if (!id) {activeSessionId = null; return;}
  const metadata: SessionMetadata = {
    platform: (capabilities.platformName as string | undefined) ?? null,
    automationName: (capabilities['appium:automationName'] as string | undefined) ?? (capabilities.automationName as string | undefined) ?? null,
    deviceName: (capabilities['appium:deviceName'] as string | undefined) ?? (capabilities.deviceName as string | undefined) ?? null,
    capabilities,
  };
  sessions.set(id, {driver: d, sessionId: id, currentContext: 'NATIVE_APP', isDeletingSession: false, ownership, metadata, remoteServerUrl});
  activeSessionId = id;
  if (remoteServerUrl) {
    await writePersistedSession({sessionId: id, remoteServerUrl, capabilities, platform: metadata.platform, automationName: metadata.automationName, deviceName: metadata.deviceName, ownership});
  }
}
function selectNextActiveSessionId(deletedSessionId: string): string | null {
  if (activeSessionId !== deletedSessionId) {return activeSessionId;}
  return Array.from(sessions.keys()).find((id) => id !== deletedSessionId) ?? null;
}
export const getPlatformName = (driver: any): string => {
  if (driver?.constructor?.name === 'AndroidUiautomator2Driver') {return PLATFORM.android;}
  if (driver?.constructor?.name === 'XCUITestDriver') {return PLATFORM.ios;}
  const client = driver as Client;
  if (client.isAndroid) {return PLATFORM.android;}
  if (client.isIOS) {return PLATFORM.ios;}
  const session = listSessions().find((s) => s.sessionId === client.sessionId);
  if (session?.platform) {return session.platform;}
  if (client.sessionId) {
    const platformName = sessions.get(client.sessionId)?.metadata.platform;
    if (platformName) {
      if (/android/i.test(platformName)) {return PLATFORM.android;}
      if (/ios/i.test(platformName)) {return PLATFORM.ios;}
      return platformName;
    }
  }
  throw new Error('Unknown driver type');
};
