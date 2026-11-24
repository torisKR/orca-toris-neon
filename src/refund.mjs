/**
 * Attempts whose agent never started work do not use up a stage's attempts, as releaseClaim
 * (src/engine.mjs) refunds an undelivered prompt. Two ways in:
 * - automatic: a job stopped on an agent screen with its terminal closed (src/agentscreen.mjs)
 *   and no work evidence;
 * - a person's retry of a stage at its limit, once per stage, for attempts from before that record
 *   existed: all of them must show no work evidence (workEvidence, src/sending.mjs), else the limit stays.
 */
const FINISHED = new Set(['complete', 'undelivered', 'cancelled']); // worked, already refunded, or cancelled
export const NO_WORK = '보고서 없음, 결과 폴더에 brief.md만, sessionId 없음 (사람의 재시도)';
const counter = (phase) => phase === 'review' ? 'reviewAttempts' : 'attempts';

/** A copy of run with each named job's attempt given back and the job marked refunded. */
export function refundAttempts(run, nodeId, nonces, { at, reason, manual = false }) {
  const next = structuredClone(run);
  const node = next.nodes.find((item) => item.id === nodeId);
  const jobs = (next.jobs ?? []).filter((job) => job.nodeId === nodeId && nonces.includes(job.nonce) && !job.refunded);
  for (const job of jobs) {
    node[counter(job.phase)] = Math.max(0, (node[counter(job.phase)] ?? 0) - 1);
    job.refunded = { at, reason };
  }
  if (manual && jobs.length) node.attemptRefund = { at, nonces: jobs.map((job) => job.nonce) };
  return { run: next, count: jobs.length };
}

/**
 * For a person's retry: null when the stage is below its limit or has nothing to refund,
 * { refused } when a refund is not allowed, or { nonces } to refund. evidenceOf(job) → text | null.
 */
export async function planManualRefund(run, nodeId, { evidenceOf }) {
  const node = run.nodes.find((item) => item.id === nodeId);
  const phase = node.blockedPhase === 'review' && node.report?.outcome === 'passed' ? 'review' : 'work'; // as retryNode
  if ((node[counter(phase)] ?? 0) < run.maxAttempts) return null;
  const jobs = (run.jobs ?? []).filter((job) => job.nodeId === nodeId && job.phase === phase && !job.refunded && !FINISHED.has(job.state));
  if (!jobs.length) return null;
  if (node.attemptRefund) return { refused: '이 단계의 시작하지 않은 시도는 이미 한 번 되돌렸습니다.' };
  const worked = [];
  for (const job of jobs) {
    let evidence;
    try { evidence = await evidenceOf(job); }
    catch (error) { evidence = '결과 폴더를 읽지 못함(' + String(error?.message ?? error).slice(0, 120) + ')'; }
    if (evidence) worked.push(job.nonce.slice(0, 8) + ': ' + evidence);
  }
  if (worked.length) return { refused: '일한 근거가 있는 시도가 있어 되돌리지 않았습니다 (' + worked.join('; ') + ').' };
  return { nonces: jobs.map((job) => job.nonce) };
}

