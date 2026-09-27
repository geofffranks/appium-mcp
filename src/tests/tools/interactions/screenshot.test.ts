import {describe, test, expect, jest, beforeEach} from '@jest/globals';

import {saveScreenshotFile} from '../../../utils/screenshot-file.js';

const mockGetDriver = jest.fn((_sessionId?: string): any => null);
const mockSetSession = jest.fn(async () => {});
const mockReadAllPersistedSessions = jest.fn(async (): Promise<any[]> => []);
const mockRemovePersistedSession = jest.fn(async () => {});
const mockAttachToRemoteSession = jest.fn(async (_opts: any): Promise<any> => ({}));
const mockValidateRemoteServerUrl = jest.fn((_url: string, _regex?: string) => {});
const pngBuffer = Buffer.alloc(24);
pngBuffer.set([137, 80, 78, 71, 13, 10, 26, 10]);
pngBuffer.writeUInt32BE(1, 16);
pngBuffer.writeUInt32BE(1, 20);
const pngBase64 = pngBuffer.toString('base64');
const mockGetScreenshot = jest.fn(async () => pngBase64);

jest.unstable_mockModule('../../../session-store.js', () => ({
  getDriver: mockGetDriver,
  setSession: mockSetSession,
}));

jest.unstable_mockModule('../../../persistence.js', () => ({
  readAllPersistedSessions: mockReadAllPersistedSessions,
  removePersistedSession: mockRemovePersistedSession,
  isSessionPersistenceEnabled: jest.fn(() => false),
  getPersistenceDir: jest.fn(() => null),
  writePersistedSession: jest.fn(async () => {}),
}));

jest.unstable_mockModule('../../../utils/url.js', () => ({
  attachToRemoteSession: mockAttachToRemoteSession,
  validateRemoteServerUrl: mockValidateRemoteServerUrl,
}));

jest.unstable_mockModule('../../../command.js', () => ({
  getScreenshot: mockGetScreenshot,
}));

jest.unstable_mockModule('../../../logger.js', () => ({
  default: {debug: () => {}, info: () => {}, warn: () => {}, error: () => {}},
}));

const {executeScreenshot} = await import('../../../tools/interactions/screenshot.js');

function textFromResult(result: {
  content: Array<{type: string; text?: string}>;
  isError?: boolean;
}): string | undefined {
  const block = result.content[0];
  return block && 'text' in block ? block.text : undefined;
}

