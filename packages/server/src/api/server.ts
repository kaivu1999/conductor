/**
 * HTTP + SSE. Thin: validate input, call the supervisor/store/git, map errors. All
 * lifecycle rules live in the supervisor.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import fastifyStatic from '@fastify/static';
import { z } from 'zod';
import { sortByAttention, type Run } from '@conductor/shared';
import type { Git, Store } from '../contracts.ts';
import type { ConductorSupervisor } from '../supervisor/supervisor.ts';
import { notFound, conflict } from '../supervisor/errors.ts';
import { toHttpError } from './errors.ts';
import { createSseHub } from './sse.ts';
import { loadVoiceConfig } from '../voice/live.ts';
import { createVoiceManager, voiceLog, type VoiceManager } from '../voice/manager.ts';
import { createOrchestrator } from '../voice/orchestrator.ts';
import { createAttentionWatcher, NUDGE_STATES, toNotice } from '../voice/notifier.ts';

export interface ServerDeps {
  supervisor: ConductorSupervisor;
  store: Store;
  git: Git;
  /** Serve the built web app (default: NODE_ENV === 'production'). */
  serveWeb?: boolean;
  webDist?: string;
  logger?: boolean;
  systemEveryMs?: number;
  /** Voice sessions (default: GPT-Live configured from process.env). */
  voice?: VoiceManager;
}

const CreateRunBody = z.object({
  repoPath: z.string().trim().min(1, 'repoPath is required'),
  task: z.string().trim().min(1, 'task is required').max(100_000),
  baseBranch: z.string().trim().min(1).optional(),
  testCommand: z.string().trim().min(1).optional(),
});
const AnswerBody = z.object({ questionId: z.string().min(1), answer: z.string().trim().min(1, 'answer is empty') });
const MessageBody = z.object({ text: z.string().trim().min(1, 'message is empty') });
const AcceptBody = z.object({ mode: z.enum(['merge', 'branch']).default('merge') }).default({});
const IdParams = z.object({ id: z.string().min(1) });
const EventsQuery = z.object({ after: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(5000).default(1000) });
const VoiceSessionBody = z.object({ sdp: z.string().min(1, 'sdp is required').max(100_000) });
const InspectQuery = z.object({ path: z.string().trim().min(1, 'path is required') });

