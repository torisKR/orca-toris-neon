/**
 * Durable runtime state in Orca's plugin store: an index plus one value per run and per archived run.
 *
 * Orca 1.4.268 (app.asar, the plugin store's set()): a value may be at most 262,144 bytes of compact
 * UTF-8 JSON, the store holds at most 1,024 keys, and the whole store file, written pretty-printed
 * with a 2-space indent and rewritten in full on every set, may be at most 5,242,880 bytes (a larger
 * file reads back as empty). Every value written here is compacted to a budget well under those
 * limits; full reports, evidence and long text stay on disk in the runs' receipt folders.
 */
import { usageSummary } from './usage.mjs';

export const ORCA_LIMITS = Object.freeze({ valueBytes: 262_144, keys: 1024, fileBytes: 5_242_880 });
export const LEGACY_KEY = 'toris-neon.runtime.v1';
export const INDEX_KEY = 'toris-neon.runtime.v2';
const RUN_PREFIX = 'toris-neon.run.';
const ARCHIVE_PREFIX = 'toris-neon.archive.';
export const runKey = (id) => RUN_PREFIX + id;
export const archiveKey = (id) => ARCHIVE_PREFIX + id;
// Budgets are bytes in the pretty-printed store file, which is always larger than the compact value.
export const BUDGETS = Object.freeze({
  run: 200 * 1024,            // one run; the deepest level of a worst-case 11-stage run fits under it
  minRunShare: 48 * 1024,     // a run's share never shrinks below this however many runs exist
  archive: 48 * 1024,         // one archived run
  archives: 1024 * 1024,      // all archived runs together
  total: 3.5 * 1024 * 1024,   // this runtime's share of the 5 MiB file; play and today keys use the rest
});
export const MAX_ARCHIVED = 100;
const RETRY_DELAYS_MS = [5_000, 30_000, 120_000, 300_000];
const ACTIVE_JOB_STATES = new Set(['launching', 'running', 'awaiting-report', 'uncertain']);

// Caps per compaction level; a run is stored at the first level that fits its budget.
// Level 3 is only for archived runs, which nothing resumes.
const LEVELS = [
  { events: 150, eventText: 500, history: 12, historyText: 200, jobs: 40, summary: 4000, evidence: 32, evidenceText: 1500, text: 2000, why: 300, liveWhy: Infinity, followUps: 12, followUpText: 600 },
  { events: 60, eventText: 300, history: 4, historyText: 120, jobs: 12, summary: 1500, evidence: 12, evidenceText: 400, text: 800, why: 120, liveWhy: 300, followUps: 6, followUpText: 300 },
  { events: 20, eventText: 160, history: 1, historyText: 0, jobs: 0, summary: 300, evidence: 0, evidenceText: 0, text: 300, why: 0, liveWhy: 120, followUps: 0, followUpText: 0 }, // follow-ups stay in memory and the receipt files
  { events: 10, eventText: 160, history: 0, historyText: 0, jobs: 0, summary: 160, evidence: 0, evidenceText: 0, text: 160, why: -1, liveWhy: -1, followUps: 0, followUpText: 0, archive: true },
];
const DEEPEST_LIVE_LEVEL = 2;

const utf8 = (text) => Buffer.byteLength(text, 'utf8');
const clip = (text, max) => typeof text !== 'string' || text.length <= max ? text : text.slice(0, Math.max(0, max - 1)) + '…';
const KEEP_WHOLE = new Set(['id', 'nonce', 'nodeId', 'runId', 'phase', 'outcome', 'kind', 'type', 'at', 'name', 'path', 'exitCode', 'role']);

/** Bytes a value adds to Orca's pretty-printed store file under `key`, its comma and newline included. */
export function fileBytes(key, value) {
  const pretty = JSON.stringify(value, null, 2);
  let lines = 0;
  for (let at = pretty.indexOf('\n'); at !== -1; at = pretty.indexOf('\n', at + 1)) lines++;
  return utf8(pretty) + 2 * lines + utf8(key) + 8;
}

/** Shallow copy with every long string clipped; nested values bigger than the cap are dropped. */
function clipFields(item, max) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
  const out = {};
  for (const [field, value] of Object.entries(item)) {
    if (KEEP_WHOLE.has(field)) out[field] = typeof value === 'string' ? clip(value, 1000) : value;
    else if (typeof value === 'string') { if (max > 0) out[field] = clip(value, max); }
    else if (value === null || typeof value !== 'object') out[field] = value;
    else if (utf8(JSON.stringify(value)) <= Math.max(max, 0) * 3) out[field] = value;
  }
  return out;
}

