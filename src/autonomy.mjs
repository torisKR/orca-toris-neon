/**
 * Autonomous runs: what the plugin does on its own when a stage stops, and where it must still
 * stop for a person. planAutonomy is pure; createSupervisor applies its actions through the
 * runtime's own operations (retry, approve, notify) so the runtime's invariants stay in force.
 */
import { approveNode } from './engine.mjs';
import { catalogNotice } from './catalog.mjs';
import { milestoneText } from './milestones.mjs';

/** Bounds so a run can never loop or spend without limit. Shown in the run card. */
export const AUTONOMY_LIMITS = {
  retriesPerStage: 3, // fresh attempts the plugin starts for one stage
  retriesPerRun: 12, // and for the whole run
  switchAgentAfter: 2, // consecutive retries on one agent before trying the other
  decisionNudgesPerJob: 2, // "decide for yourself" continuations after a turn without a report
  extraRepairLoopsPerRun: 3, // QA → build loops beyond the run's own limit
};
export const AUTONOMY_BRIEF = '이 실행에는 사람이 없습니다. 질문하거나 확인을 기다리지 마세요. 목표와 이 단계의 범위 안에서 합리적인 선택을 직접 하고, 그 가정을 보고서에 기록한 뒤 끝까지 진행하세요. 확인 창이나 권한 승인을 기다리게 되는 명령(예: rm -rf, 대화형 설치)은 쓰지 마세요. 도구 호출이 몇 분 안에 시작되지 않으면 기다리지 말고 다른 방법으로 진행하세요.';
export const DECIDE_PROMPT = '이 실행에는 답할 사람이 없습니다. 질문이나 확인 요청이 있었다면 목표와 이 단계의 범위 안에서 스스로 결정하고, 그 가정을 보고서에 기록한 뒤 작업을 마치고 보고서를 저장하세요.';
const PAIR = { claude: 'codex', codex: 'claude' };
export const otherAgent = (agent) => PAIR[agent] ?? null;

const jobFor = (run, node) => (run.jobs ?? []).find((job) => job.nonce === node.pendingReceipt?.nonce) ?? null;

/** Reasons a retry could duplicate work or cannot fix the cause: these stay with the person. */
function humanReason(node, job) {
  if (node.launchUncertain) return '에이전트 시작이나 작업 지시 전달 결과가 불명확합니다. 다시 보내면 작업이 중복될 수 있어 멈췄습니다.';
  if (['uncertain', 'rejected'].includes(job?.promptRecovery?.state)) return '작업 지시 전달 결과가 ' + (job.promptRecovery.state === 'rejected' ? '거부됐습니다' : '불명확합니다') + '. 다시 보내면 작업이 중복될 수 있어 멈췄습니다.';
  if (!node.pendingReceipt && node.history?.at(-1)?.outcome === 'blocked') return '에이전트가 사람의 조치가 필요하다고 보고했습니다: ' + (node.failureReason ?? '');
  if (!node.pendingReceipt && node.history?.at(-1)?.failureClass === 'external') return '외부 조건이 필요합니다(재시도하지 않음): ' + (node.failureReason ?? '');
  return null;
}

function summary(state, extra) {
  const tried = (state.tried ?? []).slice(-6);
  return extra + (tried.length ? ' 시도한 것: ' + tried.join(', ') + '.' : '');
}

