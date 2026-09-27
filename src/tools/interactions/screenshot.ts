import {fs, imageUtil} from '@appium/support';
import type {ContentResult, FastMCP} from 'fastmcp';
import z from 'zod';

import {getScreenshot} from '../../command.js';
import {elementUUIDScheme} from '../../schema.js';
import {resolveScreenshotDir} from '../../utils/paths.js';
import {saveScreenshotFile} from '../../utils/screenshot-file.js';
import {resolveDriver, textResult, errorResult, toolErrorMessage} from '../tool-response.js';

export {resolveScreenshotDir};

export interface ScreenshotDeps {
  mkdir: (dirPath: string, options?: {recursive?: boolean}) => Promise<unknown>;
  resolveScreenshotDir: typeof resolveScreenshotDir;
  dateNow: () => number;
  saveFile: typeof saveScreenshotFile;
}

const defaultDeps: ScreenshotDeps = {
  mkdir: async (dirPath) => await fs.mkdirp(dirPath),
  resolveScreenshotDir,
  dateNow: () => Date.now(),
  saveFile: saveScreenshotFile,
};

export async function executeScreenshot(opts: {
  deps?: ScreenshotDeps;
  elementId?: string;
  maxWidth?: number;
  returnRawBase64?: boolean;
  sessionId?: string;
}): Promise<ContentResult> {
  const {deps = defaultDeps, elementId, maxWidth, returnRawBase64, sessionId} = opts;

  const resolved = await resolveDriver(sessionId);
  if (!resolved.ok) {
    return resolved.result;
  }
  const {driver} = resolved;

  try {
    const screenshotBase64 = await getScreenshot(driver, elementId);

    // Convert base64 to buffer
    const originalBuffer = Buffer.from(screenshotBase64, 'base64');

    // Resize if maxWidth is provided and image is wider
    let screenshotBuffer: Buffer = originalBuffer;
    let displayBase64 = screenshotBase64;
    if (maxWidth !== undefined) {
      const sharp = imageUtil.requireSharp();
      const metadata = await sharp(originalBuffer).metadata();
      if (metadata.width !== undefined && metadata.width > maxWidth) {
        const resizedBuffer = await sharp(originalBuffer).resize({width: maxWidth}).png().toBuffer();
        screenshotBuffer = Buffer.from(resizedBuffer);
        displayBase64 = screenshotBuffer.toString('base64');
      }
    }

    // Return the raw base64 image without touching the disk. Useful when the
    // server runs on a remote machine where the saved file is not reachable.
    if (returnRawBase64) {
      return {
        content: [
          {
            type: 'image',
            data: displayBase64,
            mimeType: 'image/png',
          },
        ],
      };
    }

    if (
      screenshotBuffer.length < 8 ||
      !screenshotBuffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    ) {
      throw new Error('Captured screenshot is not a PNG image');
    }

    // Generate filename with timestamp
    const timestamp = deps.dateNow();
    const screenshotDir = deps.resolveScreenshotDir();

    // Create a directory if it doesn't exist
    await deps.mkdir(screenshotDir, {recursive: true});

    const {filepath, sha256} = await deps.saveFile(screenshotDir, timestamp, screenshotBuffer);
    const textResponse = textResult(
      `Screenshot saved successfully. filepath=${filepath}; mimeType=image/png; width=${screenshotBuffer.readUInt32BE(16)}; height=${screenshotBuffer.readUInt32BE(20)}; bytes=${screenshotBuffer.length}; sha256=${sha256}`,
    );

    // Saved-mode responses intentionally include only bounded metadata; image
    // bytes are available at filepath and are never copied into response data.
    return textResponse;
  } catch (err: unknown) {
    return errorResult(`Failed to take screenshot. err: ${toolErrorMessage(err)}`);
  }
}

const screenshotSchema = z.object({
  elementUUID: elementUUIDScheme.optional().describe('Capture this element; omit for the full screen.'),
  maxWidth: z.number().optional().describe('Resize to at most this width in pixels, preserving aspect ratio.'),
  returnRawBase64: z
    .boolean()
    .default(false)
    .describe(
      'Return inline PNG instead of saving, for explicit manual use when the server file is inaccessible. ' +
        'LLMs must keep false and use the saved path.',
    ),
  sessionId: z.string().optional().describe('Session ID; defaults to the active session.'),
});

export default function screenshot(server: FastMCP): void {
  server.addTool({
    name: 'appium_screenshot',
    description: 'Take a screenshot and save as PNG. Optionally provide elementUUID to capture only that element.',
    parameters: screenshotSchema,
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
    },
    execute: async (
      args: z.infer<typeof screenshotSchema>,
      _context: Record<string, unknown> | undefined,
    ): Promise<ContentResult> =>
      executeScreenshot({
        elementId: args.elementUUID,
        maxWidth: args.maxWidth,
        returnRawBase64: args.returnRawBase64,
        sessionId: args.sessionId,
      }),
  });
}