function compactReport(report, L) {
  if (!report || typeof report !== 'object') return report;
  const { evidence, ...rest } = report;
  const out = L.archive
    ? { nonce: rest.nonce, phase: rest.phase, outcome: rest.outcome, summary: clip(rest.summary, L.summary),
      sourceFingerprint: rest.sourceFingerprint, releaseLink: rest.releaseLink }
    : { ...rest, summary: clip(rest.summary, L.summary), ...(typeof rest.next === 'string' ? { next: clip(rest.next, L.summary) } : {}) };
  if (Array.isArray(rest.followUps)) {
    const kept = rest.followUps.slice(0, L.followUps).map((item) => clip(item, L.followUpText));
    if (kept.length) out.followUps = kept; else delete out.followUps;
  }
  if (!Array.isArray(evidence)) return out;
  const kept = evidence.slice(0, L.evidence).map((item) => clipFields(item, L.evidenceText));
  if (kept.length) out.evidence = kept;
  const omitted = (report.evidenceOmitted ?? 0) + evidence.length - kept.length;
  if (omitted) out.evidenceOmitted = omitted;
  return out;
}

/** Catalog shortlists: names always; reasons clipped, or dropped (why 0) or the whole list dropped (why -1). */
function compactShortlist(list, why) {
  if (!list || typeof list !== 'object' || why < 0) return undefined;
  if (why === Infinity) return list;
  const items = (entries) => Array.isArray(entries) ? entries.map((entry) => clipFields(entry, why)) : entries;
  return { ...clipFields(list, Math.max(why, 160)), ...(list.agents ? { agents: items(list.agents) } : {}), ...(list.skills ? { skills: items(list.skills) } : {}) };
}

const withoutJobCopies = (record) => {
  if (!record || typeof record !== 'object') return record;
  const { ecc, visual, ...rest } = record;
  return rest;
};

function compactNode(node, L, reviewCommits) {
  const out = { ...node };
  const reviewedCommit = reviewCommits.get(node.review?.nonce);
  if (reviewedCommit) out.reviewCommit = { nonce: node.review.nonce, commit: reviewedCommit };
  if (Array.isArray(node.history)) {
    out.history = L.history ? node.history.slice(-L.history).map((entry) => ({
      nonce: entry.nonce, phase: entry.phase, outcome: entry.outcome, attempt: entry.attempt, receivedAt: entry.receivedAt,
      ...(L.historyText && entry.summary ? { summary: clip(entry.summary, L.historyText) } : {}),
      evidenceCount: Array.isArray(entry.evidence) ? entry.evidence.length : entry.evidenceCount ?? 0,
    })) : [];
  }
  for (const field of ['report', 'review', 'feedback', 'lastFailure']) {
    if (node[field]) out[field] = L.archive && ['feedback', 'lastFailure'].includes(field) ? undefined : compactReport(node[field], L);
  }
  for (const field of ['failureReason', 'runtimeMessage']) if (typeof node[field] === 'string') out[field] = clip(node[field], L.text);
  for (const field of ['active', 'pendingReceipt']) if (node[field]) out[field] = withoutJobCopies(node[field]);
  for (const field of ['eccShortlist', 'visualShortlist']) if (node[field]) out[field] = compactShortlist(node[field], L.why);
  return JSON.parse(JSON.stringify(out)); // drops the undefined fields
}

function compactJob(job) {
  const { runId, workspaceId, receiptDirectory, ecc, visual, promptRecovery, continuation, reportFix, ...rest } = job;
  return { ...rest, ...(promptRecovery ? { promptRecovery: { state: promptRecovery.state } } : {}) };
}

function compactJobs(run, L) {
  const current = new Set(run.nodes.flatMap((node) => [node.active?.nonce, node.pendingReceipt?.nonce]).filter(Boolean));
  const live = (job) => current.has(job.nonce) || ACTIVE_JOB_STATES.has(job.state);
  const finished = (run.jobs ?? []).filter((job) => !live(job));
  const kept = new Set(finished.slice(Math.max(0, finished.length - L.jobs)).map((job) => job.nonce));
  return (run.jobs ?? []).filter((job) => live(job) || kept.has(job.nonce)).map((job) => {
    if (!live(job)) return compactJob(job);
    if (L.liveWhy === Infinity) return job;
    return JSON.parse(JSON.stringify({ ...job, ecc: compactShortlist(job.ecc, Math.max(L.liveWhy, 0)), visual: compactShortlist(job.visual, Math.max(L.liveWhy, 0)) }));
  });
}

