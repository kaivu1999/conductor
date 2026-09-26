import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs, existsSync } from 'node:fs';
import { basename, join, resolve, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import type { DiffStat, DiskUsage, FileDiff, RepoInfo, TestResult } from '@conductor/shared';
import type { Git } from '../contracts.ts';

const execFileP = promisify(execFile);

const AGENT_NAME = 'Conductor Agent';
const AGENT_EMAIL = 'conductor@localhost';
const TEST_OUTPUT_LIMIT = 8 * 1024;

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

interface GitOpts {
  env?: NodeJS.ProcessEnv;
  /** Non-zero exit codes to return instead of throwing (0 always succeeds). */
  okCodes?: number[];
}

interface GitResult { stdout: string; stderr: string; code: number }

/** Runs `git -C cwd ...args`. Throws GitError with stderr on unexpected exit codes. */
export async function git(cwd: string, args: string[], opts: GitOpts = {}): Promise<GitResult> {
  const okCodes = opts.okCodes ?? [];
  try {
    const { stdout, stderr } = await execFileP('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...opts.env },
      maxBuffer: 256 * 1024 * 1024,
    });
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { code?: number | string; stdout?: string; stderr?: string };
    if (e.code === 'ENOENT') throw new GitError('git executable not found on PATH', args, null, '', '');
    const code = typeof e.code === 'number' ? e.code : null;
    const stdout = e.stdout ?? '';
    const stderr = (e.stderr ?? '').trim();
    if (code !== null && okCodes.includes(code)) return { stdout, stderr, code };
    const detail = stderr || stdout.trim() || e.message;
    throw new GitError(`git ${args.join(' ')} failed in ${cwd}: ${detail}`, args, code, stdout, stderr);
  }
}

const lines = (s: string) => s.split('\n').filter((l) => l.length > 0);

async function revParse(cwd: string, rev: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])).stdout.trim();
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  const r = await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { okCodes: [0, 1] });
  return r.code === 0;
}

