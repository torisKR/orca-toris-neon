/**
 * Supply-line state for each real dependency (docs/design/pixel-ui/RESPONSIVE.md, 공급선 상태). Pure: a rail is
 * judged from the arrival stage's stagePixelOf() view, never from render time, and a parcel moves only where
 * that view proves a work or review turn, or right after a pass the push memory saw.
 */
import { shortTitle, msOf } from './pixelstate.mjs';

export const HANDOFF_MS = 720; // flow.css px-flow-handoff
const DONE = new Set(['passed', 'skipped']);
const STOPPED = new Set(['blocked', 'failed', 'quiet', 'start-slow', 'retry', 'unknown', 'approval', 'report', 'paused', 'cancelled']);
const LIVE = new Set(['work', 'review']);
const RESTING = new Set(['idle', 'start']);
const WAITING = new Set(['queue', 'dependency']);

/** Every rail of a run: one per dep that names a stage of this run, plus a start port for a stage without such deps. */
export function flowEdges(run) {
  const ids = new Set((run.nodes ?? []).map((node) => node.id));
  return (run.nodes ?? []).flatMap((target) => {
    const deps = [...new Set((target.deps ?? []).filter((id) => ids.has(id)))]; // as workshopLayout: unknown ids are not deps
    if (!deps.length) return [{ id: run.id + ':start:' + target.id, sourceId: null, targetId: target.id }];
    return deps.map((sourceId) => ({ id: run.id + ':' + sourceId + ':' + target.id, sourceId, targetId: target.id }));
  });
}

/**
 * One rail, highest priority first: complete, stopped, live, handoff, queue, idle.
 * handoffDelay is how far into this rail's one-shot window we are (from createHandoffMemory), or null.
 * still (reduced motion or 공급 모션 끄기) changes only the motion, never the state or its words.
 */
export function edgeFlow({ run, sourceId = null, target, sourceView = null, targetView, cancelling = false, handoffDelay = null, still = false }) {
  const pose = targetView?.pose;
  const result = (state, label, extra = {}) => ({ state, label, motion: 'still', phase: '', tone: '', mark: '', delay: null, ...extra });
  if (run.status === 'completed' || pose === 'passed') return result('complete', '완료', { mark: 'complete' });
  if (cancelling || run.status === 'cancelled' || STOPPED.has(pose)) {
    const reason = targetView?.label ?? '';
    return result('stopped', reason.startsWith('멈춤') ? reason : '멈춤' + (reason ? ' · ' + reason : ''),
      { tone: targetView?.tone === 'warn' ? 'warn' : 'stop', mark: pose === 'quiet' ? 'quiet' : 'stop' });
  }
  const fed = sourceId === null || DONE.has(sourceView?.pose);
  if (LIVE.has(pose) && targetView.motion === 'loop' && fed) {
    const review = targetView.phase === 'review';
    return result('live', review ? '검토 · 공급 중' : '공급 중', { motion: still ? 'still' : 'loop', phase: review ? 'review' : 'work', mark: 'arrow' });
  }
  if (handoffDelay !== null && RESTING.has(pose)) return result('handoff', '인계', { motion: still ? 'still' : 'once', delay: handoffDelay, mark: 'arrow' });
  if (WAITING.has(pose)) return result('queue', '대기 · ' + targetView.label, { mark: 'queue' });
  return result('idle', target?.status === 'skipped' || pose === 'skipped' ? '건너뜀' : '대기');
}

/**
 * Every rail of a run with its state. stages: [{ node, view }] from stagesOf()/stagePixelOf().
 * handoffs: a createHandoffMemory(); until is when a handoff rail settles back on its own.
 */
export function runFlows(run, stages, { now, cancelling = false, handoffs = null, still = false } = {}) {
  const viewOf = new Map(stages.map((stage) => [stage.node.id, stage.view]));
  const nodeOf = new Map((run.nodes ?? []).map((node) => [node.id, node]));
  return flowEdges(run).map((edge) => {
    const delay = edge.sourceId && handoffs ? handoffs.delay(run.id, edge.sourceId, edge.targetId, now) : null;
    const flow = edgeFlow({ run, sourceId: edge.sourceId, target: nodeOf.get(edge.targetId), sourceView: viewOf.get(edge.sourceId) ?? null,
      targetView: viewOf.get(edge.targetId), cancelling, handoffDelay: delay, still });
    return { ...edge, ...flow, until: flow.state === 'handoff' ? now - delay + HANDOFF_MS : null };
  });
}

/** "제품 기획에서 공급 중 · 화면 설계에서 대기": a stage's incoming rails in words, for its accessible name. */
export function incomingText(flows, targetId, nodes) {
  const nodeOf = new Map((nodes ?? []).map((node) => [node.id, node]));
  return flows.filter((flow) => flow.targetId === targetId)
    .map((flow) => (flow.sourceId === null ? '시작 포트' : shortTitle(nodeOf.get(flow.sourceId) ?? { id: flow.sourceId })) + '에서 ' + flow.label).join(' · ');
}

/**
 * The handoff memory, fed by state pushes only (never by rendering). The first snapshot of a stage is a
 * baseline; a stage that turns passed with a new valid completedAt opens one 720 ms window on its first
 * ready successor (run.nodes order, idle or starting, every dep passed or skipped). Each (run, stage,
 * completedAt) plays at most once; while hidden (open: false) the pass is remembered but nothing opens.
 */
export function createHandoffMemory() {
  const seen = new Map(), windows = new Map(), played = new Set();
  const passedAt = (node) => node.status === 'passed' && msOf(node.completedAt) !== null ? String(node.completedAt) : null;
  const ready = (run, target, poseOf) => {
    const statusOf = new Map(run.nodes.map((node) => [node.id, node.status]));
    return RESTING.has(poseOf(run, target)) && (target.deps ?? []).every((id) => DONE.has(statusOf.get(id)));
  };
  return {
    observe(runs, { now, poseOf, open = true }) {
      for (const run of runs ?? []) {
        for (const node of run.nodes ?? []) {
          const key = run.id + ':' + node.id, at = passedAt(node), known = seen.has(key), before = seen.get(key);
          seen.set(key, at);
          if (!known || at === null || at === before || played.has(key + ':' + at)) continue;
          played.add(key + ':' + at);
          if (!open || ['completed', 'cancelled'].includes(run.status)) continue;
          const target = run.nodes.find((item) => (item.deps ?? []).includes(node.id) && ready(run, item, poseOf));
          if (target) windows.set(key, { runId: run.id, targetId: target.id, at: now });
        }
      }
    },
    delay(runId, sourceId, targetId, now) {
      const key = runId + ':' + sourceId, entry = windows.get(key);
      if (!entry || entry.targetId !== targetId) return null;
      if (now - entry.at >= HANDOFF_MS) { windows.delete(key); return null; }
      return Math.max(0, now - entry.at);
    },
    until(runId, targetId) {
      const ends = [...windows.values()].filter((entry) => entry.runId === runId && entry.targetId === targetId).map((entry) => entry.at + HANDOFF_MS);
      return ends.length ? Math.min(...ends) : null;
    },
  };
}
