/**
 * Read-only data sources of the dashboard. Neon state comes from its panel RPC (dev-loaded plugin);
 * when that fails, from a read-only parse of the plugin's storage.json. Orca projects and workspaces
 * come from the orca CLI, activity from git. Nothing here writes to Orca, Neon or a repository.
 */
import { promises as fs, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();
export const PATHS = Object.freeze({
  storage: path.join(HOME, 'Library/Application Support/orca/plugins-data/local.toris-neon/storage.json'),
  receipts: path.join(HOME, '.toris-neon/runs'),
  journal: path.join(HOME, 'projects/toris-docs/journal/dev'),
});
const APP_ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca';
const ORCA = process.env.ORCA_BIN ?? (existsSync(APP_ORCA) ? APP_ORCA : 'orca'); // launchd has no Orca on PATH
const PLUGIN = 'local.toris-neon';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function exec(command, args, { timeout = 15_000, cwd } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } },
      (error, stdout, stderr) => error ? reject(Object.assign(error, { stderr: String(stderr).slice(0, 400) })) : resolve(stdout));
  });
}

export async function orcaJson(args, timeout) {
  const body = JSON.parse(await exec(ORCA, [...args, '--json'], { timeout }));
  if (body.ok === false) throw new Error(body.error?.message ?? 'orca CLI 오류');
  return body.result;
}
const neonRequest = async (name, data = {}) => (await orcaJson(['plugin', 'dev', 'request', PLUGIN, name, '--data', JSON.stringify(data)])).result;

/** Runs, archived runs and the Play cache from storage.json's text, as state.get{full} and play.list shape them. */
export function parseStorage(text) {
  const store = JSON.parse(text);
  const runtime = store['toris-neon.runtime.v2'];
  if (!runtime || !Array.isArray(runtime.runs)) throw new Error('toris-neon.runtime.v2 키가 없습니다');
  const runs = runtime.runs.map((id) => store['toris-neon.run.' + id]?.run).filter(Boolean);
  const archivedRuns = (runtime.archived ?? []).map((id) => store['toris-neon.archive.' + id]?.run).filter(Boolean);
  const accounts = (store['toris-neon.play.accounts.v1']?.accounts ?? []).map((account) => {
    const cache = store['toris-neon.play.cache.v1.' + account.id];
    return { id: account.id, checkedAt: cache?.checkedAt ?? null, apps: cache?.apps ?? [] };
  });
  return { runs, archivedRuns, play: { accounts, links: [] } };
}

/** storage.json read with retries: Orca may be mid-write, so a parse error is retried, then reported. */
export async function readStorage({ read = () => fs.readFile(PATHS.storage, 'utf8'), tries = 3, wait = () => sleep(250) } = {}) {
  let last;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try { return parseStorage(await read()); }
    catch (error) { last = error; if (attempt < tries) await wait(); }
  }
  throw new Error('storage.json을 읽지 못했습니다(' + tries + '회 시도): ' + last.message);
}

/** Neon runs and Play cache: RPC first, storage.json when the plugin does not answer. */
export async function neonState({ request = neonRequest, storage = readStorage } = {}) {
  try {
    const [full, play] = await Promise.all([request('state.get', { view: 'full' }), request('play.list')]);
    return { source: 'rpc', error: null, runs: full.runs, archivedRuns: full.archivedRuns, build: full.build ?? null,
      play: { accounts: play.accounts.map(({ id, checkedAt, apps }) => ({ id, checkedAt, apps })), links: play.links ?? [] } };
  } catch (error) {
    return { source: 'storage', error: 'Neon RPC 실패: ' + String(error.message).slice(0, 200), build: null, ...await storage() };
  }
}

const readHead = (file, bytes = 64 * 1024) => fs.readFile(file, 'utf8').then((text) => text.slice(0, bytes), () => '');
const exists = (file) => fs.access(file).then(() => true, () => false);

