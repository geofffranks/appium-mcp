import {createHash, randomUUID} from 'node:crypto';
import {constants as fsConstants} from 'node:fs';
import {lstat, open, unlink} from 'node:fs/promises';
import {join} from 'node:path';

const PNG_FILE_MODE = 0o600;

export interface ScreenshotFileDeps {
  open: typeof open;
  unlink: typeof unlink;
  randomUUID: typeof randomUUID;
  lstat: typeof lstat;
}

const defaultDeps: ScreenshotFileDeps = {open, unlink, randomUUID, lstat};

/** Exclusively create a private PNG and hash bytes read back from that same file handle. */
export async function saveScreenshotFile(
  directory: string,
  timestamp: number,
  data: Buffer,
  deps: ScreenshotFileDeps = defaultDeps,
): Promise<{filepath: string; sha256: string}> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const filepath = join(directory, `screenshot_${timestamp}_${deps.randomUUID()}.png`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let created = false;
    try {
      try {
        if ((await deps.lstat(filepath)).isSymbolicLink()) {
          throw new Error('Refusing to replace a screenshot symlink');
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      handle = await deps.open(
        filepath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
        PNG_FILE_MODE,
      );
      created = true;
      await handle.writeFile(data);
      await handle.sync();
      const savedBytes = Buffer.alloc(data.length);
      const {bytesRead} = await handle.read(savedBytes, 0, savedBytes.length, 0);
      if (bytesRead !== data.length || !savedBytes.equals(data)) {
        throw new Error('Saved screenshot verification failed');
      }
      return {filepath, sha256: createHash('sha256').update(savedBytes).digest('hex')};
    } catch (error) {
      if (created) {
        try {
          await deps.unlink(filepath);
        } catch {
          // Preserve the original write/verification error.
        }
      }
      if (!created && (error as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }
  throw new Error('Unable to create a unique screenshot file');
}