/** Branch checked out in `cwd`, or null if detached. */
async function currentBranch(cwd: string): Promise<string | null> {
  const r = await git(cwd, ['symbolic-ref', '-q', '--short', 'HEAD'], { okCodes: [0, 1] });
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Map of worktree path -> branch (short name, or null if detached). */
async function listWorktrees(repo: string): Promise<Map<string, string | null>> {
  const out = (await git(repo, ['worktree', 'list', '--porcelain'])).stdout;
  const map = new Map<string, string | null>();
  let path: string | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      path = line.slice('worktree '.length);
      map.set(path, null);
    } else if (line.startsWith('branch ') && path) {
      map.set(path, line.slice('branch '.length).replace(/^refs\/heads\//, ''));
    }
  }
  return map;
}

async function realpathOrSelf(p: string): Promise<string> {
  try { return await fs.realpath(p); } catch { return resolve(p); }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

// ─── working-tree diffs via a throwaway index ────────────────────────────────

/**
 * Runs `fn` with GIT_INDEX_FILE pointed at a temp index that mirrors the worktree
 * (tracked + untracked, honoring .gitignore). The worktree's real index is untouched.
 */
async function withSnapshotIndex<T>(worktree: string, fn: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(join(tmpdir(), 'conductor-idx-'));
  const env = { GIT_INDEX_FILE: join(dir, 'index') };
  try {
    await git(worktree, ['read-tree', 'HEAD'], { env });
    await git(worktree, ['add', '-A'], { env });
    return await fn(env);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

interface NumstatEntry { path: string; oldPath?: string; insertions: number; deletions: number }

/** Parses `--numstat -z` output (handles renames and binary "-"). */
function parseNumstatZ(out: string): NumstatEntry[] {
  const parts = out.split('\0');
  const entries: NumstatEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i]!;
    if (!head) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(head);
    if (!m) continue;
    const insertions = m[1] === '-' ? 0 : Number(m[1]);
    const deletions = m[2] === '-' ? 0 : Number(m[2]);
    if (m[3] === '') {
      // rename: next two NUL-separated fields are old and new paths
      const oldPath = parts[++i]!;
      const path = parts[++i]!;
      entries.push({ path, oldPath, insertions, deletions });
    } else {
      entries.push({ path: m[3]!, insertions, deletions });
    }
  }
  return entries;
}

type Status = FileDiff['status'];

/** Parses `--name-status -z` output into path -> {status, oldPath}. */
function parseNameStatusZ(out: string): Map<string, { status: Status; oldPath?: string }> {
  const parts = out.split('\0');
  const map = new Map<string, { status: Status; oldPath?: string }>();
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!;
    if (!code) continue;
    const letter = code[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = parts[++i]!;
      const path = parts[++i]!;
      map.set(path, { status: letter === 'R' ? 'renamed' : 'added', oldPath: letter === 'R' ? oldPath : undefined });
    } else {
      const path = parts[++i]!;
      const status: Status = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
      map.set(path, { status });
    }
  }
  return map;
}

/** Splits a multi-file unified diff into per-file chunks keyed by new path (old path for deletions). */
function splitPatch(patch: string): Map<string, string> {
  const map = new Map<string, string>();
  const chunks = patch.split(/^(?=diff --git )/m).filter((c) => c.startsWith('diff --git '));
  for (const chunk of chunks) {
    const key = patchPath(chunk);
    if (key) map.set(key, chunk);
  }
  return map;
}

/** Extracts the file path from a diff chunk header, preferring explicit metadata lines. */
function patchPath(chunk: string): string | null {
  const header = chunk.split('\n').slice(0, 8);
  for (const l of header) if (l.startsWith('rename to ')) return l.slice('rename to '.length);
  for (const l of header) if (l.startsWith('+++ b/')) return l.slice('+++ b/'.length);
  for (const l of header) if (l.startsWith('--- a/')) return l.slice('--- a/'.length);
  // binary or mode-only change: "diff --git a/x b/x"
  const m = /^diff --git a\/(.*) b\/(.*)$/.exec(header[0] ?? '');
  return m ? m[2]! : null;
}

// ─── tests ───────────────────────────────────────────────────────────────────

function runShell(cwd: string, command: string, timeoutMs: number): Promise<TestResult> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    let output = '';
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > TEST_OUTPUT_LIMIT * 2) output = output.slice(-TEST_OUTPUT_LIMIT);
    };
    const child = spawn('sh', ['-c', command], {
      cwd,
      detached: true, // own process group so a timeout can kill grandchildren too
      env: { ...process.env, CI: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const killGroup = () => {
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    let done = false;
    const finish = (exitCode: number, extra = '') => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let text = output + extra;
      if (timedOut) text += `\n[conductor] test command timed out after ${Math.round(timeoutMs / 1000)}s and was killed\n`;
      if (text.length > TEST_OUTPUT_LIMIT) text = text.slice(-TEST_OUTPUT_LIMIT);
      resolvePromise({ command, passed: !timedOut && exitCode === 0, exitCode, durationMs: Date.now() - started, output: text });
    };
    child.on('error', (err) => finish(127, `\n[conductor] failed to start test command: ${err.message}\n`));
    child.on('close', (code, signal) => {
      killGroup(); // reap any stragglers left in the group
      finish(code ?? (signal ? 128 + (signalNumber(signal) ?? 9) : 1));
    });
  });
}

function signalNumber(sig: NodeJS.Signals): number | undefined {
  return ({ SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 } as Record<string, number>)[sig];
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); } catch { return null; }
}

async function detectTestCommand(dir: string): Promise<string | null> {
  const has = (f: string) => existsSync(join(dir, f));
  const pkg = await readJson(join(dir, 'package.json'));
  const script = (pkg?.scripts as Record<string, unknown> | undefined)?.test;
  if (typeof script === 'string' && script.trim() && !/no test specified/.test(script)) {
    if (has('pnpm-lock.yaml')) return 'pnpm test';
    if (has('yarn.lock')) return 'yarn test';
    return 'npm test';
  }
  if (has('pytest.ini') || has('conftest.py') || has('tox.ini')) return 'pytest -q';
  if (has('pyproject.toml')) {
    const py = await fs.readFile(join(dir, 'pyproject.toml'), 'utf8').catch(() => '');
    if (py.includes('[tool.pytest') || has('tests')) return 'pytest -q';
  }
  if (has('setup.cfg')) {
    const cfg = await fs.readFile(join(dir, 'setup.cfg'), 'utf8').catch(() => '');
    if (cfg.includes('[tool:pytest]')) return 'pytest -q';
  }
  if ((has('setup.py') || has('requirements.txt')) && has('tests')) return 'pytest -q';
  if (has('go.mod')) return 'go test ./...';
  if (has('Cargo.toml')) return 'cargo test';
  return null;
}

