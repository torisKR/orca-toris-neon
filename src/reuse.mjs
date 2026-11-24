/**
 * Plan 4.4: a follow-up run reuses its parent's evidence while it is still valid. At creation it
 * records what each reviewed stage of the parent was verified on (the review's source fingerprint
 * and commit); at each launch the new workspace's fingerprint marks every item fresh or stale.
 * Also the last commit of a project that passed verification, from which a release update
 * re-verifies only what changed.
 */
const MAX_ITEMS = 20;
const reviewedCommit = (run, node) => (run.jobs ?? []).find((job) => job.nonce === node.review?.nonce)?.sourceCommit ??
  (node.reviewCommit?.nonce === node.review?.nonce ? node.reviewCommit?.commit : null) ?? null;

/** Each passed, reviewed stage of `run`: what it found and the source it was verified on. */
export function verifiedEvidence(run) {
  return run.nodes.filter((node) => node.status === 'passed' && node.review?.outcome === 'passed').slice(0, MAX_ITEMS).map((node) => ({
    nodeId: node.id, title: node.title, summary: String(node.report?.summary ?? '').slice(0, 300),
    fingerprint: node.review.sourceFingerprint ?? null, commit: reviewedCommit(run, node), at: node.completedAt ?? null,
  }));
}

/**
 * The evidence marked against the current source: fresh only for the same fingerprint. A source
 * that cannot be measured matches nothing, so its evidence is stale and the reason is kept.
 */
export async function markFreshness(evidence, measure) {
  if (!evidence?.length) return null;
  let current = null, reason = null;
  try { current = await measure(); } catch (error) { reason = String(error?.message ?? error).slice(0, 200); }
  const items = evidence.map((item) => ({ ...item, freshness: current && item.fingerprint === current ? 'fresh' : 'stale' }));
  return reason ? { items, reason } : { items };
}

/** { parentEvidence } for a launch of a follow-up run, measuring its workspace once; {} otherwise. */
export async function parentEvidenceOf(run, measure) {
  const marked = await markFreshness(run.improvement?.parent?.evidence, measure);
  return marked ? { parentEvidence: marked } : {};
}

export const CHANGED_BEFORE_DELIVERY = '작업 지시를 전달하기 직전에 다시 재 보니 소스가 바뀌었습니다';
/**
 * Right before a brief is typed (roadmap item 3): evidence still marked fresh is measured again, so a
 * source that moved while the stage waited never gets a reuse instruction. Undefined when the job
 * reuses nothing; unchanged when nothing is fresh any more.
 */
export async function recheckParentEvidence(job, measure) {
  const evidence = job?.parentEvidence;
  if (!evidence?.items?.length) return undefined;
  if (!evidence.items.some((item) => item.freshness === 'fresh')) return evidence;
  const marked = await markFreshness(evidence.items, measure);
  const moved = !marked.reason && marked.items.some((item, index) => evidence.items[index].freshness === 'fresh' && item.freshness !== 'fresh');
  return moved ? { ...marked, reason: CHANGED_BEFORE_DELIVERY, changedBeforeDelivery: true } : marked;
}

const line = (item) => '- ' + item.title + ' (' + item.nodeId + '): ' + item.summary;
/** What the stage may reuse from the parent run and what it must check again. */
export function reuseInstruction(job) {
  const items = job?.parentEvidence?.items ?? [];
  if (!items.length) return '';
  const fresh = items.filter((item) => item.freshness === 'fresh'), stale = items.filter((item) => item.freshness !== 'fresh');
  return [
    fresh.length ? '이전 실행의 근거 중 지금과 같은 소스에서 검증된 것(재사용 가능, 같은 검증은 다시 실행하지 말고 인용하세요):\n' + fresh.map(line).join('\n') : '',
    stale.length ? '오래된 근거(그 뒤로 소스가 바뀌었거나 확인할 수 없음' + (job.parentEvidence.reason ? ': ' + job.parentEvidence.reason : '') +
      '). 참고만 하고, 이 단계에 필요한 검증은 다시 실행하세요:\n' + stale.map(line).join('\n') : '',
  ].filter(Boolean).join('\n');
}

/** The newest passed test of `projectId`: { runId, commit, at } of the reviewed source, or null. */
export function lastVerifiedCommit(runs, projectId) {
  const verified = runs.filter((run) => run.projectId === projectId).flatMap((run) => run.nodes
    .filter((node) => node.id === 'test' && node.status === 'passed' && node.completedAt)
    .map((node) => ({ runId: run.id, commit: reviewedCommit(run, node), at: node.completedAt })))
    .filter((item) => item.commit);
  return verified.sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
}