/** The stored form of a run at a compaction level. Pure; the in-memory run is never changed. */
export function compactRun(run, level = 0) {
  const L = LEVELS[level];
  const { storageWarning, ...rest } = run;
  const events = run.events ?? [];
  const keptEvents = events.slice(-L.events).map((item) => clipFields(item, L.eventText));
  const omitted = (run.eventsOmitted ?? 0) + events.length - keptEvents.length;
  const reviewCommits = new Map((run.jobs ?? []).filter((job) => job.phase === 'review' && job.sourceCommit).map((job) => [job.nonce, job.sourceCommit]));
  return {
    ...rest,
    // Archived runs keep only the computed token summary; nothing reads an archived run's sessions again.
    ...(L.archive ? { goal: clip(run.goal, 500), acceptedReports: undefined, ...(run.usage ? { usage: { frozen: usageSummary(run.usage) } } : {}) } : {}),
    nodes: (run.nodes ?? []).map((node) => compactNode(node, L, reviewCommits)),
    jobs: L.archive ? [] : compactJobs(run, L),
    events: keptEvents,
    ...(omitted ? { eventsOmitted: omitted } : {}),
  };
}

/** The least compacted form of a live run that fits `budget` file bytes (the deepest live level otherwise). */
export function fitRun(key, run, budget) {
  for (let level = 0; ; level++) {
    const doc = compactRun(run, level);
    const bytes = fileBytes(key, doc);
    if (bytes <= budget || level === DEEPEST_LIVE_LEVEL) return { doc, bytes, level };
  }
}

/** The stored form of an archived run: read-only history, trimmed hard. */
export function archiveRun(run, archivedAt = run.archivedAt) {
  const doc = JSON.parse(JSON.stringify(compactRun(run, LEVELS.length - 1)));
  return { ...doc, archivedAt };
}

/** Archived runs to keep: newest first until the count or byte budget is spent. */
export function retainArchives(archived) {
  const newestFirst = [...archived].sort((a, b) => String(b.archivedAt ?? '').localeCompare(String(a.archivedAt ?? '')));
  const keep = new Set();
  let total = 0;
  for (const run of newestFirst) {
    const size = fileBytes(archiveKey(run.id), run);
    if (keep.size >= MAX_ARCHIVED || total + size > BUDGETS.archives) break;
    keep.add(run.id);
    total += size;
  }
  return { kept: archived.filter((run) => keep.has(run.id)), dropped: archived.filter((run) => !keep.has(run.id)) };
}

class StoreError extends Error {
  constructor(message, runId = null) { super(message); this.code = 'storage_failed'; this.runId = runId; }
}
const invalid = (message) => Object.assign(new Error(message), { code: 'invalid_params' });

function validLegacy(saved) {
  if (saved.version !== 1 || !Array.isArray(saved.runs) || (saved.archivedRuns !== undefined && !Array.isArray(saved.archivedRuns))) {
    throw invalid('저장된 실행 데이터 형식이 지원되지 않습니다. 원본 데이터를 덮어쓰지 않았습니다.');
  }
  if (saved.revision !== undefined && (!Number.isSafeInteger(saved.revision) || saved.revision < 0)) {
    throw invalid('저장된 실행 revision이 올바르지 않습니다. 원본 데이터를 덮어쓰지 않았습니다.');
  }
  return saved;
}
const emptyState = () => ({ version: 2, revision: 0, runs: [], archivedRuns: [] });

