import type {
  AcceptBody, CreatedProject, CreateRunBody, ProjectsInfo, RepoInfo, Run, RunDiff, RunEvent, StreamEvent, SystemInfo,
} from '@conductor/shared';

/** Error carrying the server's `{ error }` message verbatim. */
export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface StreamHandlers {
  onOpen(): void;
  onEvent(ev: StreamEvent): void;
  /** The stream dropped; the source will not retry on its own — the caller schedules reconnects. */
  onDrop(): void;
}

/** Everything the UI needs from the backend. Implemented by HTTP (below) and by the in-browser mock. */
export interface DataSource {
  listRuns(): Promise<Run[]>;
  getRun(id: string): Promise<Run>;
  events(id: string, after?: number): Promise<RunEvent[]>;
  diff(id: string): Promise<RunDiff>;
  createRun(body: CreateRunBody): Promise<Run>;
  answer(id: string, questionId: string, answer: string): Promise<Run>;
  message(id: string, text: string): Promise<Run>;
  cancel(id: string): Promise<Run>;
  restart(id: string): Promise<Run>;
  accept(id: string, mode: NonNullable<AcceptBody['mode']>): Promise<Run>;
  reject(id: string): Promise<Run>;
  inspectRepo(path: string): Promise<RepoInfo>;
  /** Repos in the projects folder (CONDUCTOR_PROJECTS_DIR). */
  projects(): Promise<ProjectsInfo>;
  /** New git repo in the projects folder; an existing one of that name is returned as is. */
  createProject(name: string): Promise<CreatedProject>;
  system(): Promise<SystemInfo>;
  /** Open the live stream. Returns a close function. */
  stream(h: StreamHandlers): () => void;
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach conductor server — is it running?', 0);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const msg = json && typeof json === 'object' && 'error' in json && typeof json.error === 'string'
      ? json.error
      : `${method} ${url} failed: ${res.status} ${res.statusText}`;
    throw new ApiError(msg, res.status);
  }
  return json as T;
}

const enc = encodeURIComponent;
const runUrl = (id: string, rest = '') => `/api/runs/${enc(id)}${rest}`;

export const httpSource: DataSource = {
  listRuns: () => req<{ runs: Run[] }>('GET', '/api/runs').then((r) => r.runs),
  getRun: (id) => req<{ run: Run }>('GET', runUrl(id)).then((r) => r.run),
  events: (id, after) =>
    req<{ events: RunEvent[] }>('GET', runUrl(id, `/events${after ? `?after=${after}` : ''}`)).then((r) => r.events),
  diff: (id) => req<RunDiff>('GET', runUrl(id, '/diff')),
  createRun: (body) => req<{ run: Run }>('POST', '/api/runs', body).then((r) => r.run),
  answer: (id, questionId, answer) => req<{ run: Run }>('POST', runUrl(id, '/answer'), { questionId, answer }).then((r) => r.run),
  message: (id, text) => req<{ run: Run }>('POST', runUrl(id, '/message'), { text }).then((r) => r.run),
  cancel: (id) => req<{ run: Run }>('POST', runUrl(id, '/cancel'), {}).then((r) => r.run),
  restart: (id) => req<{ run: Run }>('POST', runUrl(id, '/restart'), {}).then((r) => r.run),
  accept: (id, mode) => req<{ run: Run }>('POST', runUrl(id, '/accept'), { mode } satisfies AcceptBody).then((r) => r.run),
  reject: (id) => req<{ run: Run }>('POST', runUrl(id, '/reject'), {}).then((r) => r.run),
  inspectRepo: (path) => req<RepoInfo>('GET', `/api/repos/inspect?path=${enc(path)}`),
  projects: () => req<ProjectsInfo>('GET', '/api/projects'),
  createProject: (name) => req<CreatedProject>('POST', '/api/projects', { name }),
  system: () => req<SystemInfo>('GET', '/api/system'),
  stream(h) {
    const es = new EventSource('/api/stream');
    let dropped = false;
    const handle = (e: MessageEvent<string>) => {
      try { h.onEvent(JSON.parse(e.data) as StreamEvent); } catch { /* ignore malformed frame */ }
    };
    es.onopen = () => h.onOpen();
    // Server names events by `type`; also accept unnamed frames carrying `type` in the payload.
    for (const t of ['run', 'event', 'system', 'voice'] as const) es.addEventListener(t, handle);
    es.onmessage = handle;
    es.onerror = () => {
      // Take over reconnection ourselves (backoff + resync) instead of EventSource's silent retry.
      if (dropped) return;
      dropped = true;
      es.close();
      h.onDrop();
    };
    return () => { dropped = true; es.close(); };
  },
};