describe('executeScreenshot resolveDriver', () => {
  beforeEach(() => {
    mockGetDriver.mockReset();
    mockSetSession.mockReset();
    mockReadAllPersistedSessions.mockReset();
    mockReadAllPersistedSessions.mockResolvedValue([]);
    mockRemovePersistedSession.mockReset();
    mockAttachToRemoteSession.mockReset();
    mockValidateRemoteServerUrl.mockReset();
    mockGetScreenshot.mockReset();
    mockGetScreenshot.mockResolvedValue(pngBase64);
  });

  test('takes a screenshot when an in-memory driver is available', async () => {
    mockGetDriver.mockReturnValue({} as any);

    const result = await executeScreenshot({
      returnRawBase64: true,
      sessionId: 's1',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({
      type: 'image',
      mimeType: 'image/png',
    });
    expect(mockGetScreenshot).toHaveBeenCalledTimes(1);
  });

  test('returns bounded hash metadata without including saved image bytes', async () => {
    mockGetDriver.mockReturnValue({} as any);
    const {mkdtemp, rm} = await import('node:fs/promises');
    const {tmpdir} = await import('node:os');
    const directory = await mkdtemp(`${tmpdir()}/appium-screenshot-`);
    const deps = screenshotDeps();
    deps.resolveScreenshotDir = () => directory;

    const result = await executeScreenshot({deps});
    await rm(directory, {recursive: true, force: true});
    const text = result.content[0].type === 'text' ? result.content[0].text : '';
    const {createHash} = await import('node:crypto');

    expect(text).toContain(`filepath=${directory}/screenshot_123_`);
    expect(text).toContain('mimeType=image/png');
    expect(text).toContain(`sha256=${createHash('sha256').update(pngBuffer).digest('hex')}`);
    expect(JSON.stringify(result)).not.toContain(pngBase64);
    expect(result.structuredContent).toBeUndefined();
  });

  test('hashes the actual PNG file written to disk', async () => {
    const {mkdtemp, readFile, rm} = await import('node:fs/promises');
    const {tmpdir} = await import('node:os');
    const {createHash} = await import('node:crypto');
    const directory = await mkdtemp(`${tmpdir()}/appium-screenshot-`);
    mockGetDriver.mockReturnValue({} as any);
    const deps = screenshotDeps();
    deps.resolveScreenshotDir = () => directory;

    try {
      const result = await executeScreenshot({deps});
      const {readdir} = await import('node:fs/promises');
      const [savedName] = await readdir(directory);
      const savedBytes = await readFile(`${directory}/${savedName}`);
      const text = result.content[0].type === 'text' ? result.content[0].text : '';

      expect(text).toContain(`sha256=${createHash('sha256').update(savedBytes).digest('hex')}`);
      expect(savedBytes).toEqual(pngBuffer);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  test('does not write or return an image that is not PNG', async () => {
    mockGetDriver.mockReturnValue({} as any);
    mockGetScreenshot.mockResolvedValue(Buffer.from('not png').toString('base64'));
    const deps = screenshotDeps();

    const result = await executeScreenshot({deps});

    expect(result.isError).toBe(true);
    expect(result.content[0].type === 'text' ? result.content[0].text : '').toContain('not a PNG');
    expect(result.isError).toBe(true);
  });

  test('reports failed writes without returning screenshot bytes', async () => {
    mockGetDriver.mockReturnValue({} as any);
    const deps = screenshotDeps();
    deps.saveFile = jest.fn(async () => {
      throw new Error('Disk full');
    }) as any;

    const result = await executeScreenshot({deps});

    expect(result.isError).toBe(true);
    expect(result.content[0].type === 'text' ? result.content[0].text : '').toContain('Disk full');
    expect(JSON.stringify(result)).not.toContain(pngBase64);
  });

  test('returns no-active-session error when nothing is available to rehydrate', async () => {
    mockGetDriver.mockReturnValue(null);

    const result = await executeScreenshot({
      returnRawBase64: true,
      sessionId: 'missing',
    });

    expect(result.isError).toBe(true);
    expect(textFromResult(result)).toMatch(/No active driver session/i);
    expect(mockGetScreenshot).not.toHaveBeenCalled();
  });

  test('rehydrates a persisted attached session before taking a screenshot', async () => {
    const remoteClient = {
      getTimeouts: jest.fn(async () => ({})),
    };
    mockGetDriver
      .mockReturnValueOnce(null) // first resolveDriver miss
      .mockReturnValueOnce({} as any); // after setSession
    mockReadAllPersistedSessions.mockResolvedValue([
      {
        sessionId: 'persisted-1',
        remoteServerUrl: 'http://remote:4723',
        ownership: 'attached',
        platform: 'Android',
        automationName: 'UiAutomator2',
        deviceName: 'emulator-5554',
        capabilities: {platformName: 'Android'},
      },
    ] as any);
    mockAttachToRemoteSession.mockResolvedValue(remoteClient);

    const result = await executeScreenshot({
      returnRawBase64: true,
      sessionId: 'persisted-1',
    });

    expect(result.isError).toBeFalsy();
    expect(mockAttachToRemoteSession).toHaveBeenCalledWith({
      remoteServerUrl: 'http://remote:4723',
      sessionId: 'persisted-1',
      capabilities: {platformName: 'Android'},
    });
    expect(mockSetSession).toHaveBeenCalled();
    expect(mockGetScreenshot).toHaveBeenCalledTimes(1);
  });

  test('does not rehydrate a persisted session disallowed by the current URL policy', async () => {
    const previousRule = process.env.REMOTE_SERVER_URL_ALLOW_REGEX;
    process.env.REMOTE_SERVER_URL_ALLOW_REGEX = '^https://allowed\\.example(?:/.*)?$';
    mockGetDriver.mockReturnValue(null);
    mockReadAllPersistedSessions.mockResolvedValue([
      {
        sessionId: 'persisted-disallowed',
        remoteServerUrl: 'http://metadata.internal/latest',
        ownership: 'attached',
        capabilities: {platformName: 'Android'},
      },
    ] as any);
    mockValidateRemoteServerUrl.mockImplementation(() => {
      throw new Error('Invalid remoteServerUrl: http://metadata.internal/latest.');
    });

    try {
      const result = await executeScreenshot({
        returnRawBase64: true,
        sessionId: 'persisted-disallowed',
      });

      expect(result.isError).toBe(true);
      expect(mockValidateRemoteServerUrl).toHaveBeenCalledWith(
        'http://metadata.internal/latest',
        '^https://allowed\\.example(?:/.*)?$',
      );
      expect(mockAttachToRemoteSession).not.toHaveBeenCalled();
      expect(mockSetSession).not.toHaveBeenCalled();
      expect(mockRemovePersistedSession).not.toHaveBeenCalled();
    } finally {
      if (previousRule === undefined) {
        delete process.env.REMOTE_SERVER_URL_ALLOW_REGEX;
      } else {
        process.env.REMOTE_SERVER_URL_ALLOW_REGEX = previousRule;
      }
    }
  });
});

function screenshotDeps() {
  return {
    writeFile: jest.fn(async () => {}),
    mkdir: jest.fn(async () => {}),
    resolveScreenshotDir: () => '/screenshots',
    dateNow: () => 123,
    saveFile: saveScreenshotFile,
  };
}
