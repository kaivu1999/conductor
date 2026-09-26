import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGit } from '../src/git/git.ts';
import type { Git } from '../src/contracts.ts';

const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' },
  }).trim();

function write(dir: string, rel: string, content: string) {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

describe('git', () => {
  let tmp: string;
  let repo: string;
  let root: string;
  let g: Git;

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), 'conductor-git-')));
    repo = join(tmp, 'repo');
    root = join(tmp, 'worktrees');
    mkdirSync(repo);
    sh(repo, 'init', '-q', '-b', 'main');
    write(repo, 'a.txt', 'one\ntwo\nthree\n');
    write(repo, 'b.txt', 'bee\n');
    write(repo, 'gone.txt', 'delete me\n');
    write(repo, 'package.json', JSON.stringify({ scripts: { test: 'node --test' } }));
    sh(repo, 'add', '-A');
    sh(repo, 'commit', '-q', '-m', 'init');
    g = createGit({ worktreeRoot: root });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  const head = (cwd: string, ref = 'HEAD') => sh(cwd, 'rev-parse', ref);

  /** Creates a run worktree, applies `edit`, commits. */
  async function runBranch(id: string, edit: (wt: string) => void) {
    const { worktreePath, baseCommit } = await g.createWorktree(repo, id, `conductor/${id}`, 'main');
    edit(worktreePath);
    await g.commitAll(worktreePath, `run ${id}`);
    return { worktreePath, baseCommit };
  }

  it('inspectRepo reports repo facts and never throws', async () => {
    write(repo, 'a.txt', 'dirty\n');
    const info = await g.inspectRepo(join(repo, '.'));
    expect(info).toMatchObject({ path: repo, name: 'repo', isGitRepo: true, currentBranch: 'main', dirty: true, detectedTestCommand: 'npm test' });
    expect(info.branches).toEqual(['main']);
    const missing = await g.inspectRepo(join(tmp, 'nope'));
    expect(missing.isGitRepo).toBe(false);
    expect(missing.error).toMatch(/does not exist/);
    mkdirSync(join(tmp, 'plain'));
    expect((await g.inspectRepo(join(tmp, 'plain'))).error).toMatch(/not a git repository/);
  });

  it('createWorktree creates a branch + worktree and is idempotent', async () => {
    const first = await g.createWorktree(repo, 'r_aaaaaa', 'conductor/r_aaaaaa', 'main');
    expect(first.worktreePath).toBe(join(root, 'r_aaaaaa'));
    expect(first.baseCommit).toBe(head(repo));
    expect(sh(first.worktreePath, 'symbolic-ref', '--short', 'HEAD')).toBe('conductor/r_aaaaaa');
    const again = await g.createWorktree(repo, 'r_aaaaaa', 'conductor/r_aaaaaa', 'main');
    expect(again).toEqual(first);

    // restart after the directory was wiped: branch exists, reuse it
    write(first.worktreePath, 'new.txt', 'x');
    await g.commitAll(first.worktreePath, 'work');
    rmSync(first.worktreePath, { recursive: true, force: true });
    const revived = await g.createWorktree(repo, 'r_aaaaaa', 'conductor/r_aaaaaa', 'main');
    expect(revived.baseCommit).toBe(first.baseCommit);
    expect(existsSync(join(revived.worktreePath, 'new.txt'))).toBe(true);
  });

  it('createWorktree fails clearly for a missing base branch', async () => {
    await expect(g.createWorktree(repo, 'r_bbbbbb', 'conductor/r_bbbbbb', 'nope')).rejects.toThrow(/base branch "nope" not found/);
  });

  it('changedPaths/diffStat see uncommitted and untracked files without touching the index', async () => {
    const { worktreePath: wt, baseCommit } = await g.createWorktree(repo, 'r_cccccc', 'conductor/r_cccccc', 'main');
    write(wt, 'a.txt', 'one\nTWO\nthree\n');
    write(wt, 'dir/untracked.txt', 'hi\n');
    unlinkSync(join(wt, 'gone.txt'));
    expect((await g.changedPaths(wt, baseCommit)).sort()).toEqual(['a.txt', 'dir/untracked.txt', 'gone.txt']);
    const stat = await g.diffStat(wt, baseCommit);
    expect(stat).toMatchObject({ files: 3, insertions: 2, deletions: 2 });
    // real index untouched: untracked file still untracked
    expect(sh(wt, 'status', '--porcelain')).toContain('?? dir/');
  });

  it('diff parses added/modified/deleted/renamed', async () => {
    const { worktreePath: wt, baseCommit } = await g.createWorktree(repo, 'r_dddddd', 'conductor/r_dddddd', 'main');
    write(wt, 'a.txt', 'one\nTWO\nthree\nfour\n');
    write(wt, 'added.txt', 'new\n');
    unlinkSync(join(wt, 'gone.txt'));
    await g.commitAll(wt, 'partial'); // committed + further uncommitted edit
    sh(wt, 'mv', 'b.txt', 'renamed.txt');
    const files = await g.diff(wt, baseCommit);
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(by['a.txt']).toMatchObject({ status: 'modified', insertions: 2, deletions: 1 });
    expect(by['a.txt']!.patch).toMatch(/^diff --git a\/a.txt b\/a.txt[\s\S]*\+TWO/);
    expect(by['added.txt']).toMatchObject({ status: 'added', insertions: 1, deletions: 0 });
    expect(by['gone.txt']).toMatchObject({ status: 'deleted', deletions: 1 });
    expect(by['gone.txt']!.patch).toContain('-delete me');
    expect(by['renamed.txt']).toMatchObject({ status: 'renamed', oldPath: 'b.txt' });
    expect(files).toHaveLength(4);
  });

  it('commitAll returns null when clean and a sha otherwise', async () => {
    const { worktreePath: wt } = await g.createWorktree(repo, 'r_eeeeee', 'conductor/r_eeeeee', 'main');
    expect(await g.commitAll(wt, 'nothing')).toBeNull();
    write(wt, 'x.txt', 'x');
    const sha = await g.commitAll(wt, 'something');
    expect(sha).toBe(head(wt));
    expect(sh(wt, 'log', '-1', '--format=%an <%ae>')).toBe('Conductor Agent <conductor@localhost>');
    expect(await g.commitAll(wt, 'nothing again')).toBeNull();
  });

  it('merge when base is NOT checked out moves the ref and leaves the checkout alone', async () => {
    sh(repo, 'checkout', '-q', '-b', 'feature');
    write(repo, 'wip.txt', 'user wip\n'); // untracked + uncommitted user state
    write(repo, 'b.txt', 'user edit\n');
    const before = head(repo);
    await runBranch('r_ffffff', (wt) => write(wt, 'a.txt', 'merged\n'));
    const res = await g.merge(repo, 'conductor/r_ffffff', 'main', 'Merge run');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(head(repo, 'main')).toBe(res.mergeCommit);
    expect(sh(repo, 'rev-list', '--parents', '-n1', 'main').split(' ')).toHaveLength(3); // --no-ff
    expect(sh(repo, 'show', 'main:a.txt')).toBe('merged');
    expect(head(repo)).toBe(before);
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('user edit\n');
    expect(sh(repo, 'symbolic-ref', '--short', 'HEAD')).toBe('feature');
  });

  it('merge when base IS checked out and clean advances the checkout', async () => {
    await runBranch('r_gggggg', (wt) => write(wt, 'new.txt', 'hello\n'));
    write(repo, 'untracked-ok.txt', 'fine\n');
    const res = await g.merge(repo, 'conductor/r_gggggg', 'main', 'Merge run');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(head(repo)).toBe(res.mergeCommit);
    expect(readFileSync(join(repo, 'new.txt'), 'utf8')).toBe('hello\n');
    expect(sh(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
  });

  it('merge refuses when checked-out base is dirty', async () => {
    await runBranch('r_hhhhhh', (wt) => write(wt, 'new.txt', 'hello\n'));
    write(repo, 'b.txt', 'uncommitted\n');
    const before = head(repo);
    const res = await g.merge(repo, 'conductor/r_hhhhhh', 'main', 'Merge run');
    expect(res).toMatchObject({ ok: false, conflicts: [] });
    if (res.ok) return;
    expect(res.error).toMatch(/main is checked out in .* with uncommitted changes/);
    expect(head(repo)).toBe(before);
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('uncommitted\n');
  });

  it('merge conflict returns paths and leaves the repo untouched', async () => {
    await runBranch('r_iiiiii', (wt) => write(wt, 'a.txt', 'agent version\n'));
    write(repo, 'a.txt', 'user version\n');
    sh(repo, 'commit', '-qam', 'user change');
    const before = head(repo);
    const res = await g.merge(repo, 'conductor/r_iiiiii', 'main', 'Merge run');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.conflicts).toEqual(['a.txt']);
    expect(res.error).toMatch(/conflicts/);
    expect(head(repo)).toBe(before);
    expect(sh(repo, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
  });

  it('removeWorktree is idempotent and refuses paths outside the root', async () => {
    const { worktreePath } = await g.createWorktree(repo, 'r_jjjjjj', 'conductor/r_jjjjjj', 'main');
    write(worktreePath, 'junk.txt', 'uncommitted');
    await g.removeWorktree(repo, worktreePath);
    expect(existsSync(worktreePath)).toBe(false);
    expect(sh(repo, 'worktree', 'list')).not.toContain('r_jjjjjj');
    expect(sh(repo, 'branch', '--list', 'conductor/r_jjjjjj')).toContain('conductor/r_jjjjjj');
    await g.removeWorktree(repo, worktreePath); // again: no throw
    // stray dir that git doesn't know about
    mkdirSync(join(root, 'r_stray1'), { recursive: true });
    await g.removeWorktree(repo, join(root, 'r_stray1'));
    expect(existsSync(join(root, 'r_stray1'))).toBe(false);

    await expect(g.removeWorktree(repo, repo)).rejects.toThrow(/not inside worktree root/);
    await expect(g.removeWorktree(repo, root)).rejects.toThrow(/not inside worktree root/);
    await expect(g.removeWorktree(repo, join(root, '..', 'repo'))).rejects.toThrow(/not inside worktree root/);
    expect(existsSync(join(repo, 'a.txt'))).toBe(true);
  });

  it('deleteBranch ignores missing branches', async () => {
    await g.createWorktree(repo, 'r_kkkkkk', 'conductor/r_kkkkkk', 'main');
    await g.removeWorktree(repo, join(root, 'r_kkkkkk'));
    await g.deleteBranch(repo, 'conductor/r_kkkkkk');
    expect(sh(repo, 'branch', '--list', 'conductor/r_kkkkkk')).toBe('');
    await g.deleteBranch(repo, 'conductor/r_kkkkkk');
  });

  it('diskUsage flags orphans', async () => {
    const { worktreePath } = await g.createWorktree(repo, 'r_llllll', 'conductor/r_llllll', 'main');
    mkdirSync(join(root, 'r_orphan'));
    const du = await g.diskUsage(new Map([[worktreePath, 'r_llllll']]));
    const by = Object.fromEntries(du.worktrees.map((w) => [w.path, w]));
    expect(by[worktreePath]).toMatchObject({ runId: 'r_llllll', orphan: false });
    expect(by[worktreePath]!.bytes).toBeGreaterThan(0);
    expect(by[join(root, 'r_orphan')]).toMatchObject({ runId: null, orphan: true });
    expect(du.totalBytes).toBeGreaterThan(0);
  });

  it('runTests: pass, fail, timeout (kills the process group)', async () => {
    const pass = await g.runTests(repo, 'echo ok; echo "ci=$CI"', 5000);
    expect(pass).toMatchObject({ passed: true, exitCode: 0 });
    expect(pass.output).toContain('ci=1');
    const fail = await g.runTests(repo, 'echo nope >&2; exit 3', 5000);
    expect(fail).toMatchObject({ passed: false, exitCode: 3 });
    expect(fail.output).toContain('nope');
    const big = await g.runTests(repo, 'yes x | head -c 50000', 5000);
    expect(big.output.length).toBeLessThanOrEqual(8 * 1024);
    const t0 = Date.now();
    const slow = await g.runTests(repo, 'sleep 30 & sleep 30; echo never', 300);
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(slow.passed).toBe(false);
    expect(slow.output).toMatch(/timed out/);
  });

  it('detectTestCommand', async () => {
    expect(await g.detectTestCommand(repo)).toBe('npm test');
    write(repo, 'pnpm-lock.yaml', '');
    expect(await g.detectTestCommand(repo)).toBe('pnpm test');
    const d = join(tmp, 'd');
    mkdirSync(d);
    write(d, 'package.json', JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }));
    expect(await g.detectTestCommand(d)).toBeNull();
    write(d, 'go.mod', 'module x');
    expect(await g.detectTestCommand(d)).toBe('go test ./...');
    write(d, 'pytest.ini', '');
    expect(await g.detectTestCommand(d)).toBe('pytest -q');
  });
});
