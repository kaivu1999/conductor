import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './contracts.ts';

function int(env: NodeJS.ProcessEnv, key: string, def: number, min = 1): number {
  const raw = env[key];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new Error(`${key}=${raw} is invalid; expected an integer >= ${min}`);
  return n;
}

/**
 * Env overrides; creates dataDir and worktreeRoot. Throws a readable error on bad values.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.CONDUCTOR_HOME?.trim() ? env.CONDUCTOR_HOME.trim() : path.join(os.homedir(), '.conductor');
  const dataDir = path.resolve(home.startsWith('~/') ? path.join(os.homedir(), home.slice(2)) : home);
  const worktreeRoot = path.join(dataDir, 'worktrees');
  let maxBudgetUsd: number | undefined;
  if (env.CONDUCTOR_MAX_BUDGET_USD) {
    maxBudgetUsd = Number(env.CONDUCTOR_MAX_BUDGET_USD);
    if (!Number.isFinite(maxBudgetUsd) || maxBudgetUsd <= 0) {
      throw new Error(`CONDUCTOR_MAX_BUDGET_USD=${env.CONDUCTOR_MAX_BUDGET_USD} is invalid; expected a positive number`);
    }
  }
  const config: Config = {
    dataDir,
    worktreeRoot,
    dbPath: path.join(dataDir, 'conductor.db'),
    port: int(env, 'CONDUCTOR_PORT', 4317, 0),
    maxConcurrent: int(env, 'CONDUCTOR_MAX_CONCURRENT', 4),
    testTimeoutMs: int(env, 'CONDUCTOR_TEST_TIMEOUT_MS', 300_000),
    maxBudgetUsd,
  };
  fs.mkdirSync(worktreeRoot, { recursive: true });
  return config;
}
