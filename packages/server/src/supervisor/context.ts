import type { Config, Git, Store } from '../contracts.ts';
import type { Logger } from './errors.ts';
import type { Writer } from './writer.ts';

/**
 * Finds / kills processes tagged with CONDUCTOR_RUN_ID (the agent adapter tags every
 * process tree it spawns). Needed because the agent's Bash tool puts commands in their own
 * process groups, so killing the agent's group alone leaves e.g. dev servers behind.
 * Injected so tests never touch real processes.
 */
export interface ProcessControl {
  findRunProcesses(runId?: string): { pid: number; runId: string }[];
  /** SIGKILLs every process tagged with runId; returns how many it signalled. */
  killRunProcesses(runId: string): number;
}

export const noProcessControl: ProcessControl = {
  findRunProcesses: () => [],
  killRunProcesses: () => 0,
};

/** What recovery/reaper/overlap code needs; the lifecycle code in supervisor.ts owns the rest. */
export interface SupervisorContext {
  store: Store;
  git: Git;
  config: Config;
  log: Logger;
  w: Writer;
  processes: ProcessControl;
  /** Run ids this process currently has in flight (starting/finishing/accepting); never reap these. */
  busy(runId: string): boolean;
}