const DEFAULT_WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist');

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { supervisor, store, git } = deps;
  // The hub is created below; screen commands only fire later, from voice turns.
  const voice = deps.voice ?? createVoiceManager({
    config: loadVoiceConfig(),
    backend: createOrchestrator({
      store, supervisor, git, log: voiceLog, systemInfo: () => supervisor.systemInfo(),
      model: process.env.CONDUCTOR_VOICE_AGENT_MODEL?.trim() || undefined,
      screen: (command) => hub.broadcast({ type: 'voice', command }),
    }),
    initialNotices: () => sortByAttention(store.listRuns()).filter((r) => NUDGE_STATES.includes(r.state)).map(toNotice),
  });
  const app = Fastify({ logger: deps.logger ?? false, bodyLimit: 1024 * 1024 });

  const getRun = (id: string): Run => {
    const run = store.getRun(id);
    if (!run) throw notFound(`Run ${id} not found.`);
    return run;
  };

  app.setErrorHandler((err, req, reply) => {
    const { status, error, expected } = toHttpError(err);
    if (!expected) req.log.error({ err }, 'request failed');
    if (!expected && !deps.logger) console.error(`[api] ${req.method} ${req.url} failed:`, err);
    void reply.status(status).send({ error });
  });

  // ─── SSE ───────────────────────────────────────────────────────────────────
  const hub = createSseHub({ snapshot: async () => ({ type: 'system', system: await supervisor.systemInfo() }) });
  supervisor.on('run', (run) => hub.broadcast({ type: 'run', run }));
  supervisor.on('event', (event) => hub.broadcast({ type: 'event', event }));
  const watchAttention = createAttentionWatcher(store.listRuns({ includeTerminal: true }), (n) => voice.notify(n));
  supervisor.on('run', (run) => { voice.runChanged(run); watchAttention(run); });
  const systemTimer = setInterval(() => {
    if (!hub.size) return;
    supervisor.systemInfo().then((system) => hub.broadcast({ type: 'system', system }), () => {});
  }, deps.systemEveryMs ?? 10_000);
  systemTimer.unref();
  // preClose, not onClose: hijacked SSE sockets would otherwise keep server.close() waiting forever.
  app.addHook('preClose', async () => {
    clearInterval(systemTimer);
    hub.close();
    await voice.closeAll();
  });

  // ─── routes ────────────────────────────────────────────────────────────────
  app.register(async (api) => {
    api.get('/runs', async () => ({ runs: sortByAttention(store.listRuns()) }));

    api.post('/runs', async (req, reply) => {
      const body = CreateRunBody.parse(req.body ?? {});
      const run = await supervisor.createRun(body);
      return reply.status(201).send({ run });
    });

    api.get('/runs/:id', async (req) => ({ run: getRun(IdParams.parse(req.params).id) }));

    api.get('/runs/:id/events', async (req) => {
      const { id } = IdParams.parse(req.params);
      getRun(id);
      const { after, limit } = EventsQuery.parse(req.query);
      return { events: store.listEvents(id, after, limit) };
    });

    api.get('/runs/:id/diff', async (req) => {
      const run = getRun(IdParams.parse(req.params).id);
      if (!run.worktreePath || !run.baseCommit) {
        throw conflict(run.state === 'accepted' || run.state === 'rejected'
          ? `This run was ${run.state} and its worktree has been cleaned up.`
          : 'This run has no worktree yet.');
      }
      const files = await git.diff(run.worktreePath, run.baseCommit);
      return { runId: run.id, base: run.baseCommit, head: run.branch, files };
    });

    api.post('/runs/:id/answer', async (req) => {
      const { id } = IdParams.parse(req.params);
      const { questionId, answer } = AnswerBody.parse(req.body ?? {});
      return { run: supervisor.answer(id, questionId, answer) };
    });

    api.post('/runs/:id/message', async (req) => {
      const { id } = IdParams.parse(req.params);
      const { text } = MessageBody.parse(req.body ?? {});
      return { run: supervisor.message(id, text) };
    });

    api.post('/runs/:id/cancel', async (req) => ({ run: await supervisor.cancel(IdParams.parse(req.params).id) }));
    api.post('/runs/:id/restart', async (req) => ({ run: supervisor.restart(IdParams.parse(req.params).id) }));

    api.post('/runs/:id/accept', async (req) => {
      const { id } = IdParams.parse(req.params);
      const { mode } = AcceptBody.parse(req.body ?? {});
      return { run: await supervisor.accept(id, mode) };
    });

    api.post('/runs/:id/reject', async (req) => ({ run: await supervisor.reject(IdParams.parse(req.params).id) }));

    api.get('/repos/inspect', async (req) => git.inspectRepo(InspectQuery.parse(req.query).path));

    api.get('/system', async () => supervisor.systemInfo());

    api.post('/voice/session', async (req) => {
      const { sdp } = VoiceSessionBody.parse(req.body ?? {});
      return voice.open(sdp);
    });

    api.get('/stream', (req, reply: FastifyReply) => hub.handle(req, reply));

    api.all('/*', async (req, reply) => reply.status(404).send({ error: `No such endpoint: ${req.method} ${req.url}` }));
  }, { prefix: '/api' });

  // ─── web app (production) ──────────────────────────────────────────────────
  const serveWeb = deps.serveWeb ?? process.env.NODE_ENV === 'production';
  if (serveWeb) {
    const root = deps.webDist ?? DEFAULT_WEB_DIST;
    if (fs.existsSync(path.join(root, 'index.html'))) {
      app.register(fastifyStatic, { root, wildcard: false });
      // SPA fallback: unknown non-API GETs get index.html so client-side routes work on reload.
      app.setNotFoundHandler((req, reply) => {
        if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
        return reply.status(404).send({ error: `No such endpoint: ${req.method} ${req.url}` });
      });
    } else {
      console.warn(`[api] web UI not found at ${root}; run \`pnpm --filter @conductor/web build\` (API still works).`);
      app.get('/', async (_req, reply) => reply.type('text/plain').send(`Conductor API is running. Web UI not built: run \`pnpm --filter @conductor/web build\`.\n`));
    }
  }

  return app;
}