// ─── disk ────────────────────────────────────────────────────────────────────

async function duBytes(path: string): Promise<number> {
  try {
    const { stdout } = await execFileP('du', ['-sk', path]);
    return Number(stdout.split(/\s/)[0]) * 1024 || 0;
  } catch {
    return 0;
  }
}

// ─── Git implementation ──────────────────────────────────────────────────────

export function createGit(opts: { worktreeRoot: string }): Git {
  const root = resolve(opts.worktreeRoot);

  async function assertInsideRoot(p: string): Promise<string> {
    const abs = resolve(p);
    const realRoot = await realpathOrSelf(root);
    const realP = await realpathOrSelf(abs);
    if (!isInside(root, abs) && !isInside(realRoot, realP)) {
      throw new Error(`refusing to remove ${abs}: not inside worktree root ${root}`);
    }
    return abs;
  }

  async function findWorktree(repo: string, path: string): Promise<{ registered: boolean; branch: string | null }> {
    const wts = await listWorktrees(repo);
    const real = await realpathOrSelf(path);
    for (const [p, b] of wts) {
      if (p === path || (await realpathOrSelf(p)) === real) return { registered: true, branch: b };
    }
    return { registered: false, branch: null };
  }

  const impl: Git = {
    async inspectRepo(path) {
      const abs = resolve(path);
      const info: RepoInfo = {
        path: abs, name: basename(abs), isGitRepo: false, currentBranch: null,
        branches: [], dirty: false, detectedTestCommand: null,
      };
      try {
        const st = await fs.stat(abs).catch(() => null);
        if (!st) return { ...info, error: `path does not exist: ${abs}` };
        if (!st.isDirectory()) return { ...info, error: `not a directory: ${abs}` };
        const top = await git(abs, ['rev-parse', '--show-toplevel'], { okCodes: [0, 128] });
        if (top.code !== 0) return { ...info, error: `not a git repository: ${abs}` };
        const toplevel = top.stdout.trim();
        const [branch, branches, status, testCmd] = await Promise.all([
          currentBranch(toplevel),
          git(toplevel, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).then((r) => lines(r.stdout)),
          git(toplevel, ['status', '--porcelain', '--untracked-files=no']).then((r) => r.stdout.trim().length > 0),
          detectTestCommand(toplevel),
        ]);
        const result: RepoInfo = {
          path: toplevel, name: basename(toplevel), isGitRepo: true, currentBranch: branch,
          branches: branches.filter((b) => !b.startsWith('conductor/')), dirty: status, detectedTestCommand: testCmd,
        };
        const hasCommits = await git(toplevel, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [0, 1] });
        if (hasCommits.code !== 0) result.error = 'repository has no commits yet; make an initial commit first';
        return result;
      } catch (err) {
        return { ...info, error: (err as Error).message };
      }
    },

    async createWorktree(repoPath, runId, branch, baseBranch) {
      const worktreePath = join(root, runId);
      await fs.mkdir(root, { recursive: true });
      const existing = await findWorktree(repoPath, worktreePath);

      if (existing.registered && existsSync(worktreePath)) {
        if (existing.branch !== branch) {
          throw new Error(`worktree ${worktreePath} exists but is on ${existing.branch ?? 'a detached HEAD'}, expected ${branch}`);
        }
        return { worktreePath, baseCommit: await baseCommitFor(repoPath, branch, baseBranch) };
      }
      // Registered but directory gone (or stray dir that isn't a worktree): clear it out.
      if (existing.registered) await git(repoPath, ['worktree', 'prune']);
      if (existsSync(worktreePath)) {
        await assertInsideRoot(worktreePath);
        await fs.rm(worktreePath, { recursive: true, force: true });
      }

      if (await branchExists(repoPath, branch)) {
        await git(repoPath, ['worktree', 'add', worktreePath, branch]);
        return { worktreePath, baseCommit: await baseCommitFor(repoPath, branch, baseBranch) };
      }
      const baseCommit = await revParse(repoPath, baseBranch).catch(() => {
        throw new Error(`base branch "${baseBranch}" not found in ${repoPath}`);
      });
      await git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, baseCommit]);
      return { worktreePath, baseCommit };
    },

    async commitAll(worktreePath, message) {
      await git(worktreePath, ['add', '-A']);
      const staged = await git(worktreePath, ['diff', '--cached', '--quiet'], { okCodes: [0, 1] });
      if (staged.code === 0) return null;
      await git(worktreePath, [
        '-c', `user.name=${AGENT_NAME}`, '-c', `user.email=${AGENT_EMAIL}`, '-c', 'commit.gpgsign=false',
        'commit', '--no-verify', '-q', '-m', message,
      ]);
      return (await git(worktreePath, ['rev-parse', 'HEAD'])).stdout.trim();
    },

    async changedPaths(worktreePath, baseCommit) {
      return withSnapshotIndex(worktreePath, async (env) => {
        const out = (await git(worktreePath, ['diff', '--cached', '--name-only', '-z', '--no-renames', baseCommit], { env })).stdout;
        return out.split('\0').filter(Boolean);
      });
    },

    async diffStat(worktreePath, baseCommit) {
      return withSnapshotIndex(worktreePath, async (env) => {
        const out = (await git(worktreePath, ['diff', '--cached', '--numstat', '-z', '-M', baseCommit], { env })).stdout;
        const entries = parseNumstatZ(out);
        const stat: DiffStat = { files: entries.length, insertions: 0, deletions: 0, paths: entries.map((e) => e.path) };
        for (const e of entries) { stat.insertions += e.insertions; stat.deletions += e.deletions; }
        return stat;
      });
    },

    async diff(worktreePath, baseCommit) {
      return withSnapshotIndex(worktreePath, async (env) => {
        const base = ['diff', '--cached', '-M', '--no-color', '--no-ext-diff', baseCommit];
        const [numstat, nameStatus, patch] = await Promise.all([
          git(worktreePath, [...base, '--numstat', '-z'], { env }),
          git(worktreePath, [...base, '--name-status', '-z'], { env }),
          git(worktreePath, [...base, '-p', '--full-index'], { env }),
        ]);
        const statuses = parseNameStatusZ(nameStatus.stdout);
        const patches = splitPatch(patch.stdout);
        return parseNumstatZ(numstat.stdout).map((e): FileDiff => {
          const s = statuses.get(e.path);
          const fd: FileDiff = {
            path: e.path,
            status: s?.status ?? (e.oldPath ? 'renamed' : 'modified'),
            insertions: e.insertions,
            deletions: e.deletions,
            patch: patches.get(e.path) ?? '',
          };
          const oldPath = s?.oldPath ?? e.oldPath;
          if (oldPath) fd.oldPath = oldPath;
          return fd;
        });
      });
    },

    runTests: runShell,
    detectTestCommand,

    async merge(repoPath, branch, baseBranch, message) {
      const fail = (error: string, conflicts: string[] = []) => ({ ok: false as const, conflicts, error });
      let oldBase: string;
      let head: string;
      try {
        oldBase = await revParse(repoPath, `refs/heads/${baseBranch}`);
        head = await revParse(repoPath, `refs/heads/${branch}`);
      } catch {
        return fail(`cannot merge: branch "${baseBranch}" or "${branch}" does not exist in ${repoPath}`);
      }

      // 1. Compute the merge entirely in the object database.
      const mt = await git(repoPath, ['merge-tree', '--write-tree', '--name-only', '--no-messages', oldBase, head], { okCodes: [0, 1] });
      const out = lines(mt.stdout);
      if (mt.code === 1) {
        const conflicts = [...new Set(out.slice(1))];
        return fail(`merging ${branch} into ${baseBranch} conflicts in ${conflicts.length} file(s): ${conflicts.join(', ')}`, conflicts);
      }
      const tree = out[0]!;

      // 2. Record a --no-ff merge commit. Author/committer default to the user's identity if set.
      const mergeCommit = (await git(repoPath, ['commit-tree', tree, '-p', oldBase, '-p', head, '-m', message], {
        env: await identityEnv(repoPath),
      })).stdout.trim();

      // 3. Publish it. If baseBranch is checked out anywhere, move that checkout too.
      const wts = await listWorktrees(repoPath);
      const checkedOutAt = [...wts].find(([, b]) => b === baseBranch)?.[0];
      if (!checkedOutAt) {
        try {
          await git(repoPath, ['update-ref', '-m', `conductor: merge ${branch}`, `refs/heads/${baseBranch}`, mergeCommit, oldBase]);
        } catch (err) {
          return fail(`${baseBranch} moved while merging (${(err as GitError).stderr || (err as Error).message}); accept again to retry`);
        }
        return { ok: true, mergeCommit };
      }

      const dirty = (await git(checkedOutAt, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
      if (dirty) {
        return fail(`${baseBranch} is checked out in ${checkedOutAt} with uncommitted changes; commit or stash them, then accept again`);
      }
      const r = await git(checkedOutAt, ['merge', '--ff-only', '-q', mergeCommit], { okCodes: [0, 1, 128] });
      if (r.code !== 0) {
        // Most likely an untracked file in the checkout would be overwritten, or base moved.
        return fail(`could not fast-forward ${baseBranch} in ${checkedOutAt}: ${r.stderr || r.stdout.trim()}`);
      }
      return { ok: true, mergeCommit };
    },

    async removeWorktree(repoPath, worktreePath) {
      const abs = await assertInsideRoot(worktreePath);
      if (existsSync(repoPath)) {
        const r = await git(repoPath, ['worktree', 'remove', '--force', '--force', abs], { okCodes: [0, 128] }).catch(() => null);
        if (r && r.code === 0 && !existsSync(abs)) {
          await git(repoPath, ['worktree', 'prune']).catch(() => {});
          return;
        }
      }
      await fs.rm(abs, { recursive: true, force: true });
      if (existsSync(repoPath)) await git(repoPath, ['worktree', 'prune']).catch(() => {});
    },

    async deleteBranch(repoPath, branch) {
      if (!(await branchExists(repoPath, branch))) return;
      await git(repoPath, ['branch', '-D', branch]);
    },

    async diskUsage(knownWorktrees) {
      const known = new Map<string, string>();
      for (const [p, id] of knownWorktrees) known.set(resolve(p), id);
      const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
      const worktrees = await Promise.all(
        entries.filter((e) => e.isDirectory()).map(async (e) => {
          const path = join(root, e.name);
          const runId = known.get(path) ?? null;
          return { runId, path, bytes: await duBytes(path), orphan: runId === null };
        }),
      );
      const usage: DiskUsage = { worktreeRoot: root, totalBytes: worktrees.reduce((n, w) => n + w.bytes, 0), worktrees };
      return usage;
    },
  };

  return impl;
}

/**
 * On restart the branch already exists; its fork point from baseBranch is the base commit.
 * Falls back to baseBranch's tip if there is no common ancestor.
 */
async function baseCommitFor(repo: string, branch: string, baseBranch: string): Promise<string> {
  const r = await git(repo, ['merge-base', `refs/heads/${baseBranch}`, `refs/heads/${branch}`], { okCodes: [0, 1] });
  if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
  return revParse(repo, baseBranch);
}

async function hasIdentity(repo: string): Promise<boolean> {
  const r = await git(repo, ['config', 'user.email'], { okCodes: [0, 1] });
  return r.code === 0 && r.stdout.trim().length > 0;
}

/** Commit the merge as the user when they have an identity configured, else as the agent. */
async function identityEnv(repo: string): Promise<NodeJS.ProcessEnv> {
  if (await hasIdentity(repo)) return {};
  return {
    GIT_AUTHOR_NAME: AGENT_NAME, GIT_AUTHOR_EMAIL: AGENT_EMAIL,
    GIT_COMMITTER_NAME: AGENT_NAME, GIT_COMMITTER_EMAIL: AGENT_EMAIL,
  };
}
