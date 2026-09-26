/**
 * OS process helpers for recovery. Kept separate from agent/ on purpose: the supervisor
 * must be able to find and kill an orphaned agent group from a *previous* conductor
 * process, where no ChildProcess handle exists — only the pid we persisted.
 */
import { execFile } from 'node:child_process';

/** True if the process (or, for a negative pid, the process group) exists. EPERM = exists but not ours to signal. */
export function pidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Start time of `pid` in epoch ms, via `ps -o lstart=` (macOS + Linux). lstart has
 * one-second resolution. Returns null if the process is gone or ps can't tell us.
 */
export function processStartTime(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { env: { ...process.env, LC_ALL: 'C', LANG: 'C' }, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const text = stdout.trim().replace(/\s+/g, ' ');
      if (!text) return resolve(null);
      const ms = Date.parse(text); // "Sat Sep 26 18:20:49 2026", local time
      resolve(Number.isFinite(ms) ? ms : null);
    });
  });
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM the group, wait up to `graceMs` for it to go away, then SIGKILL it. */
export async function terminateGroup(pid: number, graceMs = 3000): Promise<void> {
  signalGroup(pid, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!pidExists(pid) && !pidExists(-pid)) return;
    await sleep(100);
  }
  signalGroup(pid, 'SIGKILL');
  // Give the kernel a moment so the caller's "killed" count reflects reality.
  for (let i = 0; i < 20 && (pidExists(pid) || pidExists(-pid)); i++) await sleep(50);
}

export type OrphanVerdict = 'gone' | 'killed' | 'pid_reused' | 'unverifiable';

/** Allowed skew between the recorded spawn time and ps' (1s-resolution) start time. */
export const PID_START_TOLERANCE_MS = 5000;

/**
 * Kill a previous conductor's agent process group, but only if we can show it is ours.
 * - Leader alive: its start time must match `startedAt` (else the pid was reused -> leave it).
 * - Leader gone but the group still exists: POSIX never reuses a pid while a process group
 *   with that id exists, so the group is still the one our agent created -> kill it.
 */
export async function killOrphan(pid: number, startedAt: number | null, graceMs = 3000): Promise<OrphanVerdict> {
  if (pid <= 1 || pid === process.pid) return 'unverifiable';
  if (!pidExists(pid)) {
    if (pidExists(-pid)) {
      await terminateGroup(pid, graceMs);
      return 'killed';
    }
    return 'gone';
  }
  if (startedAt == null) return 'unverifiable';
  const actual = await processStartTime(pid);
  if (actual == null) return pidExists(pid) ? 'unverifiable' : 'gone';
  if (Math.abs(actual - startedAt) > PID_START_TOLERANCE_MS) return 'pid_reused';
  await terminateGroup(pid, graceMs);
  return 'killed';
}
