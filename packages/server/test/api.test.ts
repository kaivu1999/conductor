import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.ts';
import { createVoiceManager } from '../src/voice/manager.ts';
import { createProjects } from '../src/projects.ts';
import { makeHarness, until, REPO } from './helpers/index.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function app() {
  const h = makeHarness();
  h.sup.startScheduler();
  const voice = createVoiceManager({ config: { apiKey: undefined, model: 'm', voice: 'v', baseUrl: 'http://x' } });
  const server = buildServer({ supervisor: h.sup, store: h.store, git: h.git, serveWeb: false, voice, projects: createProjects(null) });
  cleanups.push(async () => { await server.close(); await h.sup.shutdown(); fs.rmSync(h.config.dataDir, { recursive: true, force: true }); });
  return { h, server };
}

describe('POST /api/runs/:id/continue', () => {
  it('sends a ready run back to its agent', async () => {
    const { h, server } = app();
    const run = await h.sup.createRun({ repoPath: REPO, task: 'Add night mode' });
    await until(() => h.store.getRun(run.id)!.state === 'running', 2000, 'running');
    h.git.changes.set(h.store.getRun(run.id)!.worktreePath!, ['src/a.ts']);
    h.agent.last(run.id).finish(true);
    await until(() => h.store.getRun(run.id)!.state === 'ready', 2000, 'ready');

    const res = await server.inject({ method: 'POST', url: `/api/runs/${run.id}/continue`, payload: { text: 'Add a toggle too' } });
    expect(res.statusCode).toBe(200);
    expect(['queued', 'starting', 'running']).toContain(res.json().run.state);
    await until(() => h.agent.last(run.id).opts.followUp === 'Add a toggle too', 2000, 'follow-up delivered');
  });

  it('rejects an empty follow-up and a live run', async () => {
    const { h, server } = app();
    const run = await h.sup.createRun({ repoPath: REPO, task: 'x' });
    await until(() => h.store.getRun(run.id)!.state === 'running', 2000, 'running');
    expect((await server.inject({ method: 'POST', url: `/api/runs/${run.id}/continue`, payload: { text: '' } })).statusCode).toBe(400);
    const live = await server.inject({ method: 'POST', url: `/api/runs/${run.id}/continue`, payload: { text: 'more' } });
    expect(live.statusCode).toBe(409);
    expect(live.json().error).toMatch(/send the agent a message instead/);
  });
});
