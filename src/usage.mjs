/**
 * Token usage of Neon runs (plan 6.6), read from Orca's agent.listSessions (host API 1.9).
 *
 * Only sessions tied to a run's own jobs count (agent + sessionId, the host pinned at first sight).
 * Orca reports a session's running total, so a ledger keeps the latest total per session, never a
 * sum of observations. A session the job did not start counts only above a baseline seen before
 * the job's prompt was typed; without one it is a session total and stays out of the run's total.
 * A missing, smaller, zero or unreadable value never replaces a stored one silently and never reads
 * as 0 or complete. Nothing here launches, scans transcripts or fails a job.
 */
export const USAGE_METHOD = 'agent.listSessions';
export const SESSION_LIMIT = 200; // the API's maximum
/** Checks after a run ends, for totals Orca records late; then the run is left alone. */
export const FINAL_CHECKS = 2;
/** A smaller total seen this many checks in a row is a correction, not a stale read. */
export const LOWER_CONFIRMATIONS = 2;
/** Failed reads after a run ends before it is left alone (an unsupported Orca counts as one each pass). */
export const FINAL_FAILURES = 5;
/** A listSessions read that has not answered by then is a failed read; the job watch shares the pass. */
export const READ_TIMEOUT_MS = 15_000;
/** A session created this close before the job started is still the job's own. */
const FRESH_SKEW_MS = 5_000;
const FINISHED = new Set(['completed', 'cancelled']);
const UNSUPPORTED_CODES = new Set(['unknown_method', 'not_permitted']);

const norm = (agent) => String(agent ?? '').trim().toLowerCase();
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const without = (item, ...keys) => Object.fromEntries(Object.entries(item).filter(([key]) => !keys.includes(key)));

/** The ledger with every job that reached a terminal: an owner of its session, or unmapped until Orca names one. */
export function registerJobs(usage = { sessions: [], unmapped: [] }, jobs = []) {
  let sessions = usage.sessions ?? [];
  let unmapped = usage.unmapped ?? [];
  for (const job of jobs) {
    if (!job?.nonce || !job.terminalId) continue; // never reached Orca: no session to expect
    const owned = sessions.some((entry) => entry.owners.some((owner) => owner.nonce === job.nonce));
    if (!job.sessionId) {
      if (!owned && !unmapped.some((item) => item.nonce === job.nonce)) unmapped = [...unmapped, { nonce: job.nonce, nodeId: job.nodeId }];
      continue;
    }
    unmapped = unmapped.filter((item) => item.nonce !== job.nonce);
    const owner = { nonce: job.nonce, nodeId: job.nodeId, phase: job.phase, attempt: job.attempt ?? 1, startedAt: job.startedAt ?? null };
    const index = sessions.findIndex((entry) => entry.sessionId === job.sessionId && norm(entry.agent) === norm(job.agent));
    if (index === -1) sessions = [...sessions, { agent: job.agent, sessionId: job.sessionId, hostId: null, owners: [owner], latest: null }];
    else if (!sessions[index].owners.some((item) => item.nonce === job.nonce)) {
      sessions = sessions.map((entry, at) => at === index ? { ...entry, owners: [...entry.owners, owner] } : entry);
    }
  }
  return { ...usage, sessions, unmapped };
}

// 0 for a session created after its first job started; the total seen before any owner's prompt
// was typed; null (a session total only) when neither is known. Decided once.
function baselineFor(entry, row, value, typed) {
  const started = Math.min(...entry.owners.map((owner) => Date.parse(owner.startedAt ?? '')).filter(Number.isFinite));
  if (Number.isFinite(row.createdAt) && Number.isFinite(started) && row.createdAt >= started - FRESH_SKEW_MS) return 0;
  if (value > 0 && entry.owners.every((owner) => !typed.has(owner.nonce))) return value;
  return value > 0 ? null : undefined; // a bare 0 decides nothing yet
}

// The next stored total: larger replaces; smaller is held until confirmed; 0 is never taken as no use.
function acceptValue(entry, value, at) {
  const latest = entry.latest;
  if (latest === null) return value === 0 ? { ...entry, zero: true } : without({ ...entry, latest: value }, 'zero', 'lower');
  if (value >= latest) return without({ ...entry, latest: value }, 'lower', 'zero');
  const seen = entry.lower?.value === value ? entry.lower.seen + 1 : 1;
  if (value === 0 || seen < LOWER_CONFIRMATIONS) return { ...entry, lower: { value, seen } };
  return without({ ...entry, latest: value, corrected: { from: latest, to: value, at } }, 'lower');
}

