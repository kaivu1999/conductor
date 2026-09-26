/**
 * Pure, deterministic mapping from raw agent output to the short lines the user sees.
 * No LLM involved. Heavily unit-tested in test/agent.test.ts.
 */
import path from 'node:path';

export const ASK_TOOL_NAME = 'mcp__conductor__ask_user';

export interface ToolDescription {
  /** "what it's doing now" line, e.g. "Reading src/foo.ts" */
  activity: string;
  /** timeline entry, e.g. "Read src/foo.ts" */
  summary: string;
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim();

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/**
 * Make a path relative to cwd when it lives inside it; otherwise leave it as-is.
 * `cwd` may be several equivalent roots (e.g. [cwd, realpath(cwd)] — on macOS the
 * agent reports /private/tmp/... for a cwd of /tmp/...).
 */
export function relPath(p: unknown, cwd: string | readonly string[]): string {
  if (typeof p !== 'string' || !p) return '';
  if (!path.isAbsolute(p)) return p;
  for (const root of typeof cwd === 'string' ? [cwd] : cwd) {
    const rel = path.relative(root, p);
    if (rel === '') return '.';
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return p;
}

/** Absolute paths inside a shell command, shortened relative to cwd ("cat /w/repo/a.ts" -> "cat a.ts"). */
export function relCommand(cmd: string, cwd: string | readonly string[]): string {
  const roots = (typeof cwd === 'string' ? [cwd] : [...cwd]).filter((r) => r && r !== '/').sort((a, b) => b.length - a.length);
  let out = cmd;
  for (const r of roots) {
    const root = r.endsWith('/') ? r.slice(0, -1) : r;
    out = out.split(root + '/').join('').replace(new RegExp(escapeRe(root) + '(?=[\\s\'"]|$)', 'g'), '.');
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Convert "mcp__server__tool" / "SomeTool" into a readable name for the fallback. */
function prettyToolName(name: string): string {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return `${m[2]} (${m[1]})`;
  return name;
}

export function describeToolUse(name: string, rawInput: unknown, cwd: string | readonly string[]): ToolDescription {
  const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, unknown>;
  switch (name) {
    case 'Read': {
      const p = relPath(input.file_path, cwd);
      return { activity: `Reading ${p}`, summary: `Read ${p}` };
    }
    case 'Edit':
    case 'MultiEdit': {
      const p = relPath(input.file_path, cwd);
      return { activity: `Editing ${p}`, summary: `Edit ${p}` };
    }
    case 'NotebookEdit': {
      const p = relPath(input.notebook_path ?? input.file_path, cwd);
      return { activity: `Editing ${p}`, summary: `Edit ${p}` };
    }
    case 'Write': {
      const p = relPath(input.file_path, cwd);
      return { activity: `Writing ${p}`, summary: `Write ${p}` };
    }
    case 'Bash': {
      const cmd = truncate(collapse(relCommand(str(input.command), cwd)), 60);
      const desc = collapse(str(input.description));
      return {
        activity: desc ? bashActivity(desc) : `Running \`${cmd}\``,
        summary: `Run \`${cmd}\``,
      };
    }
    case 'Grep': {
      const pat = truncate(collapse(str(input.pattern)), 60);
      return { activity: `Searching for \`${pat}\``, summary: `Search \`${pat}\`` };
    }
    case 'Glob': {
      const pat = truncate(collapse(str(input.pattern)), 60);
      return { activity: `Finding files \`${pat}\``, summary: `Find files \`${pat}\`` };
    }
    case 'WebFetch': {
      const host = hostOf(str(input.url));
      return { activity: `Fetching ${host}`, summary: `Fetch ${truncate(str(input.url), 100)}` };
    }
    case 'WebSearch': {
      const q = truncate(collapse(str(input.query)), 80);
      return { activity: `Searching the web: ${q}`, summary: `Web search: ${q}` };
    }
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? (input.todos as Record<string, unknown>[]) : [];
      const active = todos.find((t) => t && t.status === 'in_progress');
      const text = active ? collapse(str(active.content) || str(active.activeForm)) : '';
      if (text) {
        const t = truncate(text, 90);
        return { activity: `Working on: ${t}`, summary: `Todo: ${t}` };
      }
      return { activity: 'Updating the plan', summary: `Update todos (${todos.length})` };
    }
    case 'Task':
    case 'Agent': {
      const d = truncate(collapse(str(input.description) || str(input.subagent_type) || 'subtask'), 80);
      return { activity: `Delegating: ${d}`, summary: `Delegate: ${d}` };
    }
    case ASK_TOOL_NAME: {
      const q = truncate(collapse(str(input.question)), 100);
      return { activity: 'Waiting for your answer', summary: q ? `Ask: ${q}` : 'Ask the user' };
    }
    default: {
      const n = prettyToolName(name);
      return { activity: `Using ${n}`, summary: `Use ${n}` };
    }
  }
}

/**
 * Bash `description` is usually imperative ("Run tests", "Install dependencies").
 * "Run X" becomes "Running X"; anything else is shown as written.
 */
function bashActivity(desc: string): string {
  const d = truncate(desc, 80);
  const m = /^(?:run|running)\s+(.+)$/i.exec(d);
  if (m) return `Running ${m[1]}`;
  return d.charAt(0).toUpperCase() + d.slice(1);
}

/** Assistant prose for the timeline: trimmed, capped. Empty string = nothing to emit. */
export function normalizeText(text: string, max = 500): string {
  return truncate(text.trim(), max);
}

/** First sentence of assistant prose, as an activity line. */
export function firstSentence(text: string, max = 100): string {
  const t = collapse(text.replace(/[#*_`>]+/g, ' '));
  if (!t) return '';
  const m = /^(.+?[.!?])(\s|$)/.exec(t);
  const s = m ? m[1]! : t;
  return truncate(s, max);
}

export interface ResultLike {
  subtype: string;
  is_error?: boolean;
  result?: string;
  errors?: string[];
  num_turns?: number;
  total_cost_usd?: number;
  terminal_reason?: string;
  api_error_status?: number | null;
}

/** Readable message for a failed result, or null when the result is a success. */
export function resultErrorMessage(r: ResultLike): string | null {
  const extra = r.errors?.filter(Boolean).join('; ');
  switch (r.subtype) {
    case 'success':
      if (!r.is_error) return null;
      return `Agent API error${r.api_error_status ? ` (HTTP ${r.api_error_status})` : ''}: ${truncate(collapse(r.result || extra || 'unknown error'), 300)}`;
    case 'error_max_budget_usd':
      return `Budget exceeded ($${(r.total_cost_usd ?? 0).toFixed(2)} spent)`;
    case 'error_max_turns':
      return `Hit the max turn limit (${r.num_turns ?? '?'} turns)`;
    case 'error_during_execution':
      return `Agent error during execution${extra ? `: ${truncate(collapse(extra), 300)}` : ''}`;
    case 'error_max_structured_output_retries':
      return 'Agent failed to produce structured output';
    default:
      return `Agent stopped: ${r.subtype}${extra ? ` — ${truncate(collapse(extra), 300)}` : ''}`;
  }
}