function retryAction(run, node, state) {
  const stageRetries = state.retries?.[node.id] ?? 0;
  const total = state.total ?? 0;
  if (stageRetries >= AUTONOMY_LIMITS.retriesPerStage) {
    return { type: 'stop', nodeId: node.id, notify: true, key: 'limit:' + node.id + ':' + stageRetries,
      reason: summary(state, node.title + ' 단계를 자동으로 ' + stageRetries + '번 다시 시도했지만 통과하지 못해 멈췄습니다.') };
  }
  if (total >= AUTONOMY_LIMITS.retriesPerRun) {
    return { type: 'stop', nodeId: node.id, notify: true, key: 'limit:run:' + total,
      reason: summary(state, '이 실행에서 자동 재시도 ' + total + '번을 모두 써서 멈췄습니다.') };
  }
  const extendRepairLoop = node.id === 'test' && run.repairLoops >= run.maxRepairLoops;
  if (extendRepairLoop && (state.extraRepairLoops ?? 0) >= AUTONOMY_LIMITS.extraRepairLoopsPerRun) {
    return { type: 'stop', nodeId: node.id, notify: true, key: 'limit:repair:' + state.extraRepairLoops,
      reason: summary(state, '테스트 → 구현 수정 루프를 자동으로 ' + state.extraRepairLoops + '번 더 늘렸지만 테스트를 통과하지 못해 멈췄습니다.') };
  }
  // An agent stuck on a screen only a person can clear (src/agentscreen.mjs): another try cannot help.
  // Its own job's phase says which field it filled.
  const job = jobFor(run, node);
  const jobField = job?.phase === 'review' ? 'reviewer' : 'agent';
  const blocker = job?.blocker && job.blocker.agent === node[jobField] ? job.blocker : null;
  const field = blocker ? jobField : node.blockedPhase === 'review' && node.report?.outcome === 'passed' ? 'reviewer' : 'agent';
  const streak = state.streak?.[node.id];
  const switchTo = blocker ? otherAgent(blocker.agent)
    : streak && streak.agent === node[field] && (streak.field ?? 'agent') === field && streak.count >= AUTONOMY_LIMITS.switchAgentAfter ? otherAgent(node[field]) : null;
  const reason = node.failureReason ?? node.runtimeMessage ?? '';
  return { type: 'retry', nodeId: node.id, field, switchTo, extendRepairLoop, reason,
    ...(blocker && switchTo ? { avoid: blocker.agent, notice: { key: 'screen:' + blocker.agent + ':' + blocker.kind, body: reason } } : {}) };
}

/** The rest of the run stops using an agent stuck on such a screen; returns what moved. */
function avoidAgent(run, agent, replacement) {
  const moved = [];
  for (const node of run.nodes) {
    if (node.active || node.status === 'passed') continue;
    for (const key of ['agent', 'reviewer']) {
      if (node[key] === agent) { node[key] = replacement; moved.push(node.id + (key === 'reviewer' ? ' 검토' : '')); }
    }
  }
  return moved;
}

/** What an autonomous run does next, from its stored state only. */
export function planAutonomy(run) {
  if (!run.autonomous || ['paused', 'cancelled'].includes(run.status)) return [];
  const state = run.autonomy ?? {};
  if (run.status === 'completed') {
    if ((state.notified ?? []).includes('completed')) return [];
    // What actually finished (src/milestones.mjs), so "완료" never stands for a submission that did not happen.
    return [{ type: 'complete', body: (run.template === 'improve' ? '앱 업데이트 실행을 마쳤습니다. ' : '앱 제작 실행을 마쳤습니다. ') + milestoneText(run) }];
  }
  const actions = [];
  for (const node of run.nodes) {
    if (node.status === 'awaiting-approval' && !node.approval && node.humanApproval) {
      // Play Console products: only the person can act. One notice says exactly what to do.
      actions.push({ type: 'stop', nodeId: node.id, notify: true, key: 'human-approval:' + node.id, reason: catalogNotice(run) });
      continue;
    }
    if (node.status === 'awaiting-approval' && !node.approval) {
      const evidence = run.nodes.filter((item) => node.deps.includes(item.id)).map((item) => item.id + (item.review?.summary ? ' (' + item.review.summary.slice(0, 80) + ')' : ''));
      actions.push({ type: 'approve', nodeId: node.id,
        note: '자율 진행: 선행 단계 ' + (evidence.join(', ') || '없음') + '의 독립 검토 통과를 근거로 플러그인이 준비·검토 범위를 승인했습니다. 실제 제출은 포함하지 않습니다.' });
      continue;
    }
    if (!['blocked', 'failed'].includes(node.status) || node.active) continue;
    const human = humanReason(node, jobFor(run, node));
    if (human) actions.push({ type: 'stop', nodeId: node.id, notify: true, key: 'human:' + node.id + ':' + (node.pendingReceipt?.nonce ?? node.attempts), reason: node.title + ': ' + human });
    else actions.push(retryAction(run, node, state));
  }
  return actions;
}

/**
 * Applies a plan. ops: getRun(id), replaceRun(run), retryStage(run, nodeId) → run (throws
 * 'conflict' while a previous agent may still be running), appendEvent(run, text, extra),
 * notify(title, body), now().
 */
