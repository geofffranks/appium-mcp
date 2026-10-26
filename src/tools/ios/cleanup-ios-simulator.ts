import type {FastMCP} from 'fastmcp';
import {z} from 'zod';

import {cleanupOwnedSimulatorWda} from '../../utils/simulator-wda-lifecycle.js';
import {textResult} from '../tool-response.js';

const schema = z.object({udid: z.string().describe('The simulator UDID whose WebDriverAgent should be stopped.'), platform: z.enum(['ios', 'tvos']).optional()});

export async function cleanupOwnedWda(args: z.infer<typeof schema>): Promise<any> {
  const stopped = await cleanupOwnedSimulatorWda(args.udid, args.platform);
  return textResult(JSON.stringify({
    ok: stopped,
    udid: args.udid,
    message: stopped
      ? 'The managed WebDriverAgent started by this server was stopped. Device and app data were retained.'
      : 'No managed WebDriverAgent owned by this server is recorded for this simulator; no process was signaled.',
  }));
}

export default function cleanupIosSimulator(server: FastMCP): void {
  server.addTool({
    name: 'cleanup_ios_simulator',
    parameters: schema,
    description:
      'Stop idle WebDriverAgent on the specified iOS or tvOS simulator. Does not erase, delete, or shut down the simulator.',
    annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: false},
    execute: cleanupOwnedWda,
  });
}
