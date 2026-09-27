import {createHash} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {lstat, mkdtemp, open, readFile, readdir, rm, stat, symlink, unlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {describe, expect, jest, test} from '@jest/globals';

import {saveScreenshotFile} from '../../utils/screenshot-file.js';

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const UUID_A = '00000000-0000-4000-8000-00000000000a';
const UUID_B = '00000000-0000-4000-8000-00000000000b';

const realDeps = {open, unlink, randomUUID: (): typeof UUID_A => UUID_A, lstat};

describe('saveScreenshotFile', () => {
  test('creates a randomized exclusive 0600 file and hashes readback from its open handle', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'appium-screenshot-file-'));
    try {
      const openSpy = jest.fn(open);
      const result = await saveScreenshotFile(directory, 42, png, {...realDeps, open: openSpy});
      const saved = await readFile(result.filepath);
      const info = await stat(result.filepath);

      expect(result.filepath).toBe(join(directory, `screenshot_42_${UUID_A}.png`));
      expect(saved).toEqual(png);
      expect(info.mode & 0o777).toBe(0o600);
      expect(openSpy).toHaveBeenCalledWith(
        result.filepath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
        0o600,
      );
      expect(result.sha256).toBe(createHash('sha256').update(saved).digest('hex'));
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  test('does not replace a symlink and retries an existing randomized name', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'appium-screenshot-file-'));
    const target = join(directory, 'target');
    const collision = join(directory, `screenshot_42_${UUID_A}.png`);
    await writeFile(target, 'unchanged');
    await symlink(target, collision);
    let names: `${string}-${string}-${string}-${string}-${string}`[] = [UUID_A, UUID_B];
    try {
      await expect(
        saveScreenshotFile(directory, 42, png, {...realDeps, randomUUID: (): typeof UUID_A => UUID_A}),
      ).rejects.toThrow('Refusing to replace a screenshot symlink');
      await unlink(collision);
      const result = await saveScreenshotFile(directory, 42, png, {
        ...realDeps,
        randomUUID: (): `${string}-${string}-${string}-${string}-${string}` => names.shift() ?? UUID_B,
      });
      expect(result.filepath).toBe(collision);
      expect(await readFile(target, 'utf8')).toBe('unchanged');
      expect((await readdir(directory)).sort()).toEqual([`screenshot_42_${UUID_A}.png`, 'target']);
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });

  test('cleans up a newly created file when verification fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'appium-screenshot-file-'));
    const filepath = join(directory, `screenshot_42_${UUID_A}.png`);
    try {
      await expect(
        saveScreenshotFile(directory, 42, png, {
          ...realDeps,
          open: (async (...args: Parameters<typeof open>) => {
            const handle = await open(...args);
            return {
              writeFile: async (bytes: Buffer) => await handle.writeFile(bytes),
              sync: async () => await handle.sync(),
              read: async (buffer: Buffer, offset: number, length: number, position: number) => {
                const result = await handle.read(buffer, offset, length, position);
                buffer[0] = 0;
                return result;
              },
              close: async () => await handle.close(),
            };
          }) as unknown as typeof open,
        }),
      ).rejects.toThrow('Saved screenshot verification failed');
      expect(await readdir(directory)).toEqual([]);
      await expect(lstat(filepath)).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });
});
