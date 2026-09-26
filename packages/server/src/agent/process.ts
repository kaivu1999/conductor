import fs from 'node:fs';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';

/** True if a process (or process group, for negative pid) exists. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Signal a whole process group (the child was spawned detached, so pgid == pid). Falls back to the pid. */
export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
}

export function exited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Resolves when the child has exited (immediately if it already has). */
export function waitForExit(child: ChildProcess, timeoutMs?: number): Promise<boolean> {
  if (exited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = () => {
      if (timer) clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', done);
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => {
        child.off('exit', done);
        resolve(exited(child));
      }, timeoutMs);
    }
  });
}

/**
 * Stop a detached child: optional grace wait, then SIGKILL the process group.
 * Resolves once the child has exited.
 */
export async function killTree(child: ChildProcess, graceMs: number): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) return;
  if (!exited(child) && graceMs > 0) await waitForExit(child, graceMs);
  // Kill the group even if the leader exited: grandchildren (e.g. Bash tool processes) may linger.
  killGroup(pid, 'SIGKILL');
  await waitForExit(child, 5000);
}

/** Spawn a long-lived placeholder child in its own process group (used by the fake adapter). */
export function spawnPlaceholder(cwd: string, runId: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], {
    cwd,
    env: { ...process.env, [RUN_ENV_MARKER]: runId },
    stdio: 'ignore',
    detached: true,
  });
  child.on('error', () => {});
  return child;
}

// ─── env-marker based discovery ─────────────────────────────────────────────
//
// The Claude CLI's Bash tool runs each command in a NEW process group (verified with
// SDK 0.3.283: tool shell pgid != CLI pid). So `kill(-cliPid)` does NOT reach tool
// processes, and if the CLI is SIGKILLed they are re-parented to init and survive.
// Environment variables ARE inherited though, so every agent process tree carries
// RUN_ENV_MARKER=<runId>; this finds and kills them regardless of group/parent.


export const RUN_ENV_MARKER = 'CONDUCTOR_RUN_ID';

/** Pids (other than ours) whose environment has CONDUCTOR_RUN_ID=<runId> (or any run, if runId omitted). */
export function findRunProcesses(runId?: string): { pid: number; runId: string }[] {
  const out: { pid: number; runId: string }[] = [];
  const re = new RegExp(`(?:^|[\\s\\0])${RUN_ENV_MARKER}=([A-Za-z0-9_.-]+)`);
  const add = (pid: number, env: string) => {
    if (pid === process.pid) return;
    const m = re.exec(env);
    if (m && (runId === undefined || m[1] === runId)) out.push({ pid, runId: m[1]! });
  };
  if (fs.existsSync('/proc/self/environ')) {
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        add(Number(d), fs.readFileSync(`/proc/${d}/environ`, 'latin1'));
      } catch {
        /* gone or not ours */
      }
    }
    return out;
  }
  let ps = '';
  try {
    // BSD/macOS: `e` appends the environment to the command column (own processes only).
    ps = execFileSync('ps', ['-A', '-ww', '-E', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch {
    try {
      ps = execFileSync('ps', ['eww', '-A', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    } catch {
      return out;
    }
  }
  for (const line of ps.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) add(Number(m[1]), m[2]!);
  }
  return out;
}

/** SIGKILL every process (and its group) tagged with this run id. Returns how many were signalled. */
export function killRunProcesses(runId: string): number {
  const procs = findRunProcesses(runId);
  for (const p of procs) killGroup(p.pid, 'SIGKILL');
  return procs.length;
}
