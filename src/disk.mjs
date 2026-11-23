/**
 * Disk use of one run, on request (`runs.disk`), never in a state push: the run's receipt folder and
 * the build outputs in a workspace Neon created, each marked in use, referenced as evidence,
 * protected or a cleanup candidate. Preview only: nothing here deletes, moves or writes a file.
 * Symlinks are never followed; signing material and files tracked by Git are never candidates.
 */
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

/** Folders a Flutter, Gradle or Godot build regenerates, relative to the workspace. */
export const BUILD_OUTPUTS = Object.freeze(['build', '.dart_tool', '.gradle', 'app/build', 'android/.gradle', 'android/app/build', '.godot']);
const MAX_ENTRIES = 50_000; // per tree; a larger tree is reported as partial (at least this much)
const SIGNING = /\.(jks|p12|pfx|pem|p8|mobileprovision)$|keystore|key\.properties|signing/i; // by name only: a partial walk is protected anyway
const LIVE_JOB_STATES = new Set(['launching', 'running', 'awaiting-report', 'uncertain']);
const FINISHED_RUNS = new Set(['completed', 'cancelled']);
const execFileAsync = promisify(execFile);
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };

/** { exists, bytes, files, truncated, signing } of a folder, counting regular files only; truncated means a lower bound. */
export async function measureTree(root, { maxEntries = MAX_ENTRIES } = {}) {
  const result = { exists: true, bytes: 0, files: 0, truncated: false, signing: false };
  try { if (!(await fs.lstat(root)).isDirectory()) return { ...result, exists: false }; }
  catch (error) { return error.code === 'ENOENT' ? { ...result, exists: false } : { ...result, truncated: true }; } // unreadable is not absent
  const stack = [root];
  let entries = 0;
  while (stack.length) {
    const dir = stack.pop();
    let listed;
    try { listed = await fs.readdir(dir, { withFileTypes: true }); }
    catch { result.truncated = true; continue; } // unreadable: the total is a lower bound
    const files = [];
    for (const entry of listed) {
      if (++entries > maxEntries) { result.truncated = true; stack.length = 0; break; }
      if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
      else if (entry.isFile()) { files.push(path.join(dir, entry.name)); if (SIGNING.test(entry.name)) result.signing = true; }
    }
    for (const stat of await Promise.all(files.map((file) => fs.lstat(file).catch(() => null)))) {
      if (stat) { result.bytes += stat.size; result.files += 1; } else result.truncated = true;
    }
  }
  return result;
}

// Every absolute path any run records outside its jobs ledger: reports, evidence, accepted receipts, history.
function referencedPaths(runs) {
  const found = new Set();
  const visit = (value) => {
    if (typeof value === 'string') { if (path.isAbsolute(value)) found.add(path.resolve(value)); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) if (key !== 'jobs') visit(item);
  };
  visit(runs);
  return [...found];
}

// The folder itself, not reached through a symlink anywhere on the way from `base` (lstat sees only the last part).
async function directlyInside(base, dir) {
  try { return inside(base, dir) && (await fs.realpath(dir)) === path.join(await fs.realpath(base), path.relative(base, dir)); }
  catch { return false; }
}
const protection = (size, fallback = null) => size.truncated ? 'unreadable' : size.signing ? 'signing' : fallback; // a partial walk may have missed signing files

// A compacted (saved or archived) job keeps only its receipt file path; its folder is that file's.
const jobFolder = (job) => typeof job.receiptDirectory === 'string' ? path.resolve(job.receiptDirectory) : typeof job.receiptPath === 'string' ? path.dirname(path.resolve(job.receiptPath)) : null;

async function receiptJobs(run, runRoot, runs, maxEntries) {
  const current = new Set((run.nodes ?? []).flatMap((node) => [node.active?.nonce, node.pendingReceipt?.nonce]).filter(Boolean));
  const references = referencedPaths(runs);
  const out = [], seen = new Set();
  for (const job of run.jobs ?? []) {
    const dir = jobFolder(job);
    if (!dir || seen.has(dir) || !(await directlyInside(runRoot, dir))) continue;
    seen.add(dir);
    const size = await measureTree(dir, { maxEntries });
    if (!size.exists) continue;
    const reason = protection(size);
    const kind = current.has(job.nonce) || LIVE_JOB_STATES.has(job.state) ? 'live'
      : references.some((file) => file === dir || inside(dir, file)) ? 'referenced' : reason ? 'protected' : 'candidate';
    out.push({ nodeId: job.nodeId, path: dir, kind, ...(kind === 'protected' ? { reason } : {}), bytes: size.bytes, files: size.files, truncated: size.truncated });
  }
  return out;
}

