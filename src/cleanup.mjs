/**
 * Closes the agent terminals the plugin opened for jobs that are over (report accepted, superseded,
 * cancelled, undelivered), so finished agents do not pile up. Never touches the terminal of a stage's
 * current job, one awaiting a report or its correction, one whose delivery is uncertain, or any
 * terminal it did not open. Closing ends the process only; the agent's session stays resumable.
 */
export const CLOSE_GRACE_MS = 2 * 60_000;
export const CLEANUP_INTERVAL_MS = 60_000;
export const MAX_CLOSE_ATTEMPTS = 5;
const FINISHED = new Set(['complete', 'superseded', 'cancelled', 'undelivered']);

/** The per-run switch: on by default in autonomous runs, off otherwise; an explicit choice wins. */
export const closesFinishedTerminals = (run) => typeof run.closeFinishedTerminals === 'boolean' ? run.closeFinishedTerminals : run.autonomous === true;

/** Jobs whose terminal may be closed now. A job with no end time counts as long finished. */
export function closeCandidates(run, { now, graceMs = CLOSE_GRACE_MS }) {
  if (!closesFinishedTerminals(run)) return [];
  const current = new Set((run.nodes ?? []).flatMap((node) => [node.active?.nonce, node.pendingReceipt?.nonce]).filter(Boolean));
  const jobs = run.jobs ?? [];
  const live = (job) => current.has(job.nonce) || !FINISHED.has(job.state);
  const inUse = new Set(jobs.filter((job) => live(job) && job.terminalId).map((job) => job.terminalId));
  return jobs.filter((job) => job.terminalId && !live(job) && !inUse.has(job.terminalId) && !job.terminalClosed &&
    (job.closeAttempts ?? 0) < MAX_CLOSE_ATTEMPTS && now - (Date.parse(job.completedAt ?? '') || 0) >= graceMs);
}

/**
 * `runs()` gives the live runs; per run with candidates, `listTerminals(workspaceId)` (a list, or
 * Orca's { terminals, truncated }) and
 * `listAgents(workspaceId)` are read once. An idle agent (done) or a plain shell is closed; a
 * vanished terminal is marked gone; a working, waiting or blocked agent is left and reported.
 * `record(run, job, outcome)` stores each outcome; nothing here throws for one terminal.
 */
export function createTerminalCleanup({ runs, listTerminals, listAgents, close, record, now = Date.now, graceMs = CLOSE_GRACE_MS }) {
  let running = null;
  const pass = async () => {
    const summary = { closed: [], gone: [], kept: [], failed: [], skipped: [] };
    for (const run of runs()) {
      const candidates = closeCandidates(run, { now: now(), graceMs });
      if (!candidates.length) continue;
      let terminals, agents, truncated = false;
      try {
        const listed = await listTerminals(run.workspaceId);
        truncated = !Array.isArray(listed) && listed.truncated === true;
        terminals = new Set((Array.isArray(listed) ? listed : listed.terminals ?? []).map((terminal) => terminal.id));
        agents = await listAgents(run.workspaceId);
      } catch (error) {
        summary.skipped.push({ runId: run.id, reason: String(error?.message ?? error) });
        continue;
      }
      for (const job of candidates) {
        const entry = { runId: run.id, nonce: job.nonce, terminalId: job.terminalId, sessionId: job.sessionId ?? null };
        if (!terminals.has(job.terminalId)) { // only a complete list proves a terminal is gone
          if (!truncated) { summary.gone.push(entry); record(run, job, { kind: 'gone' }); }
          continue;
        }
        const agent = agents.find((row) => row.terminalId === job.terminalId);
        if (agent && agent.state !== 'done') {
          summary.kept.push({ ...entry, state: agent.state });
          record(run, job, { kind: 'kept', state: agent.state });
          continue;
        }
        try {
          if ((await close(job.terminalId))?.closed !== true) throw new Error('Orca가 터미널 종료를 확인하지 않았습니다.');
          summary.closed.push(entry);
          record(run, job, { kind: 'closed', sessionId: entry.sessionId });
        } catch (error) {
          summary.failed.push({ ...entry, error: String(error?.message ?? error) });
          record(run, job, { kind: 'failed', error: String(error?.message ?? error) });
        }
      }
    }
    return summary;
  };
  return { sweep: () => (running ??= pass().finally(() => { running = null; })) };
}

/** Stores a sweep outcome on the job: closed or gone (with its session id), kept (logged once per state), or a failed try. */
export function cleanupRecorder({ log, appendEvent, at, where }) {
  return (run, job, outcome) => {
    const place = where(run, job);
    if (outcome.kind === 'kept') {
      if (job.terminalKept?.state !== outcome.state) log('Toris Neon cleanup: ' + job.terminalId + ' 터미널은 에이전트가 ' + outcome.state + ' 상태라 닫지 않았습니다 (' + place + ').');
      job.terminalKept = { state: outcome.state, at: at() };
    } else if (outcome.kind === 'failed') {
      job.closeAttempts = (job.closeAttempts ?? 0) + 1;
      job.closeError = String(outcome.error).slice(0, 200);
      log('Toris Neon cleanup: ' + job.terminalId + ' 터미널을 닫지 못했습니다 (' + job.closeAttempts + '/' + MAX_CLOSE_ATTEMPTS + '): ' + outcome.error);
    } else {
      delete job.terminalKept;
      job.terminalClosed = { at: at(), ...(outcome.kind === 'gone' ? { gone: true } : {}), ...(job.sessionId ? { sessionId: job.sessionId } : {}) };
      if (outcome.kind === 'closed') appendEvent(run, place + ' 에이전트의 끝난 터미널을 닫았습니다' + (job.sessionId ? ' (세션 ' + job.sessionId + ', 이 세션으로 다시 열 수 있습니다).' : '.'),
        { nodeId: job.nodeId, nonce: job.nonce, terminalId: job.terminalId, ...(job.sessionId ? { sessionId: job.sessionId } : {}) });
    }
  };
}

/** One line for the log, or '' when the sweep found nothing to do. */
export function describeSweep(summary) {
  const counts = ['closed', 'gone', 'kept', 'failed', 'skipped'].map((key) => summary[key].length);
  if (!counts.some(Boolean)) return '';
  return '닫음 ' + counts[0] + ', 이미 없음 ' + counts[1] + ', 남김 ' + counts[2] + ', 실패 ' + counts[3] + ', 조회 불가 실행 ' + counts[4] +
    summary.kept.map((item) => ' · 남김 ' + item.terminalId + ' (' + item.state + ')').join('') + summary.failed.map((item) => ' · 실패 ' + item.terminalId + ': ' + item.error).join('');
}

/** Per run, for the run card: terminals closed, already gone, failed to close (why), kept (why). */
export function cleanupSummary(run) {
  const jobs = run.jobs ?? [];
  const closed = jobs.filter((job) => job.terminalClosed && !job.terminalClosed.gone).length;
  const gone = jobs.filter((job) => job.terminalClosed?.gone).length;
  const failed = jobs.filter((job) => !job.terminalClosed && job.closeAttempts).map((job) => ({ terminalId: job.terminalId, attempts: job.closeAttempts, error: job.closeError ?? null }));
  const kept = jobs.filter((job) => !job.terminalClosed && job.terminalKept).map((job) => ({ terminalId: job.terminalId, state: job.terminalKept.state }));
  return closed || gone || failed.length || kept.length ? { closed, gone, failed, kept } : null;
}
