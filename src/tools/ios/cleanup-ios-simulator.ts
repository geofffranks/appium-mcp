import type {FastMCP} from 'fastmcp';
import {exec} from 'teen_process';
import {z} from 'zod';

import {textResult} from '../tool-response.js';

const schema = z.object({udid: z.string().describe('The simulator UDID whose WebDriverAgent should be stopped.')});

export async function cleanupOwnedWda(args: z.infer<typeof schema>): Promise<any> {
  await exec('xcrun', ['simctl', 'terminate', args.udid, 'com.facebook.WebDriverAgentRunner.xctrunner'], {timeout: 5000});
  return textResult(JSON.stringify({
    ok: true,
    udid: args.udid,
    message: 'WebDriverAgent was stopped. Device and app data were retained.',
  }));
}

export default function cleanupIosSimulator(server: FastMCP): void {
  server.addTool({
    name: 'cleanup_ios_simulator',
    parameters: schema,
    description:
      'Stop WebDriverAgent on the specified simulator. Does not erase, delete, or shut down the simulator.',
    annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: false},
    execute: cleanupOwnedWda,
  });
}
