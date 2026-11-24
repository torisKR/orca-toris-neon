/**
 * A prompt intent still 'sending' after a worker restart: the old worker saved the intent and died
 * before hearing Orca's answer (the dev-loaded plugin restarts on every file save). Typing again
 * could duplicate the work, so the intent is settled only from evidence that the prompt arrived:
 * a turn already seen, the agent busy on its terminal, a report in the receipt folder, or an agent
 * whose 'done' began after the send. Anything less stays uncertain.
 */
const BUSY = new Set(['working', 'blocked']);

/** Why the prompt is known to have arrived, or null when it is truly unknown. */
export function sendingEvidence({ job, agent, receipt }) {
  // promptSeen alone is weak: Orca's prompt-submit status hook sets it even when Codex is stuck on its
  // hook-review modal and no model turn runs (live run, 2026-11-24). It counts only with a session.
  if (job.promptSeen && job.sessionId) return '에이전트가 작업을 시작한 기록(세션 ' + job.sessionId + ')';
  if (BUSY.has(agent?.state)) return 'Orca 에이전트 상태 ' + agent.state;
  if (receipt) return '결과 폴더의 보고서';
  const since = Date.parse(job.promptRecovery?.at ?? '');
  if (agent?.state === 'done' && Number.isFinite(agent.stateStartedAt) && Number.isFinite(since) && agent.stateStartedAt > since) {
    return '전달 요청 뒤에 작업을 마친 에이전트 상태';
  }
  return null;
}

/**
 * Why a finished attempt may have done work, or null: its agent session, or any file in its result
 * folder besides the brief Neon wrote (a report included). promptSeen is not used, for the reason above.
 */
export function workEvidence({ job, files }) {
  if (job.sessionId) return 'sessionId ' + job.sessionId;
  const written = files.filter((name) => name !== 'brief.md');
  return written.length ? '결과 폴더 파일 ' + written.slice(0, 3).join(', ') : null;
}
