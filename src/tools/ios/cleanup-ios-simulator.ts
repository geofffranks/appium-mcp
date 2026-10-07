import {realpath} from 'node:fs/promises';

import type {FastMCP} from 'fastmcp';
import {exec} from 'teen_process';
import {z} from 'zod';

import {callEffortAuthority} from '../../utils/effort-authority.js';
import {admissionResult} from '../../utils/managed-tool-guard.js';
import {textResult} from '../tool-response.js';

const schema = z.object({
  effortToken: z.string(),
  worktree: z.string(),
  operationId: z.string(),
  udid: z.string(),
});

export async function cleanupOwnedWda(args: z.infer<typeof schema>): Promise<any> {
  try {
    const status = await callEffortAuthority('status', {});
    const record = status.record;
    if (!record || record.worktree !== (await realpath(args.worktree)) || record.udid !== args.udid) {
      return admissionResult({
        ok: false,
        status: 'denied',
        message: 'Cleanup must match the assigned worktree and simulator; nothing stopped.',
      });
    }
    const resources = Array.isArray(record.resources) ? record.resources : [];
    if (resources.some((r: any) => r.kind === 'appiumSession')) {
      return admissionResult({
        ok: false,
        status: 'denied',
        message: 'Delete explicitly targeted owned Appium sessions before stopping WDA; nothing stopped.',
      });
    }
    const wdas = resources.filter((r: any) => r.kind === 'wda');
    for (const resource of wdas) {
      if (!resource.owned || resource.pending || resource.udid !== args.udid || typeof resource.bundleId !== 'string') {
        return admissionResult({
          ok: false,
          status: 'recovery_required',
          message: 'WDA identity is uncertain; preserve it and reconcile.',
        });
      }
      await exec('xcrun', ['simctl', 'terminate', args.udid, resource.bundleId], {timeout: 5000});
      const removed = await callEffortAuthority('resource-remove', {
        token: args.effortToken,
        operationId: args.operationId,
        id: resource.id,
      });
      if (!removed.ok) {
        return admissionResult({
          ok: false,
          status: 'recovery_required',
          message: 'WDA absence could not be verified; preserve ownership and reconcile.',
        });
      }
    }
    return textResult(
      JSON.stringify({
        ok: true,
        udid: args.udid,
        stoppedOwnedWda: wdas.length,
        message: 'Only registered owned WDA was stopped. Device and app data were retained.',
      }),
    );
  } catch {
    return admissionResult({
      ok: false,
      status: 'recovery_required',
      message: 'Owned WDA cleanup could not be verified; preserve ownership and reconcile.',
    });
  }
}

export default function cleanupIosSimulator(server: FastMCP): void {
  server.addTool({
    name: 'cleanup_ios_simulator',
    parameters: schema,
    description:
      'Stop only the effort-created WDA after explicit owned Appium sessions have been deleted. Requires effortToken, canonical worktree, assigned UDID and stable operationId. Does not erase, delete, or shut down the simulator; use the host owned-shutdown/release sequence afterward.',
    annotations: {readOnlyHint: false, destructiveHint: true, openWorldHint: false},
    execute: cleanupOwnedWda,
  });
}