export function createSupervisor(ops) {
  const state = (run) => (run.autonomy ??= {});
  const notifyOnce = (run, key, title, body) => {
    const autonomy = state(run);
    autonomy.notified ??= [];
    if (autonomy.notified.includes(key)) return false;
    autonomy.notified.push(key);
    ops.notify(title, body);
    return true;
  };
  const retry = async (run, action) => {
    const next = structuredClone(run);
    const node = next.nodes.find((item) => item.id === action.nodeId);
    const before = node[action.field];
    if (action.switchTo) node[action.field] = action.switchTo;
    const moved = action.avoid ? avoidAgent(next, action.avoid, action.switchTo) : [];
    if (action.extendRepairLoop) next.maxRepairLoops += 1;
    // The plugin's own budget (AUTONOMY_LIMITS) bounds these; the stage's attempt counter must
    // leave room for one more attempt so the engine accepts the retry.
    // A fresh work attempt also needs room for its review.
    if (action.field === 'agent') node.attempts = Math.min(node.attempts ?? 0, next.maxAttempts - 1);
    node.reviewAttempts = Math.min(node.reviewAttempts ?? 0, next.maxAttempts - 1);
    if (action.reason && !node.feedback) node.lastFailure = { summary: action.reason.slice(0, 2000), at: new Date(ops.now()).toISOString() };
    let retried;
    try { retried = await ops.retryStage(next, action.nodeId); }
    catch (error) {
      if (error.code === 'conflict') return run; // the previous agent may still be running; check again later
      throw error;
    }
    const autonomy = state(retried);
    autonomy.retries = { ...autonomy.retries, [action.nodeId]: (autonomy.retries?.[action.nodeId] ?? 0) + 1 };
    autonomy.total = (autonomy.total ?? 0) + 1;
    if (action.extendRepairLoop) autonomy.extraRepairLoops = (autonomy.extraRepairLoops ?? 0) + 1;
    const agent = retried.nodes.find((item) => item.id === action.nodeId)[action.field];
    const streak = autonomy.streak?.[action.nodeId];
    autonomy.streak = { ...autonomy.streak, [action.nodeId]: { agent, field: action.field, count: streak?.agent === agent && streak.field === action.field ? streak.count + 1 : 1 } };
    const note = action.nodeId + ': ' + (action.switchTo ? before + ' → ' + action.switchTo + ' 전환' : agent + ' 재시도');
    autonomy.tried = [...(autonomy.tried ?? []), note].slice(-20);
    ops.appendEvent(retried, '자율 진행: ' + action.nodeId + ' 단계를 새로 시도합니다 (단계 ' + autonomy.retries[action.nodeId] + '/' + AUTONOMY_LIMITS.retriesPerStage +
      ', 실행 ' + autonomy.total + '/' + AUTONOMY_LIMITS.retriesPerRun + (action.switchTo ? ', ' + before + ' → ' + action.switchTo : '') +
      (action.extendRepairLoop ? ', 수정 루프 +1' : '') + '). 이유: ' + (action.reason || '이전 시도 실패').slice(0, 300) +
      (moved.length ? ' 남은 단계도 ' + action.switchTo + '로 진행합니다: ' + moved.join(', ') + '.' : ''), { nodeId: action.nodeId });
    return retried;
  };
  return {
    notifyOnce,
    /** One pass over a run; returns true when it changed anything. */
    async supervise(runId) {
      let changed = false;
      for (const action of planAutonomy(ops.getRun(runId))) {
        let run = ops.getRun(runId);
        if (action.type === 'approve') {
          run = approveNode(run, action.nodeId, { note: action.note, now: ops.now() });
          ops.appendEvent(run, action.note, { nodeId: action.nodeId, autonomy: true });
        } else if (action.type === 'retry') {
          const next = await retry(run, action);
          if (next === run) continue;
          run = next;
          if (action.notice) notifyOnce(run, action.notice.key, 'Toris Neon: ' + action.avoid + ' 확인이 필요합니다', action.notice.body + ' 자율 진행은 ' + action.switchTo + '로 계속합니다.');
        } else if (action.type === 'stop') {
          if (!notifyOnce(run, action.key, 'Toris Neon: 확인이 필요합니다', action.reason)) continue;
          state(run).stopped = { at: new Date(ops.now()).toISOString(), reason: action.reason };
          ops.appendEvent(run, '자율 진행을 멈췄습니다: ' + action.reason, { nodeId: action.nodeId });
        } else if (action.type === 'complete') {
          if (!notifyOnce(run, 'completed', 'Toris Neon: 실행 완료', action.body)) continue;
          ops.appendEvent(run, '자율 진행 완료: ' + action.body, {});
        }
        ops.replaceRun(run);
        changed = true;
      }
      return changed;
    }
  };
}