/** Reads whatever layout is stored, without writing. */
export async function readStoredState(storage) {
  const problems = [];
  const legacy = await storage.get(LEGACY_KEY);
  const index = await storage.get(INDEX_KEY);
  if (!index) {
    if (legacy === null || legacy === undefined) return { source: 'empty', state: emptyState(), legacy: null, problems, keys: [] };
    const saved = validLegacy(legacy);
    return { source: 'v1', legacy, problems, keys: [], state: {
      version: 2, revision: saved.revision || 0, runs: structuredClone(saved.runs),
      archivedRuns: (saved.archivedRuns ?? []).map((run) => archiveRun(run, run.archivedAt ?? run.updatedAt)),
    } };
  }
  if (index.version !== 2 || !Array.isArray(index.runs) || !Array.isArray(index.archived)) throw invalid('저장된 실행 색인 형식이 지원되지 않습니다. 원본 데이터를 덮어쓰지 않았습니다.');
  let revision = Number.isSafeInteger(index.revision) ? index.revision : 0;
  const keys = [];
  const readAll = async (ids, keyOf, label) => {
    const found = [];
    for (const id of ids) {
      const key = keyOf(id);
      const value = await storage.get(key);
      if (!value?.run || value.run.id !== id) { problems.push(label + ' ' + id + '의 저장 값을 찾을 수 없습니다.'); continue; }
      if (Number.isSafeInteger(value.revision)) revision = Math.max(revision, value.revision);
      keys.push(key);
      found.push(value.run);
    }
    return found;
  };
  const runs = await readAll(index.runs, runKey, '실행');
  const archivedRuns = await readAll(index.archived, archiveKey, '보관 실행');
  // A run written before an index update that never happened: adopt it rather than lose it.
  const listed = new Set([...index.runs, ...index.archived]);
  for (const key of (await storage.keys?.()) ?? []) {
    const prefix = key.startsWith(RUN_PREFIX) ? RUN_PREFIX : key.startsWith(ARCHIVE_PREFIX) ? ARCHIVE_PREFIX : null;
    if (!prefix || listed.has(key.slice(prefix.length))) continue;
    const value = await storage.get(key);
    if (!value?.run?.id) continue;
    keys.push(key);
    listed.add(value.run.id);
    (prefix === RUN_PREFIX ? runs : archivedRuns).push(value.run);
    problems.push('색인에 없던 ' + (prefix === RUN_PREFIX ? '실행' : '보관 실행') + ' ' + value.run.id + '을(를) 복구했습니다.');
  }
  return { source: 'v2', legacy, problems, keys, state: { version: 2, revision, runs, archivedRuns } };
}

export function createRunStore({ storage, log = () => {} }) {
  const written = new Map(); // key → compact JSON of the run body last confirmed in storage
  const known = new Set();   // our keys that exist in storage
  const levels = new Map();
  let writtenIndex = null;

  const put = async (key, value, verify, runId = null) => {
    const json = JSON.stringify(value);
    if (utf8(json) > ORCA_LIMITS.valueBytes) throw new StoreError(key + ' 값이 Orca 한도(' + ORCA_LIMITS.valueBytes + '바이트)를 넘어 저장하지 않았습니다: ' + utf8(json) + '바이트', runId);
    try { await storage.set(key, JSON.parse(json)); } // Orca refuses own properties holding undefined
    catch (error) { throw new StoreError(key + ' 저장 실패: ' + String(error?.message ?? error), runId); }
    known.add(key);
    if (verify && JSON.stringify(await storage.get(key)) !== json) throw new StoreError(key + ': 다시 읽은 값이 저장한 값과 다릅니다.', runId);
  };
  // Archived runs are stored as archiveRun made them; clipping again keeps older archives in budget.
  const compactArchived = (run) => {
    const { storageWarning, ...rest } = run;
    return fileBytes(archiveKey(run.id), rest) <= BUDGETS.archive ? rest : archiveRun(rest);
  };

  async function save(state, { verify = false } = {}) {
    const archives = state.archivedRuns.map((run) => ({ key: archiveKey(run.id), body: compactArchived(run), runId: null }));
    const archiveBytes = archives.reduce((sum, entry) => sum + fileBytes(entry.key, entry.body), 0);
    const share = Math.max(BUDGETS.minRunShare, Math.min(BUDGETS.run, Math.floor((BUDGETS.total - archiveBytes) / Math.max(1, state.runs.length))));
    const runs = state.runs.map((run) => {
      const key = runKey(run.id);
      const { doc, level, bytes } = fitRun(key, run, share);
      if ((levels.get(run.id) ?? 0) !== level) log('Toris Neon storage: 실행 ' + run.id + '을(를) 압축 단계 ' + level + '로 저장합니다 (' + bytes + '바이트, 예산 ' + share + ').');
      levels.set(run.id, level);
      return { key, body: doc, runId: run.id };
    });
    for (const entry of [...runs, ...archives]) {
      const json = JSON.stringify(entry.body);
      if (written.get(entry.key) === json) continue;
      await put(entry.key, { version: 2, revision: state.revision, run: entry.body }, verify, entry.runId);
      written.set(entry.key, json);
    }
    const index = { version: 2, runs: state.runs.map((run) => run.id), archived: state.archivedRuns.map((run) => run.id) };
    const indexJson = JSON.stringify(index);
    if (writtenIndex !== indexJson) {
      await put(INDEX_KEY, { ...index, revision: state.revision }, verify);
      writtenIndex = indexJson;
    }
    // Values the index no longer names go last, so a crash never leaves the index naming a missing value.
    const live = new Set([...runs, ...archives].map((entry) => entry.key));
    for (const key of [...known]) {
      if (key === INDEX_KEY || live.has(key)) continue;
      await storage.delete(key);
      known.delete(key);
      written.delete(key);
    }
  }

  async function load() {
    const read = await readStoredState(storage);
    const { state } = read;
    if (read.source === 'v2') {
      for (const key of read.keys) known.add(key);
      for (const run of state.runs) written.set(runKey(run.id), JSON.stringify(run));
      for (const run of state.archivedRuns) written.set(archiveKey(run.id), JSON.stringify(run));
      writtenIndex = JSON.stringify({ version: 2, runs: state.runs.map((run) => run.id), archived: state.archivedRuns.map((run) => run.id) });
      if (read.legacy && !read.problems.length) {
        await storage.delete(LEGACY_KEY);
        log('Toris Neon storage: 새 저장 구조가 완전해 이전 단일 값(' + LEGACY_KEY + ')을 삭제했습니다.');
      }
      return { state, problems: read.problems, migration: null };
    }
    if (read.source === 'empty') return { state, problems: [], migration: null };
    // One old value: write the new layout, read every value back, then drop the old one.
    const before = utf8(JSON.stringify(read.legacy));
    const { kept, dropped } = retainArchives(state.archivedRuns);
    state.archivedRuns = kept;
    try {
      await save(state, { verify: true });
    } catch (error) {
      // The index is written last, so without it the next start migrates again from the untouched old value.
      written.clear(); writtenIndex = null;
      return { state, problems: [], migration: { ok: false, error: error.message, before } };
    }
    await storage.delete(LEGACY_KEY);
    const after = [...written.values()].reduce((sum, json) => sum + utf8(json), 0);
    return { state, problems: [], migration: { ok: true, runs: state.runs.length, archived: kept.length, droppedArchives: dropped.length, before, after } };
  }

  return { load, save };
}

