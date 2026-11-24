/**
 * How far a new app run goes. 'playable' ends at test (a first version to play, not published);
 * 'release' keeps the Play stages. A run that already has them can stop at test: its release stages
 * that have not started become 'skipped', which completes the run once everything else passed and
 * never counts as passed anywhere else (milestones, result card, history).
 */
import { settleRun } from './engine.mjs';

export const SCOPES = Object.freeze(['playable', 'release']);
export const RELEASE_STAGES = new Set(['policy', 'listing', 'catalog', 'internal', 'release']);
const NOT_STARTED = new Set(['pending', 'awaiting-approval']);
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function normalizeScope(value) {
  if (value === undefined || value === null || value === '') return 'playable';
  if (!SCOPES.includes(value)) fail('invalid_params', '범위는 playable(플레이 가능한 첫 버전) 또는 release(출시까지) 중 하나여야 합니다.');
  return value;
}

/** The graph for a scope: playable drops the release stages (nothing before them depends on them). */
export function scopedGraph(nodes, scope) {
  if (normalizeScope(scope) === 'release') return nodes;
  return nodes.filter((node) => !RELEASE_STAGES.has(node.id)).map((node) => ({ ...node, deps: node.deps.filter((dep) => !RELEASE_STAGES.has(dep)) }));
}

/** Release stages nobody started: not running, not waiting for a report, not passed or failed. */
export function skippableStages(run) {
  if (['completed', 'cancelled'].includes(run.status) || (run.template ?? 'new-app') !== 'new-app') return [];
  return run.nodes.filter((node) => RELEASE_STAGES.has(node.id) && NOT_STARTED.has(node.status) && !node.active && !node.pendingReceipt);
}

const pushEvent = (run, at, type, summary, extra = {}) => {
  run.events.push({ id: run.id + ':' + (run.eventSequence = (run.eventSequence ?? 0) + 1), at, type, summary, ...extra });
  run.updatedAt = at;
};

/** "여기까지만": skip the release stages nobody started; started or passed stages are untouched. */
export function skipReleaseStages(run, { now = new Date().toISOString() } = {}) {
  const ids = skippableStages(run).map((node) => node.id);
  if (!ids.length) fail('conflict', '건너뛸 출시 단계가 없습니다. 이미 시작했거나 통과한 단계는 그대로 둡니다.');
  const next = structuredClone(run);
  for (const node of next.nodes) {
    if (!ids.includes(node.id)) continue;
    node.status = 'skipped';
    node.skippedAt = now;
  }
  pushEvent(next, now, 'run.scope-reduced', '여기까지만: 출시 단계를 건너뛰었습니다 (' + ids.join(', ') + '). 테스트를 통과하면 실행이 끝나며, 출시는 나중에 출시 업데이트 실행으로 이어서 할 수 있습니다.', { skipped: ids });
  const settled = settleRun(next);
  if (settled.status === 'completed' && run.status !== 'completed') pushEvent(settled, now, 'run.completed', '건너뛴 출시 단계를 빼고 모든 단계의 작업과 검토가 완료되었습니다.');
  return settled;
}