function observeOne(entry, rows, { truncated, workspaceId, at, typed }) {
  const row = rows.find((item) => item?.sessionId === entry.sessionId && norm(item.agent) === norm(entry.agent) &&
    (entry.hostId === null || item.hostId === entry.hostId) && (item.workspaceId == null || item.workspaceId === workspaceId));
  // A gap breaks a run of smaller reads: the next smaller value starts its count again.
  if (!row || !count(row.totalTokens)) return { ...without(entry, 'lower'), missing: row ? 'invalid' : truncated ? 'truncated' : 'absent' };
  const seen = { ...without(entry, 'missing'), hostId: entry.hostId ?? (typeof row.hostId === 'string' ? row.hostId : null), observedAt: at };
  if (seen.baseline === undefined) {
    const baseline = baselineFor(entry, row, row.totalTokens, typed);
    if (baseline !== undefined) seen.baseline = baseline;
  }
  return acceptValue(seen, row.totalTokens, at);
}

/** One successful listSessions read applied to the ledger; `typed` holds jobs whose prompt went in. */
export function observeSessions(usage, { rows, truncated = false, workspaceId, at, typed = new Set() }) {
  const sessions = (usage.sessions ?? []).map((entry) => observeOne(entry, rows, { truncated, workspaceId, at, typed }));
  return { ...without(usage, 'error', 'failedAt', 'source'), source: 'ok', checkedAt: at, sessions };
}

/** A read that failed or an Orca without the API: stored totals stay, the scope narrows. */
export function failedCheck(usage, { unsupported = false, error = '', at }) {
  return { ...usage, source: unsupported ? 'unsupported' : 'error', error: String(error || '알 수 없는 오류').slice(0, 300), failedAt: at };
}

const meaningful = (usage) => JSON.stringify(usage ?? null, (key, value) => ['checkedAt', 'observedAt', 'failedAt'].includes(key) ? undefined : value);
const typedJobs = (jobs) => new Set(jobs.filter((job) => !job.selfDelivery || job.promptRecovery).map((job) => job.nonce));

/** The run's next ledger for one observation; `changed` is false when only check times moved. */
export function updateUsage(run, observation, at) {
  const jobs = run.jobs ?? [];
  const registered = registerJobs(run.usage, jobs);
  let usage = observation.rows
    ? observeSessions(registered, { ...observation, at, typed: typedJobs(jobs) })
    : failedCheck(registered, { ...observation, at });
  // After the run ends only successful reads use up the final checks; failures have their own cap.
  if (FINISHED.has(run.status)) usage = observation.rows ? { ...usage, finalChecks: (usage.finalChecks ?? 0) + 1 } : { ...usage, finalFailures: (usage.finalFailures ?? 0) + 1 };
  return { usage, changed: meaningful(run.usage) !== meaningful(usage) };
}

/** Runs worth a read: live ones with a launched job, finished ones for their few final checks. */
export function usageTargets(runs) {
  return runs.filter((run) => run.workspaceId && !run.usage?.frozen &&
    ((run.jobs ?? []).some((job) => job.terminalId) || run.usage?.sessions?.length) &&
    (!FINISHED.has(run.status) || ((run.usage?.finalChecks ?? 0) < FINAL_CHECKS && (run.usage?.finalFailures ?? 0) < FINAL_FAILURES)))
    .map((run) => ({ runId: run.id, workspaceId: run.workspaceId }));
}

/** One pass: one listSessions per workspace shared by its runs; `apply(runId, observation)` stores it. */
function withTimeout(promise, ms) {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(ms / 1000 + '초 안에 응답하지 않았습니다.')), ms); timer.unref?.(); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}

export function createUsageSync({ targets, supported, listSessions, apply, log = () => {}, timeoutMs = READ_TIMEOUT_MS }) {
  return async function sync() {
    const groups = new Map();
    for (const { runId, workspaceId } of targets()) groups.set(workspaceId, [...(groups.get(workspaceId) ?? []), runId]);
    for (const [workspaceId, runIds] of groups) {
      let observation;
      if (!supported()) observation = { unsupported: true, error: '현재 Orca가 ' + USAGE_METHOD + '를 제공하지 않습니다.' };
      else {
        try {
          const result = await withTimeout(Promise.resolve().then(() => listSessions(workspaceId)), timeoutMs);
          observation = Array.isArray(result?.sessions)
            ? { rows: result.sessions, truncated: result.truncated === true, workspaceId }
            : { error: '세션 목록 응답 형식이 올바르지 않습니다.' };
        } catch (error) {
          observation = { unsupported: UNSUPPORTED_CODES.has(error?.code), error: String(error?.message || error?.code || error || '알 수 없는 오류') };
        }
      }
      if (observation.error) log('Toris Neon usage: ' + workspaceId + ' 토큰 사용량을 읽지 못했습니다: ' + observation.error);
      for (const runId of runIds) {
        // One run's failure to store never skips the others; the job watch never sees it.
        try { await apply(runId, observation); }
        catch (error) { log('Toris Neon usage: 실행 ' + runId + '의 토큰 사용량을 저장하지 못했습니다: ' + String(error?.stack ?? error?.message ?? error)); }
      }
    }
  };
}