/**
 * The runtime's persistence: never throws on a failed write. A failure marks the affected runs
 * (run.storageWarning, never stored), notifies once per episode, logs and retries with backoff
 * until a write succeeds; state keeps being served from memory meanwhile.
 */
export function createPersistence({ storage, log = () => {}, notify = () => {}, retry = () => {}, now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (timer) => clearTimeout(timer) }) {
  const store = createRunStore({ storage, log });
  let failure = null;
  let timer = null;
  const schedule = () => {
    if (timer) return;
    const delay = RETRY_DELAYS_MS[Math.min(failure.attempts, RETRY_DELAYS_MS.length) - 1];
    timer = setTimer(() => { timer = null; retry(); }, delay);
    timer?.unref?.();
  };
  return {
    load: () => store.load(),
    failure: () => failure && { ...failure },
    async save(state) {
      try {
        await store.save(state);
      } catch (error) {
        const at = new Date(now()).toISOString();
        const message = String(error?.message ?? error).slice(0, 400);
        const first = !failure;
        failure = { since: failure?.since ?? at, at, attempts: (failure?.attempts ?? 0) + 1, message, runId: error.runId ?? null };
        for (const run of state.runs) {
          if (!failure.runId || failure.runId === run.id) run.storageWarning = { since: failure.since, attempts: failure.attempts, message };
        }
        log('Toris Neon storage: 저장 실패 ' + failure.attempts + '회째, 메모리 상태로 계속 진행합니다: ' + message);
        if (first) notify('Toris Neon: 실행 상태를 저장하지 못했습니다', '진행은 메모리에서 계속되고 저장을 자동으로 다시 시도합니다. ' + message);
        schedule();
        return { ok: false, error: message };
      }
      if (failure) {
        log('Toris Neon storage: 저장이 복구됐습니다 (' + failure.attempts + '회 실패 후).');
        failure = null;
        if (timer) { clearTimer(timer); timer = null; }
      }
      for (const run of state.runs) delete run.storageWarning;
      return { ok: true };
    },
    dispose() { if (timer) clearTimer(timer); timer = null; },
  };
}
