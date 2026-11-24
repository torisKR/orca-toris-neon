/**
 * What runs.create builds: a new app, an improvement of a shipped app (one kind), a diagnosis, or an
 * improvement started from a diagnosis candidate. Also the request key that makes creation
 * idempotent (an explicit requestId, or one diagnosis candidate), so a repeated request returns the
 * run that already exists instead of a second one.
 */
import { templateGraph } from './engine.mjs';
import { prepareImprovement } from './improve.mjs';
import { verifiedEvidence, lastVerifiedCommit } from './reuse.mjs';
import { normalizeScope, scopedGraph } from './scope.mjs';
import { normalizeProfile, defaultProfileOf, profileAssignments } from './profile.mjs';

const invalid = (message) => Object.assign(new Error(message), { code: 'invalid_params' });
const text = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(label + ' 값이 필요합니다 (최대 ' + max + '자).');
  return value.trim();
};

export function requestKey(input = {}) {
  if (input.requestId !== undefined && input.requestId !== null) {
    if (typeof input.requestId !== 'string' || !/^[\w.:-]{1,100}$/.test(input.requestId)) throw invalid('requestId는 100자 이하의 영문·숫자·_.:- 문자열이어야 합니다.');
    return 'req:' + input.requestId; // its own namespace: never equal to a candidate key
  }
  const from = input.fromDiagnosis;
  return from ? 'diagnosis:' + from.runId + ':' + from.index : null;
}

function fromDiagnosis({ runId, index }, runs) {
  const source = runs.find((run) => run.id === runId && run.template === 'diagnose');
  const report = source?.nodes.find((node) => node.id === 'diagnose');
  if (!source || report?.status !== 'passed') throw invalid('검토를 통과한 진단 실행에서만 개선을 시작할 수 있습니다.');
  if (!Array.isArray(report.report?.candidates) || !report.report.candidates.length) throw invalid('이 진단은 구조화된 개선 후보를 기록하지 않았습니다. 진단 보고서의 후보를 개선 목표에 붙여 넣어 시작하세요.');
  const candidate = report.report.candidates[index];
  if (!Number.isInteger(index) || !candidate) throw invalid('진단 실행에 해당 개선 후보가 없습니다.');
  const goal = [candidate.title, '문제: ' + candidate.problem, '근거: ' + candidate.evidence, '사용자 영향: ' + candidate.impact,
    '변경 범위: ' + candidate.scope, '검증 방법: ' + candidate.verify].join('\n');
  return {
    goal, projectId: source.projectId, nodes: templateGraph('improve', { kind: candidate.kind, web: source.improvement?.platform === 'web' }),
    extra: { template: 'improve', parentRunId: source.id,
      improvement: { ...source.improvement, kind: candidate.kind, options: { design: false, payments: false }, diagnosis: { runId: source.id, index, title: candidate.title },
        parent: { runId: source.id, summary: resultSummary(source), evidence: verifiedEvidence(source) } } },
  };
}

/** A finished run's result in a few lines: what changed and what was not verified, per stage. */
export function resultSummary(run) {
  const lines = run.nodes.filter((node) => node.status === 'passed' && node.report).flatMap((node) => [
    node.title + ': ' + String(node.report.summary ?? '').slice(0, 300),
    ...(node.report.changes ?? []).map((item) => '  바뀐 것: ' + item),
    ...(node.report.notVerified ?? []).map((item) => '  검증하지 못한 것: ' + item)]);
  return lines.join('\n').slice(0, 3000) || '기록된 결과가 없습니다.';
}

function withParent(plan, input, runs) {
  if (input.parentRunId === undefined) return plan;
  if (plan.extra.template !== 'improve') throw invalid('이전 결과에서 이어가기는 기존 앱 개선 흐름에서만 할 수 있습니다.');
  const parent = runs.find((run) => run.id === input.parentRunId);
  if (!parent) throw invalid('이어서 개선할 이전 실행을 찾을 수 없습니다.');
  if (parent.projectId !== plan.projectId) throw invalid('이전 실행과 같은 프로젝트에서만 이어서 개선할 수 있습니다.');
  return { ...plan, extra: { ...plan.extra, parentRunId: parent.id,
    improvement: { ...plan.extra.improvement, parent: { runId: parent.id, summary: resultSummary(parent), evidence: verifiedEvidence(parent) } } } };
}
/** A release update re-verifies only what changed since this project's last verified commit (src/reuse.mjs). */
function withLastVerified(plan, runs) {
  if (plan.extra.improvement?.kind !== 'release') return plan;
  const lastVerified = lastVerifiedCommit(runs, plan.projectId);
  return lastVerified ? { ...plan, extra: { ...plan.extra, improvement: { ...plan.extra.improvement, lastVerified } } } : plan;
}

/** { goal, projectId, nodes, extra } for runs.create; throws invalid_params with a person-readable reason. */
export async function planRunInput(input, deps) {
  return withProfile(withLastVerified(withParent(await planFlow(input, deps), input, deps.runs), deps.runs), input, deps);
}
/** Speed and cost profile (src/profile.mjs): the request's, else the plugin setting. A custom graph keeps its own assignments. */
async function withProfile(plan, input, deps) {
  if (input.nodes && input.profile === undefined) return plan;
  let chosen;
  try { chosen = normalizeProfile(input.profile); } catch (error) { throw invalid(error.message); }
  const { profile, warning } = chosen ? { profile: chosen } : await defaultProfileOf(deps.settings);
  return { ...plan, nodes: profileAssignments(plan.nodes, profile, input.assignments ?? {}), extra: { ...plan.extra, profile, ...(warning ? { profileWarning: warning } : {}) } };
}
async function planFlow(input, deps) {
  if (input.fromDiagnosis) return fromDiagnosis(input.fromDiagnosis, deps.runs);
  const template = input.template ?? 'new-app';
  const projectId = text(input.projectId, '프로젝트', 256);
  if (template !== 'new-app' && input.nodes) throw invalid('개선·진단 흐름은 단계 목록이 아니라 템플릿으로만 만듭니다.');
  if (template === 'diagnose') {
    const prep = await prepareImprovement(input, deps, { diagnose: true });
    return { goal: input.goal !== undefined && input.goal !== '' ? text(input.goal, '진단 메모', 6000) : '프로젝트 진단: 근거 있는 개선 후보 3~5개 찾기', projectId,
      nodes: templateGraph('diagnose'), extra: { template: 'diagnose', improvement: prep.improvement } };
  }
  const goal = text(input.goal, template === 'improve' ? '개선 목표' : '앱 목표', 6000);
  if (template === 'improve') {
    const prep = await prepareImprovement(input, deps);
    const nodes = templateGraph('improve', { kind: prep.kind, ...prep.options, web: prep.improvement.platform === 'web' });
    return { goal, projectId, nodes, extra: { template: 'improve', improvement: prep.improvement } };
  }
  // A new app ends at test unless the person asked for the release stages (src/scope.mjs).
  if (input.nodes) return { goal, projectId, nodes: input.nodes, extra: {} };
  try { return { goal, projectId, nodes: scopedGraph(templateGraph(template), input.scope), extra: { scope: normalizeScope(input.scope) } }; }
  catch (error) { throw invalid(error.message); }
}
