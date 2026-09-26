import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProjects, loadProjectsDir, slugify } from '../src/projects.ts';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-projects-'));
  dirs.push(d);
  return d;
}
const gitIn = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

describe('projects folder', () => {
  it('slugifies spoken names into folder names', () => {
    expect(slugify('Weather App')).toBe('weather-app');
    expect(slugify('  Café  Menu!! ')).toBe('cafe-menu');
    expect(slugify('my_tool.v2')).toBe('my_tool.v2');
    expect(slugify('!!!')).toBe('');
  });

  it('reads CONDUCTOR_PROJECTS_DIR with ~ expansion', () => {
    expect(loadProjectsDir({})).toBeNull();
    expect(loadProjectsDir({ CONDUCTOR_PROJECTS_DIR: '~/code' })).toBe(path.join(os.homedir(), 'code'));
  });

  it('lists only git repos directly inside the folder', async () => {
    const root = tmp();
    for (const name of ['beta', 'alpha']) { fs.mkdirSync(path.join(root, name)); gitIn(path.join(root, name), 'init', '-q'); }
    fs.mkdirSync(path.join(root, 'notes'));
    fs.mkdirSync(path.join(root, '.hidden'));
    expect(await createProjects(root).list()).toEqual([
      { name: 'alpha', path: path.join(root, 'alpha') },
      { name: 'beta', path: path.join(root, 'beta') },
    ]);
    expect(await createProjects(null).list()).toEqual([]);
  });

  it('creates a repo on main with an empty first commit', async () => {
    const root = tmp();
    const made = await createProjects(root).create('Weather App');
    expect(made).toEqual({ path: path.join(root, 'weather-app'), name: 'weather-app', existed: false });
    expect(gitIn(made.path, 'branch', '--show-current')).toBe('main');
    expect(gitIn(made.path, 'log', '--format=%s')).toBe('Initial commit');
  });

  it('never touches an existing folder', async () => {
    const root = tmp();
    const p = createProjects(root);
    const first = await p.create('app');
    fs.writeFileSync(path.join(first.path, 'keep.txt'), 'mine');
    expect(await p.create('app')).toEqual({ ...first, existed: true });
    expect(fs.readFileSync(path.join(first.path, 'keep.txt'), 'utf8')).toBe('mine');
    fs.mkdirSync(path.join(root, 'plain'));
    fs.writeFileSync(path.join(root, 'plain', 'x'), '');
    await expect(p.create('plain')).rejects.toThrow(/isn't a git repo; I won't touch it/);
    await expect(createProjects(null).create('x')).rejects.toThrow(/CONDUCTOR_PROJECTS_DIR/);
  });
});

describe('/api/projects', () => {
  async function app(dir: string | null) {
    const { makeHarness } = await import('./helpers/index.ts');
    const { buildServer } = await import('../src/api/server.ts');
    const { createVoiceManager } = await import('../src/voice/manager.ts');
    const h = makeHarness();
    dirs.push(h.config.dataDir);
    const voice = createVoiceManager({ config: { apiKey: undefined, model: 'm', voice: 'v', baseUrl: 'http://x' } });
    return buildServer({ supervisor: h.sup, store: h.store, git: h.git, serveWeb: false, voice, projects: createProjects(dir) });
  }

  it('lists and creates projects', async () => {
    const root = tmp();
    const a = await app(root);
    expect((await a.inject({ method: 'GET', url: '/api/projects' })).json()).toEqual({ dir: root, projects: [] });
    const made = await a.inject({ method: 'POST', url: '/api/projects', payload: { name: 'Weather App' } });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toEqual({ name: 'weather-app', path: path.join(root, 'weather-app'), existed: false });
    expect((await a.inject({ method: 'POST', url: '/api/projects', payload: { name: 'weather app' } })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/api/projects' })).json().projects).toHaveLength(1);
    await a.close();
  });

  it('says how to configure the folder when it is missing', async () => {
    const a = await app(null);
    const res = await a.inject({ method: 'POST', url: '/api/projects', payload: { name: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/CONDUCTOR_PROJECTS_DIR/);
    await a.close();
  });
});