/** Stack and Android package ids read from a project's source folder (gradle applicationId, Godot export). */
export async function inspectSource(root) {
  const has = async (name) => exists(path.join(root, name));
  const [godot, flutter, gradle, gradleKts, node, cargo] = await Promise.all(['project.godot', 'pubspec.yaml', 'android/app/build.gradle', 'android/app/build.gradle.kts', 'package.json', 'Cargo.toml'].map(has));
  const stack = godot ? 'Godot' : flutter ? 'Flutter' : gradle || gradleKts ? 'Android' : cargo ? 'Rust' : node ? 'Web·Node' : null;
  const texts = await Promise.all(['android/app/build.gradle', 'android/app/build.gradle.kts', 'export_presets.cfg'].map((name) => readHead(path.join(root, name))));
  const ids = texts.flatMap((text) => [...text.matchAll(/applicationId\s*=?\s*["']([\w.]+)["']|package\/unique_name="([\w.]+)"/g)].map((match) => match[1] ?? match[2]));
  return { stack, packageIds: [...new Set(ids)] };
}

const SEP = '\x1f';
const commitOf = (line) => { const [hash, at, refs, subject] = line.split(SEP); return { hash: hash.slice(0, 8), at: new Date(Number(at) * 1000).toISOString(), refs, subject }; };

/** Newest commit on any branch, and the commits of the last `days` days (all branches, worktrees share them). */
export async function gitActivity(root, days = 21) {
  const format = ['--format=%H', '%ct', '%D', '%s'].join(SEP);
  const [last, recent] = await Promise.all([
    exec('git', ['-C', root, 'log', '--all', '-1', format], { timeout: 8000 }),
    exec('git', ['-C', root, 'log', '--all', '--since=' + days + '.days', '-n', '300', format], { timeout: 8000 }),
  ]);
  const lines = (text) => text.split('\n').filter(Boolean).map(commitOf);
  return { last: lines(last)[0] ?? null, recent: lines(recent) };
}

/** Changed paths in a worktree (tracked and untracked); null when git could not tell. */
export async function dirtyCount(root) {
  if (root === HOME) return null; // a repository at the home folder would scan everything
  try { return (await exec('git', ['-C', root, 'status', '--porcelain'], { timeout: 5000 })).split('\n').filter(Boolean).length; }
  catch { return null; }
}

/** Run `work` over `items` with at most `limit` at once. */
export async function mapLimited(items, limit, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; out[index] = await work(items[index], index); }
  }));
  return out;
}

/** Stale-while-revalidate: the first call waits, later calls get the last value and refresh in the background. */
export function cached(load, ttlMs) {
  let value = null, at = 0, pending = null, error = null;
  const refresh = () => pending ??= load().then((next) => { value = next; at = Date.now(); error = null; }, (failure) => { error = failure; })
    .finally(() => { pending = null; });
  return async () => {
    if (!value) { await refresh(); if (!value) throw error; }
    else if (Date.now() - at > ttlMs) void refresh();
    return { value, at, error: error ? String(error.message) : null };
  };
}

/** result.json of every attempt of a run: [{ nodeId, dir, result, mtime }], unreadable files reported in `error`. */
export async function receiptsOf(runId) {
  if (!/^[\w-]{8,64}$/.test(runId)) return [];
  const runDir = path.join(PATHS.receipts, runId);
  const nodes = await fs.readdir(runDir, { withFileTypes: true }).catch(() => []);
  const found = [];
  for (const node of nodes.filter((entry) => entry.isDirectory())) {
    const attempts = await fs.readdir(path.join(runDir, node.name), { withFileTypes: true }).catch(() => []);
    for (const attempt of attempts.filter((entry) => entry.isDirectory())) {
      const file = path.join(runDir, node.name, attempt.name, 'result.json');
      const stat = await fs.stat(file).catch(() => null);
      if (!stat) continue;
      if (stat.size > 1024 * 1024) { found.push({ nodeId: node.name, dir: attempt.name, result: null, error: 'result.json이 1MB를 넘어 읽지 않았습니다', mtime: stat.mtime.toISOString() }); continue; }
      try { found.push({ nodeId: node.name, dir: attempt.name, result: JSON.parse(await fs.readFile(file, 'utf8')), error: null, mtime: stat.mtime.toISOString() }); }
      catch (error) { found.push({ nodeId: node.name, dir: attempt.name, result: null, error: 'result.json 해석 실패: ' + error.message, mtime: stat.mtime.toISOString() }); }
    }
  }
  return found.toSorted((a, b) => a.mtime.localeCompare(b.mtime));
}
