/**
 * What the 에이전트 tab and the run card say about each assignment Neon holds now: its phase, when it
 * last moved, and which kind of stop it is in. An execution error, a wait for the person and an
 * unclear delivery are kept apart. Read from the jobs ledger only; nothing is estimated.
 */
const FAILED_OUTCOMES = new Set(['failure', 'cancellation', 'superseded', 'interruption']); // as src/runtime.mjs

/**
 * CPU and memory of the agents Neon launched. Orca's host API returns terminal ids, not process ids,
 * so there is nothing Neon can attribute; the panel says 미측정 instead of a number.
 */
export const RESOURCE_MEASUREMENT = Object.freeze({
  measured: false,
  reason: 'Orca 호스트 API(terminal.list, agents.list)가 Neon 터미널의 프로세스 ID를 주지 않아 CPU·메모리를 측정할 수 없습니다.'
});

/** unclear | error | needs-user | report | launching | idle | unknown | working, most urgent first. */
export function jobCondition(job) {
  if (job.state === 'uncertain' || job.promptRecovery?.state === 'uncertain') return 'unclear';
  if (job.state === 'not-started' || FAILED_OUTCOMES.has(job.agentOutcome)) return 'error';
  if (['waiting', 'blocked'].includes(job.agentState)) return 'needs-user';
  if (job.state === 'awaiting-report') return 'report';
  if (job.state === 'launching' || (job.selfDelivery && !job.promptRecovery)) return 'launching';
  if (job.agentState === 'done') return 'idle';
  return job.agentState === 'working' ? 'working' : 'unknown'; // no agent state reported yet: not claimed as working
}

const msOf = (value) => typeof value === 'number' ? value : Date.parse(value ?? '');

/** The newest recorded moment of a job (start, ready, prompt sent, agent state change, failure), or null. */
export function lastProgressAt(job) {
  const times = [job.startedAt, job.readyAt, job.promptRecovery?.at, job.lastAgentEventAt, job.failedAt].map(msOf).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

/** Each stage's current jobs (active, awaiting its report), for the panel. A job with no record reads as unclear. */
export function runOperations(run) {
  const jobs = new Map((run.jobs ?? []).map((job) => [job.nonce, job]));
  return (run.nodes ?? []).flatMap((node) => [...new Set([node.active, node.pendingReceipt].filter((item) => item?.nonce).map((item) => item.nonce))].map((nonce) => {
    const holder = node.active?.nonce === nonce ? node.active : node.pendingReceipt;
    const job = jobs.get(nonce) ?? { ...holder, state: 'uncertain', startedAt: null, promptRecovery: undefined, lastAgentEventAt: undefined, readyAt: undefined, failedAt: undefined };
    return {
      nodeId: node.id, phase: job.phase ?? null, agent: job.agent ?? null, attempt: job.attempt ?? null, terminalId: job.terminalId ?? null,
      condition: jobCondition(job), lastProgressAt: lastProgressAt(job)
    };
  }));
}
