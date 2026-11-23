/**
 * Periodic reconcile of active jobs, so a missed or wrong 'agent.status.changed' can never strand a run.
 * One pass: one agents.list per run with watchable jobs, a receipt check per job, and passes never
 * overlap. The runtime applies the actions through its own queue and event handler.
 */
export const WATCH_INTERVAL_MS = 60_000;
/** An agent waiting on a prompt or permission this long gets a person's attention (never typing). */
export const ATTENTION_AFTER_MS = 3 * 60_000;
/** A turn that ended without a report and nothing pending is nudged after this long. */
export const IDLE_NUDGE_AFTER_MS = 3 * 60_000;
/** A report unchanged this long is taken in even if Orca still says the agent is working. */
export const RECEIPT_SETTLE_MS = 3 * 60_000;
const STATES = new Set(['working', 'blocked', 'waiting', 'done']);

/**
 * What to do for a run's watched jobs, given agents.list rows and `receipts` (nonce → write time in
 * ms, or null when present with an unknown time; absent when there is no report):
 * 'status' replays a state the plugin missed; 'report' takes in a report nobody took in (at once
 * for an idle agent, after RECEIPT_SETTLE_MS for one Orca still calls working); 'idle' nudges an
 * ended turn without a report; 'attention' flags an agent stuck on a prompt or permission.
 * A report refused for its form (job.reportRejectedAt) counts only once rewritten.
 */
export function planJobWatch({ jobs, agents, receipts, now }) {
  const actions = [];
  for (const job of jobs) {
    const agent = agents.find((row) => row.terminalId && row.terminalId === job.terminalId);
    if (!agent || !STATES.has(agent.state)) continue; // a vanished terminal is the explicit refresh's call
    const at = receipts.has(job.nonce) ? receipts.get(job.nonce) : undefined;
    const fresh = at !== undefined && (at === null ? !job.reportRejectedAt : at > (job.reportRejectedAt ?? -Infinity));
    if (agent.state !== job.agentState) {
      actions.push({ kind: 'status', nonce: job.nonce, event: {
        terminalId: job.terminalId, state: agent.state,
        ...(agent.sessionId ? { sessionId: agent.sessionId } : {}),
        ...(Number.isFinite(agent.stateStartedAt) ? { receivedAt: agent.stateStartedAt } : {}),
      } });
      continue;
    }
    const idleMs = Number.isFinite(agent.stateStartedAt) ? now - agent.stateStartedAt : 0;
    const idleMinutes = Math.floor(idleMs / 60_000);
    if (agent.state === 'working') {
      if (fresh && at !== null && now - at >= RECEIPT_SETTLE_MS) actions.push({ kind: 'report', nonce: job.nonce });
    } else if (fresh && agent.state !== 'blocked') {
      actions.push({ kind: 'report', nonce: job.nonce });
    } else if (agent.state === 'done') {
      if (at === undefined && idleMs >= IDLE_NUDGE_AFTER_MS) actions.push({ kind: 'idle', nonce: job.nonce, idleMinutes });
    } else if (idleMs >= ATTENTION_AFTER_MS) {
      actions.push({ kind: 'attention', nonce: job.nonce, state: agent.state, idleMinutes });
    }
  }
  return actions;
}

/**
 * `watched()` returns [{ runId, workspaceId, jobs }] for jobs that were typed and are still the
 * stage's current job; `receiptAt(job)` resolves to the report's write time, null when present with
 * an unknown time, or false when absent; `apply(runId, actions)` runs them. A failing agents.list
 * skips that run only. `afterPass` rides the same timer (token usage, src/usage.mjs); its failure is logged only.
 */
export function createJobWatch({ watched, listAgents, receiptAt, apply, afterPass = async () => {}, now = Date.now, log = () => {} }) {
  let running = null;
  let timer = null;
  const pass = async () => {
    for (const { runId, workspaceId, jobs } of watched()) {
      if (!workspaceId || !jobs.length) continue;
      let agents;
      try { agents = await listAgents(workspaceId); }
      catch (error) { log('Toris Neon watch: ' + runId + ' 에이전트 상태를 읽지 못했습니다: ' + String(error?.message ?? error)); continue; }
      const receipts = new Map();
      for (const job of jobs) {
        const at = await receiptAt(job);
        if (at !== false) receipts.set(job.nonce, Number.isFinite(at) ? at : null);
      }
      const actions = planJobWatch({ jobs, agents, receipts, now: now() });
      if (actions.length) await apply(runId, actions);
    }
    try { await afterPass(); } catch (error) { log('Toris Neon watch: ' + String(error?.message ?? error)); }
  };
  const tick = () => {
    running ??= pass().finally(() => { running = null; });
    return running;
  };
  return {
    tick,
    start(every = WATCH_INTERVAL_MS) {
      if (timer || !(every > 0)) return;
      timer = setInterval(() => { tick().catch((error) => log('Toris Neon watch: ' + String(error?.message ?? error))); }, every);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
