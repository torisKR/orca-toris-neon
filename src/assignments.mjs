/**
 * Per-stage assignment changes from the run card (runs.updateAssignments): agent, reviewer, model,
 * effort and ECC choice. Applied to the runtime's working copy of the run; a person's choice is
 * explicit, so it also forgets any automatic fallback that stage remembered (src/fallback.mjs).
 */
import { normalizeEccAgent } from './engine.mjs';
import { normalizeModel, normalizeEffort } from './visual.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const AGENT_ID = /^[a-z][a-z0-9-]*$/;
const normalized = (normalize, value) => {
  try { return normalize(value); } catch (error) { return fail('invalid_params', error.message); }
};

export function applyAssignments(run, assignments) {
  if (!assignments || typeof assignments !== 'object' || Array.isArray(assignments)) fail('invalid_params', '단계별 담당자 맵이 필요합니다.');
  for (const [nodeId, assignment] of Object.entries(assignments)) {
    const node = run.nodes.find((item) => item.id === nodeId);
    if (!node) fail('invalid_params', '실행에 해당 단계가 없습니다.');
    if (node.active || ['passed', 'awaiting-approval', 'skipped'].includes(node.status)) fail('conflict', '실행 중이거나 검증 완료한 단계의 담당자는 바꿀 수 없습니다.');
    for (const field of ['agent', 'reviewer']) {
      if (assignment[field] === undefined) continue;
      const provider = assignment[field];
      if (typeof provider !== 'string' || !provider.trim() || provider.length > 64) fail('invalid_params', '에이전트 값이 필요합니다 (최대 64자).');
      if (!AGENT_ID.test(provider.trim())) fail('invalid_params', '잘못된 에이전트 ID입니다.');
      node[field] = provider.trim();
      if (node.original) delete node.original[field]; // the person's choice replaces the remembered one
      if (node.original && !Object.keys(node.original).length) delete node.original;
      if (field === 'agent') delete node.fallback;
    }
    for (const [field, normalize] of [['model', normalizeModel], ['effort', normalizeEffort]]) {
      if (assignment[field] === undefined) continue;
      const value = normalized(normalize, assignment[field]);
      if (value === undefined) delete node[field]; // the profile or the agent's own default
      else node[field] = value;
    }
    if (assignment.eccAgent !== undefined) {
      const choice = normalized(normalizeEccAgent, assignment.eccAgent);
      if (choice === undefined) delete node.eccAgent; // automatic
      else node.eccAgent = choice;
    }
  }
  return run;
}