async function tracked(workspacePath, relative) {
  try {
    const { stdout } = await execFileAsync('git', ['-c', 'core.fsmonitor=false', '-C', workspacePath, 'ls-files', '-z', '--', relative],
      { encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return stdout.length > 0;
  } catch { return true; } // not a checkout, or unanswerable: treat as the person's files
}

// Another unfinished run on the same workspace may still use its build outputs.
const workspaceLive = (run, runs) => !FINISHED_RUNS.has(run.status) || runs.some((other) => other.id !== run.id && !FINISHED_RUNS.has(other.status) &&
  ((run.workspaceId && other.workspaceId === run.workspaceId) || (other.workspacePath && path.resolve(other.workspacePath) === path.resolve(run.workspacePath))));

async function buildOutputs(run, runs, maxEntries) {
  if (run.isolate === false || run.workspaceCreation?.state !== 'created') return { builds: [], note: 'Neon이 만든 작업 공간이 아니라 빌드 출력을 세지 않습니다.' };
  if (!run.workspacePath) return { builds: [], note: '작업 공간이 아직 없습니다.' };
  const builds = [];
  for (const relative of BUILD_OUTPUTS) {
    const dir = path.join(run.workspacePath, relative);
    try { if (!(await fs.lstat(dir)).isDirectory()) continue; } // a file, or a symlink at the last part
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') continue; builds.push({ relative, path: dir, kind: 'protected', reason: 'unreadable', bytes: 0, files: 0, truncated: true }); continue; }
    if (!(await directlyInside(run.workspacePath, dir))) continue; // reached through a symlinked parent: outside the workspace
    const size = await measureTree(dir, { maxEntries });
    const reason = protection(size, await tracked(run.workspacePath, relative) ? 'tracked' : null);
    const kind = workspaceLive(run, runs) ? 'live' : reason ? 'protected' : 'candidate';
    builds.push({ relative, path: dir, kind, ...(kind === 'protected' ? { reason } : {}), bytes: size.bytes, files: size.files, truncated: size.truncated });
  }
  return { builds, note: null };
}

/** One run's disk use and the cleanup candidates it would offer; reads only. */
export async function runDisk({ run, runs, receiptRoot, now = Date.now, maxEntries = MAX_ENTRIES }) {
  const runRoot = path.join(receiptRoot, run.id);
  const total = await measureTree(runRoot, { maxEntries });
  const jobs = await receiptJobs(run, runRoot, runs, maxEntries);
  const { builds, note } = await buildOutputs(run, runs, maxEntries);
  const candidates = [...jobs, ...builds].filter((item) => item.kind === 'candidate');
  return {
    runId: run.id, at: new Date(now()).toISOString(),
    // Bytes in the run folder no listed job accounts for (older ledgers, archived runs): shown, never a candidate.
    receipts: { path: runRoot, exists: total.exists, bytes: total.bytes, files: total.files, truncated: total.truncated, jobs,
      unclassifiedBytes: Math.max(0, total.bytes - jobs.reduce((sum, item) => sum + item.bytes, 0)) },
    builds, buildsNote: note,
    candidates: { count: candidates.length, bytes: candidates.reduce((sum, item) => sum + item.bytes, 0) }
  };
}

const refuse = (message) => Object.assign(new Error(message), { code: 'invalid_params' });

/** The `runs.disk` panel request: { runId } → runDisk of that live or archived run; one walk per run at a time. */
export function diskHandlers({ getRuns, receiptRoot }) {
  const pending = new Map();
  return {
    'runs.disk': async ({ runId } = {}) => {
      const runs = getRuns();
      const run = typeof runId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId) ? runs.find((item) => item.id === runId) : null;
      if (!run) throw refuse('실행을 찾을 수 없습니다.');
      if (!pending.has(runId)) pending.set(runId, runDisk({ run, runs, receiptRoot }).finally(() => pending.delete(runId)));
      return pending.get(runId);
    }
  };
}
