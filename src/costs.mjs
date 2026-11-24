/**
 * Where a run's time and tokens went, per stage and phase: minutes an agent worked, minutes the
 * stage waited (queued for a slot or a review, blocked, or stuck before its agent started work),
 * and tokens from the existing usage ledger (src/usage.mjs). Read from the stored jobs only. A job
 * without a recorded end ends at the agent's last state change or the next attempt's start; with
 * neither (or no readable start) it is counted as unknown instead of guessed.
 */
import { usageSummary } from './usage.mjs';

const MINUTE = 60_000;
const LIVE = new Set(['launching', 'running']);
const FINISHED = new Set(['completed', 'cancelled']);
const toMs = (value) => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
const minutes = (value) => Math.round(value / MINUTE);
const span = (from, to) => Number.isFinite(from) && Number.isFinite(to) && to > from ? to - from : 0;

/** When the job stopped: its report, its failed turn, now while it runs, else the agent's last event or the next job. */
function endOf(job, next, now, node) {
  const end = toMs(job.completedAt ?? job.failedAt);
  if (Number.isFinite(end)) return end;
  if (LIVE.has(job.state) && node.active?.nonce === job.nonce) return now; // a stale 'running' state never grows
  const last = toMs(job.lastAgentEventAt);
  if (Number.isFinite(last)) return last;
  return next ? toMs(next.startedAt) : NaN;
}

/** When every dependency had passed, if the stored stages still say so. */
function readyAt(run, node) {
  if (!node.deps?.length) return NaN;
  const times = node.deps.map((id) => toMs(run.nodes.find((item) => item.id === id)?.completedAt));
  return times.every(Number.isFinite) ? Math.max(...times) : NaN;
}

function stageTime(run, node, jobs, now) {
  const time = { work: 0, review: 0, waiting: 0, unknown: 0 };
  let previousEnd = NaN;
  jobs.forEach((job, index) => {
    const start = toMs(job.startedAt), end = endOf(job, jobs[index + 1], now, node);
    const before = jobs[index - 1];
    // A passed review ends the stage; a later job means a repair loop reopened it, not that it waited.
    const reopened = before?.phase === 'review' && before.outcome === 'passed';
    if (index === 0) time.waiting += Math.max(0, span(readyAt(run, node), start));
    else if (!reopened) time.waiting += span(previousEnd, start);
    if (!Number.isFinite(start) || !Number.isFinite(end)) { time.unknown++; previousEnd = NaN; return; }
    if (job.promptSeen) time[job.phase === 'review' ? 'review' : 'work'] += span(start, end);
    else time.waiting += span(start, end); // stuck before work started (a screen, an undelivered prompt)
    previousEnd = end;
  });
  const idle = !node.active && !['passed', 'skipped'].includes(node.status) && !FINISHED.has(run.status);
  if (idle && jobs.length) time.waiting += span(previousEnd, now); // blocked or queued right now
  return time;
}

/** { stages: { [id]: { work, review: { minutes, tokens }, waitingMinutes, unknown } }, total }. */
export function stageCosts(run, { now = Date.now() } = {}) {
  const tokens = run.usage ? usageSummary(run.usage) : null;
  const stages = {};
  const sum = { worked: 0, waiting: 0, unknown: 0 };
  for (const node of run.nodes) {
    if (node.status === 'skipped') continue;
    const jobs = (run.jobs ?? []).filter((job) => job.nodeId === node.id).sort((a, b) => toMs(a.startedAt) - toMs(b.startedAt));
    const used = tokens?.stages?.[node.id];
    if (!jobs.length && !used) continue;
    const time = stageTime(run, node, jobs, now);
    stages[node.id] = { work: { minutes: minutes(time.work), tokens: used?.work ?? null }, review: { minutes: minutes(time.review), tokens: used?.review ?? null },
      waitingMinutes: minutes(time.waiting), unknown: time.unknown };
    sum.worked += time.work + time.review;
    sum.waiting += time.waiting;
    sum.unknown += time.unknown;
  }
  return { stages, total: { workedMinutes: minutes(sum.worked), waitingMinutes: minutes(sum.waiting), tokens: tokens?.total ?? null, tokenScope: tokens?.scope ?? null, unknown: sum.unknown } };
}
