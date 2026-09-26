import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Credentials for agent runs. We run the CLI with `settingSources: []` so the user's
 * personal hooks/plugins/CLAUDE.md don't leak into agent runs — but that also drops
 * their auth. So we lift exactly two things out of ~/.claude/settings.json:
 *   - `apiKeyHelper`  -> passed back via `settings` (inline JSON)
 *   - `env`           -> merged into the child env (gateway base URL, model aliases, …)
 */
export interface AgentAuth {
  /** Value for Options.settings (inline JSON), or undefined. */
  settings: string | undefined;
  /** Full env for the CLI child process. */
  env: Record<string, string | undefined>;
}

let cached: { apiKeyHelper?: string; env: Record<string, string> } | null = null;

export function readUserSettings(file = path.join(os.homedir(), '.claude', 'settings.json')): {
  apiKeyHelper?: string;
  env: Record<string, string>;
} {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return { env: {} };
    const r = raw as Record<string, unknown>;
    const env: Record<string, string> = {};
    if (r.env && typeof r.env === 'object') {
      for (const [k, v] of Object.entries(r.env as Record<string, unknown>)) {
        if (v !== undefined && v !== null) env[k] = String(v);
      }
    }
    return { apiKeyHelper: typeof r.apiKeyHelper === 'string' ? r.apiKeyHelper : undefined, env };
  } catch {
    return { env: {} };
  }
}

export function getAgentAuth(): AgentAuth {
  cached ??= readUserSettings();
  return {
    settings: cached.apiKeyHelper ? JSON.stringify({ apiKeyHelper: cached.apiKeyHelper }) : undefined,
    // Tool search adds an extra model round-trip before every MCP call; disable it.
    env: { ...process.env, ...cached.env, ENABLE_TOOL_SEARCH: 'false' },
  };
}
