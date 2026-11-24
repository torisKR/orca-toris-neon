/**
 * In-stage fan-out for build. The graph never gets concurrent write stages (two writers in one
 * worktree race on commits); instead a Claude build agent may split independent modules across up
 * to N parallel subagents (the run's profile: balanced 3, fast 5, saver 0) and keeps integration,
 * the single commit history and the report. The report states the split in "parallel".
 */
import { fanoutOf } from './profile.mjs';

const MAX_MODULES = 12;
const BY = new Set(['main', 'subagent']);
const fail = (message) => { throw Object.assign(new Error(message), { code: 'invalid_report' }); };
const name = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 120) fail('parallel: ' + label + ' 값이 필요합니다 (최대 120자).');
  return value.trim();
};
const CONTRACT = '"parallel": {"modules": [{"name": "모듈", "by": "subagent" 또는 "main", "model": "서브에이전트 모델(선택)"}], "ranInParallel": ["동시에 진행한 모듈 이름"], "note": "나눈 기준과 나누지 않은 이유(선택)"}';

/** How many subagents this launch may use: a Claude build work launch in a profile that fans out. */
export function fanoutLimit(run, node, job) {
  if (node.id !== 'build' || job.phase !== 'work' || job.agent !== 'claude') return 0;
  return fanoutOf(run);
}

export function fanoutInstruction(run, node, job) {
  const limit = fanoutLimit(run, node, job);
  if (!limit) return '';
  return [
    '병렬 구현: 서로 독립적인 모듈(예: 규칙 엔진별, 엔진과 화면)은 Task 서브에이전트 최대 ' + limit + '개에 나눠 동시에 진행하세요. 파일이 겹치거나 순서가 필요한 일은 나누지 마세요.',
    '당신이 통합을 맡습니다: 모듈 사이의 인터페이스를 먼저 정해 서브에이전트에게 주고, 결과를 합쳐 빌드와 핵심 테스트를 직접 돌리세요. 서브에이전트는 커밋하지 않고, 커밋 기록과 보고서는 당신 하나만 남깁니다.',
    '데이터 정의·반복 위젯·테스트 골격처럼 기계적인 모듈은 더 가벼운 서브에이전트 모델(claude-sonnet-5-5, 아주 단순하면 claude-haiku-5-5)을 써도 됩니다. 핵심 로직은 낮추지 마세요.',
    node.feedback ? '이번은 수정 시도입니다. 실패들이 서로 독립(다른 모듈, 공통 원인 없음)일 때만 나누고, 그렇지 않으면 직접 순서대로 고치세요.' : '',
    '보고서에 나눈 방식을 적으세요(나누지 않았으면 모듈 하나를 "main"으로 적고 이유를 note에): ' + CONTRACT,
  ].filter(Boolean).join('\n');
}

/** { parallel? } from a report; malformed values are refused so the agent can correct them. */
export function parallelFieldsOf(report) {
  if (report.parallel === undefined) return {};
  const value = report.parallel;
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('parallel은 객체여야 합니다: ' + CONTRACT);
  if (!Array.isArray(value.modules) || !value.modules.length || value.modules.length > MAX_MODULES) fail('parallel.modules는 1~' + MAX_MODULES + '개 배열이어야 합니다.');
  const modules = value.modules.map((item) => {
    if (!item || !BY.has(item.by)) fail('parallel.modules의 by는 "main" 또는 "subagent"여야 합니다.');
    return { name: name(item.name, '모듈 이름'), by: item.by, ...(item.model ? { model: name(item.model, '모델') } : {}) };
  });
  const ran = value.ranInParallel === undefined ? [] : value.ranInParallel;
  if (!Array.isArray(ran) || ran.some((item) => !modules.some((module) => module.name === item))) fail('parallel.ranInParallel에는 modules에 있는 이름만 적으세요.');
  return { parallel: { modules, ranInParallel: ran, ...(typeof value.note === 'string' && value.note.trim() ? { note: value.note.trim().slice(0, 300) } : {}) } };
}

/** A passed Claude build that could fan out says how it split the work. */
export function requireParallel(run, nodeId, report) {
  const node = run.nodes.find((item) => item.id === nodeId);
  if (report.phase !== 'work' || report.outcome !== 'passed' || report.parallel || !node.active) return; // a replayed report was already judged
  if (fanoutLimit(run, node, { phase: 'work', agent: node.active.agent ?? node.agent })) fail('구현 보고서에 모듈 분할과 병렬 진행 내역을 적으세요: ' + CONTRACT);
}
