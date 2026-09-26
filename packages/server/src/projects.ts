/**
 * The projects folder (CONDUCTOR_PROJECTS_DIR): where your repos live and where new ones
 * are created. Lets people name a repo ("tictactoe") instead of giving a path, and start
 * a brand-new project by name.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { slugify, type ProjectInfo } from '@conductor/shared';
import { git } from './git/git.ts';

export { slugify };

export interface Projects {
  /** Absolute folder, or null when not configured. */
  readonly dir: string | null;
  /** Git repos directly inside the folder, by name. */
  list(): Promise<ProjectInfo[]>;
  /**
   * Create `<dir>/<slug(name)>` as a git repo with an empty first commit (worktrees need a
   * commit to branch from). An existing repo of that name is returned as is, never touched.
   */
  create(name: string): Promise<{ path: string; name: string; existed: boolean }>;
}

export function loadProjectsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.CONDUCTOR_PROJECTS_DIR?.trim();
  if (!raw) return null;
  return path.resolve(raw === '~' ? os.homedir() : raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw);
}

const isRepo = (dir: string) => fs.stat(path.join(dir, '.git')).then(() => true, () => false);

export function createProjects(dir: string | null): Projects {
  return {
    dir,
    async list() {
      if (!dir) return [];
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
      const repos = await Promise.all(dirs.map(async (e) => {
        const p = path.join(dir, e.name);
        return (await isRepo(p)) ? { name: e.name, path: p } : null;
      }));
      return repos.filter((r): r is ProjectInfo => r !== null).sort((a, b) => a.name.localeCompare(b.name));
    },
    async create(name) {
      if (!dir) throw new Error('No projects folder is set. Set CONDUCTOR_PROJECTS_DIR (for example in .env) and restart conductor.');
      const slug = slugify(name);
      if (!slug) throw new Error(`"${name}" doesn't make a usable folder name.`);
      const p = path.join(dir, slug);
      if (await isRepo(p)) return { path: p, name: slug, existed: true };
      const existing = await fs.readdir(p).catch(() => null);
      if (existing && existing.length) throw new Error(`${p} already exists and isn't a git repo; I won't touch it.`);
      await fs.mkdir(p, { recursive: true });
      await git(p, ['init', '--quiet', '--initial-branch=main']);
      await git(p, ['commit', '--quiet', '--allow-empty', '-m', 'Initial commit']);
      return { path: p, name: slug, existed: false };
    },
  };
}
