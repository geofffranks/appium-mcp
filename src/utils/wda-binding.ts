import {exec} from 'teen_process';

const COMMAND_TIMEOUT_MS = 3000;
const MAX_STDOUT_BYTES = 64 * 1024;

export interface WdaProcessIdentity {
  pid: number;
  birth: string;
  executable: string;
}

export interface WdaCensus {
  listenerPid: number;
  launchctlPid: number;
  process: WdaProcessIdentity;
}

export type WdaCommandRunner = typeof exec;

function singlePid(values: number[], label: string): number {
  if (values.length !== 1 || !Number.isSafeInteger(values[0]) || values[0] <= 0) {
    throw new Error(`WDA ${label} census is ambiguous; preserve the simulator.`);
  }
  return values[0];
}

export function parseLsofListenerPid(output: string, port: number): number {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error('WDA listener port is invalid; preserve the simulator.');
  }
  const pids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^p(\d+)$/.exec(line.trim());
    if (match) {pids.push(Number(match[1]));}
  }
  return singlePid(pids, 'listener');
}

export function parseLaunchctlWdaPid(output: string): number {
  const pids: number[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+\S+\s+.*WebDriverAgentRunner(?:\.xctrunner)?(?:\[|$)/.exec(line);
    if (match) {pids.push(Number(match[1]));}
  }
  return singlePid(pids, 'simulator WDA');
}

export function parseWdaProcess(output: string, expectedPid: number, udid: string): WdaProcessIdentity {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error('WDA process census is ambiguous; preserve the simulator.');
  }
  const match = /^(\d+)\s+(.{24})\s+(.+)$/.exec(lines[0]);
  if (!match) {
    throw new Error('WDA process census is malformed; preserve the simulator.');
  }
  const pid = Number(match[1]);
  const birth = match[2].trim();
  const executable = match[3].trim();
  const devicePath = `/CoreSimulator/Devices/${udid}/`;
  const expectedExecutable = /(?:^|\/)WebDriverAgentRunner-Runner(?:\.app\/)?WebDriverAgentRunner-Runner$/.test(executable);
  if (
    pid !== expectedPid || !birth || !executable.includes(devicePath) || !expectedExecutable ||
    !/^[-A-Fa-f0-9]{36}$/.test(udid)
  ) {
    throw new Error('WDA process does not independently bind to the assigned simulator; preserve the simulator.');
  }
  return {pid, birth, executable};
}

export function parseWdaStatusDevice(status: unknown, assignedUdid: string): void {
  if (!status || typeof status !== 'object' || Array.isArray(status)) {
    throw new Error('Owned WDA endpoint returned malformed status; preserve the simulator.');
  }
  const value = (status as Record<string, unknown>).value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Owned WDA endpoint returned malformed status; preserve the simulator.');
  }
  const device = (value as Record<string, unknown>).device;
  if (device === undefined) {return;}
  if (typeof device === 'string') {
    if (!device.trim()) {throw new Error('Owned WDA endpoint returned malformed device status; preserve the simulator.');}
    return;
  }
  if (!device || typeof device !== 'object' || Array.isArray(device)) {
    throw new Error('Owned WDA endpoint returned malformed device status; preserve the simulator.');
  }
  const explicitUdid = (device as Record<string, unknown>).udid;
  if (explicitUdid !== undefined && explicitUdid !== assignedUdid) {
    throw new Error('WDA status conflicts with the assigned simulator; preserve the simulator.');
  }
}

export async function captureWdaCensus(
  udid: string,
  port: number,
  run: WdaCommandRunner = exec,
): Promise<WdaCensus> {
  if (!/^[-A-Fa-f0-9]{36}$/.test(udid)) {
    throw new Error('Assigned simulator UDID is malformed; preserve the simulator.');
  }
  try {
    const listener = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
      timeout: COMMAND_TIMEOUT_MS,
      maxStdoutBufferSize: MAX_STDOUT_BYTES,
    });
    const listenerPid = parseLsofListenerPid(listener.stdout, port);
    const launchctl = await run('xcrun', ['simctl', 'spawn', udid, 'launchctl', 'list'], {
      timeout: COMMAND_TIMEOUT_MS,
      maxStdoutBufferSize: MAX_STDOUT_BYTES,
    });
    const launchctlPid = parseLaunchctlWdaPid(launchctl.stdout);
    const process = await run('ps', ['-p', String(listenerPid), '-o', 'pid=,lstart=,comm='], {
      timeout: COMMAND_TIMEOUT_MS,
      maxStdoutBufferSize: MAX_STDOUT_BYTES,
    });
    const identity = parseWdaProcess(process.stdout, listenerPid, udid);
    if (launchctlPid !== listenerPid) {
      throw new Error('WDA listener is not the assigned simulator process; preserve the simulator.');
    }
    return {listenerPid, launchctlPid, process: identity};
  } catch (error) {
    if (error instanceof Error && /preserve the simulator/.test(error.message)) {throw error;}
    throw new Error('WDA process census failed; preserve the simulator.', {cause: error});
  }
}

export function sameWdaCensus(left: WdaCensus, right: WdaCensus): boolean {
  return left.listenerPid === right.listenerPid && left.launchctlPid === right.launchctlPid &&
    left.process.pid === right.process.pid && left.process.birth === right.process.birth &&
    left.process.executable === right.process.executable;
}