/** The runtime's wiring: reads through `host`, applies inside the runtime queue, persists real changes only. */
export function runtimeUsageSync({ host, runs, queue, persist, at, log }) {
  return createUsageSync({
    targets: () => usageTargets(runs()), log,
    supported: () => typeof host.has !== 'function' || host.has(USAGE_METHOD),
    listSessions: (workspaceId) => host.call(USAGE_METHOD, { workspaceId, limit: SESSION_LIMIT }),
    apply: (runId, observation) => queue(async () => {
      const run = runs().find((item) => item.id === runId);
      if (!run) return;
      const next = updateUsage(run, observation, at());
      run.usage = next.usage;
      if (!next.changed) return;
      const invalid = next.usage.sessions?.filter((entry) => entry.missing === 'invalid').length;
      if (invalid) log('Toris Neon usage: 실행 ' + runId + '의 세션 ' + invalid + '개가 totalTokens를 정수로 주지 않았습니다.');
      await persist();
    }),
  });
}

// What one session adds to the run: its total above the baseline; 'session' when only the session's
// own total is known (no baseline, or corrected below it); 'waiting' while nothing usable was seen
// (no value, or a resumed session that has not grown past its baseline yet).
function amountOf(entry) {
  if (!count(entry.latest)) return 'waiting';
  if (entry.baseline === null || (count(entry.baseline) && entry.latest < entry.baseline)) return 'session';
  if (!count(entry.baseline) || (entry.baseline > 0 && entry.latest === entry.baseline)) return 'waiting';
  return entry.latest - entry.baseline;
}
const stageFor = (stages, nodeId) => stages[nodeId] ??= { work: null, review: null, retry: 0, total: 0, uncounted: 0, uncertain: 0, agents: { work: [], review: [] } };
const stageOf = (owners) => owners.every((owner) => owner.nodeId === owners[0].nodeId && owner.phase === owners[0].phase) ? owners[0] : null;

/** What the panel shows: totals of counted sessions, their stage split where proven, and the scope. */
export function usageSummary(usage) {
  if (usage?.frozen) return usage.frozen;
  // A damaged stored ledger must not break saving or the summary of every other run.
  try { return summarize(usage); }
  catch (error) {
    return { scope: 'unavailable', total: null, retry: 0, unattributed: 0, sessionTotal: null, stages: {}, counts: { sessions: 0, counted: 0, unmapped: 0 },
      checkedAt: usage?.checkedAt ?? null, failedAt: null, error: '저장된 토큰 기록을 읽지 못했습니다: ' + String(error?.message ?? error) };
  }
}

function summarize(usage) {
  const sessions = usage?.sessions ?? [];
  const counts = { sessions: sessions.length, counted: 0, waiting: 0, sessionOnly: 0, missing: 0, truncated: 0, invalid: 0, lower: 0, corrected: 0, unmapped: usage?.unmapped?.length ?? 0 };
  let total = 0, retry = 0, unattributed = 0, sessionTotal = 0;
  const stages = {};
  for (const entry of sessions) {
    if (entry.missing === 'truncated') counts.truncated++;
    else if (entry.missing === 'invalid') counts.invalid++;
    else if (entry.missing) counts.missing++;
    if (entry.lower) counts.lower++;
    if (entry.corrected) counts.corrected++;
    const amount = amountOf(entry);
    const owner = stageOf(entry.owners);
    const stage = owner ? stageFor(stages, owner.nodeId) : null;
    if (stage && (entry.missing || entry.lower || typeof amount !== 'number')) stage.uncertain++;
    if (typeof amount !== 'number') {
      if (amount === 'session') { counts.sessionOnly++; sessionTotal += entry.latest; }
      else counts.waiting++;
      if (stage) stage.uncounted++;
      continue;
    }
    counts.counted++;
    total += amount;
    if (!stage) { unattributed += amount; continue; }
    const phase = owner.phase === 'review' ? 'review' : 'work';
    stage[phase] = (stage[phase] ?? 0) + amount;
    stage.total += amount;
    if (!stage.agents[phase].includes(entry.agent)) stage.agents[phase] = [...stage.agents[phase], entry.agent];
    if (entry.owners.every((item) => item.attempt > 1)) { stage.retry += amount; retry += amount; }
  }
  for (const { nodeId } of usage?.unmapped ?? []) stageFor(stages, nodeId).uncertain++; // a launched job Orca has not named a session for
  const failed = usage?.source === 'error' || usage?.source === 'unsupported';
  const incomplete = failed || counts.waiting || counts.sessionOnly || counts.missing || counts.truncated || counts.invalid || counts.lower || counts.unmapped;
  const scope = usage?.source === 'unsupported' ? 'unavailable'
    : !counts.counted ? (failed || counts.invalid ? 'unavailable' : counts.sessionOnly ? 'session' : 'pending')
      : incomplete ? 'partial' : 'complete';
  return {
    scope, total: counts.counted && scope !== 'unavailable' ? total : null, retry, unattributed,
    sessionTotal: counts.sessionOnly ? sessionTotal : null, stages, counts,
    checkedAt: usage?.checkedAt ?? null, failedAt: usage?.failedAt ?? null, error: usage?.error ?? null,
  };
}
