import type { AgentAdapter } from '../contracts.ts';
import { createClaudeAdapter } from './claude.ts';
import { createFakeAdapter } from './fake.ts';

export { createClaudeAdapter, buildSystemAppend, type ClaudeAdapterOptions } from './claude.ts';
export { createFakeAdapter, DEFAULT_FAKE_SCRIPT, type FakeScript, type FakeStep, type FakeAdapterOptions } from './fake.ts';
export { describeToolUse, firstSentence, normalizeText, resultErrorMessage, ASK_TOOL_NAME } from './activity.ts';
export { isAlive, killGroup, findRunProcesses, killRunProcesses, RUN_ENV_MARKER } from './process.ts';

/** CONDUCTOR_AGENT=fake -> deterministic fake adapter; otherwise the real Claude adapter. */
export function createAdapterFromEnv(env: NodeJS.ProcessEnv = process.env): AgentAdapter {
  if (env.CONDUCTOR_AGENT === 'fake') return createFakeAdapter();
  return createClaudeAdapter(env.CONDUCTOR_MODEL ? { model: env.CONDUCTOR_MODEL } : {});
}
