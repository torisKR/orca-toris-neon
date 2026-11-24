/**
 * How far and how a run goes: the new-flow form's scope (playable or release), and on a run that
 * still has release stages nobody started, "여기까지만" to stop at test.
 */
import { e, button } from './kit.mjs';

// Mirrors src/scope.mjs (the panel cannot import worker files); tests/runplan.test.mjs keeps them equal.
export const RELEASE_STAGES = Object.freeze(['policy', 'listing', 'catalog', 'internal', 'release']);
const NOT_STARTED = new Set(['pending', 'awaiting-approval']);
const SCOPE_CHOICES = [
  ['playable', '플레이 가능한 첫 버전', '조사부터 테스트까지만 합니다. 정책 점검·스토어 자료·내부 테스트·출시는 하지 않으며, 완료 표시는 "검증 완료"까지입니다.'],
  ['release', '출시 준비까지', '테스트 뒤 정책 점검, 스토어 자료, 내부 테스트·출시 준비까지 합니다. 실제 제출은 직접 승인합니다.'],
];

/** New app only: playable by default; release can follow later as its own run. */
export function scopeField(draft) {
  const chosen = draft('scope', 'playable');
  return '<fieldset class="improve-areas"><legend class="label">어디까지 만들까요</legend>' + SCOPE_CHOICES.map(([value, label, hint]) =>
    '<label class="checkbox area-option"><input type="radio" name="scope" value="' + value + '" ' + (chosen === value ? 'checked' : '') + '><span><strong>' + label + (value === 'playable' ? ' (기본)' : '') + '</strong><small>' + hint + '</small></span></label>').join('') +
    '<p class="hint">출시는 첫 버전을 확인한 뒤 기존 앱 개선 → "출시 업데이트" 실행으로 이어서 할 수 있습니다.</p></fieldset>';
}

/** Release stages nobody started (src/scope.mjs skippableStages). */
export function skippableStages(item) {
  if (['completed', 'cancelled'].includes(item.status) || (item.template ?? 'new-app') !== 'new-app') return [];
  return (item.nodes ?? []).filter((node) => RELEASE_STAGES.includes(node.id) && NOT_STARTED.has(node.status) && !node.active && !node.pendingReceipt);
}

export function scopeLine(item) {
  const stages = skippableStages(item);
  if (!stages.length) return '';
  const hint = 'skip-release-hint-' + e(item.id);
  return '<div class="autonomy-line"><span class="hint" id="' + hint + '">아직 시작하지 않은 출시 단계 ' + stages.length + '개(' + stages.map((node) => e(node.title ?? node.id)).join(', ') +
    '). 테스트까지만 하려면 건너뛰세요. 시작했거나 통과한 단계는 그대로 둡니다.</span>' +
    button('여기까지만 (출시 단계 건너뛰기)', 'skip-release', 'data-run="' + e(item.id) + '" aria-describedby="' + hint + '"', 'small') + '</div>';
}

// Mirrors src/profile.mjs PROFILES, PROFILE_NAMES and the build fan-out; tests/runplan.test.mjs keeps them equal.
export const PROFILE_CHOICES = Object.freeze([
  ['fast', '빠르게', '모든 단계를 상위 모델로, 구현은 서브에이전트 최대 5개로 나눠 병렬 진행합니다. 토큰을 가장 많이 씁니다.'],
  ['balanced', '균형', '구현·테스트는 상위 모델, 조사·기획·정책·스토어 문서는 중간 모델. 검토는 작업과 다른 에이전트(교차 검토). 구현은 최대 3개로 병렬.'],
  ['saver', '절약', '균형과 같되 구현 추론을 낮추고, 검토는 가벼운 모델(구현·테스트 검토는 중간 모델), 병렬 없음.'],
]);
export const FANOUT = Object.freeze({ fast: 5, balanced: 3, saver: 0 });
const PROFILE_NAMES = Object.fromEntries(PROFILE_CHOICES.map(([id, name]) => [id, name]));

export function profileField(draft) {
  const chosen = draft('profile', '');
  return '<label class="label" for="app-profile">속도·비용 프로필</label><select class="field" id="app-profile" name="profile">' +
    '<option value=""' + (chosen === '' ? ' selected' : '') + '>플러그인 설정의 기본값 (처음에는 균형)</option>' +
    PROFILE_CHOICES.map(([value, label]) => '<option value="' + value + '"' + (chosen === value ? ' selected' : '') + '>' + label + '</option>').join('') + '</select>' +
    '<ul class="hint">' + PROFILE_CHOICES.map(([, label, hint]) => '<li><strong>' + label + '</strong> · ' + hint + '</li>').join('') + '</ul>' +
    '<p class="hint">아래 담당 에이전트를 "프로필에 맡김"으로 두면 프로필이 단계별 에이전트를 고릅니다(디자인·에셋은 이미지 도구가 있는 codex). 실행 카드에서 단계별 모델을 바꾸면 그 선택이 우선합니다.</p>';
}

const cell = (item) => item ? '<span class="mono">' + e(item.agent ?? '—') + (item.model ? ' · ' + e(item.model) : '') + (item.effort ? ' · ' + e(item.effort) : '') + '</span>' +
  '<br><span class="hint">' + e(item.why) + '</span>' : '<span class="hint">—</span>';

/** The model each stage and phase launches with now, and why (src/profile.mjs launchPlan). */
export function modelPlan(item) {
  const plan = item.launchPlan;
  if (!plan) return '';
  const head = item.profile ? '프로필 ' + e(PROFILE_NAMES[item.profile] ?? item.profile) + ' · 구현 병렬 최대 ' + e(FANOUT[item.profile] ?? 0) + '개' : '프로필 없음(이전 실행) · 에이전트 기본 모델';
  return '<details class="card spacer" data-disclosure="models:' + e(item.id) + '"><summary>단계별 모델 · ' + head + '</summary>' +
    (item.profileWarning ? '<p class="callout warning" role="status">' + e(item.profileWarning) + '</p>' : '') + '<table class="before-after model-plan"><caption class="sr-only">단계별 작업·검토 에이전트와 모델</caption><thead><tr><th scope="col">단계</th><th scope="col">작업</th><th scope="col">검토</th></tr></thead><tbody>' +
    (item.nodes ?? []).map((node) => '<tr><th scope="row">' + e(node.title ?? node.id) + '</th><td>' + cell(plan[node.id]?.work) + '</td><td>' + cell(plan[node.id]?.review) + '</td></tr>').join('') +
    '</tbody></table><p class="hint">단계 지정은 실행 카드에서 고른 모델·추론 강도이며 프로필보다 우선합니다. 실제 적용 여부는 각 단계의 실행 기록에 남습니다.</p></details>';
}

const VISUAL_TITLES = { design: '디자인', assets: '에셋' };
/** Stages moved off an agent that could not work, and the way back (src/fallback.mjs). */
export function fallbackLine(item) {
  const moved = (item.nodes ?? []).filter((node) => node.fallback);
  const avoided = Object.entries(item.avoided ?? {});
  if (!moved.length && !avoided.length) return '';
  return '<div class="callout warning" role="group" aria-label="대체 에이전트 안내">' +
    avoided.map(([agent, info]) => '<p><strong>' + e(agent) + '를 쓸 수 없어 ' + e(info.to) + '로 진행합니다</strong> (' + e(String(info.at ?? '').slice(0, 16).replace('T', ' ')) + '). ' +
      e(agent) + '가 다른 작업에서 다시 작동하면 아직 시작하지 않은 단계는 자동으로 원래대로 돌아갑니다. ' +
      button(e(agent) + ' 다시 쓰기', 'restore-agent', 'data-run="' + e(item.id) + '" data-agent="' + e(agent) + '"', 'small') + '</p>').join('') +
    (moved.length ? '<p><strong>이미지 도구 없이 대체 에이전트로 진행한 단계</strong></p><ul>' + moved.map((node) => '<li>' + e(VISUAL_TITLES[node.id] ?? node.title ?? node.id) + ': ' + e(node.fallback.from) + ' → ' + e(node.fallback.to) +
      ' · 이미지 생성 도구 없이 진행' + (node.fallback.reason ? ' — ' + e(node.fallback.reason.slice(0, 160)) : '') + '</li>').join('') + '</ul>' : '') + '</div>';
}

/** Design or assets made on the fallback agent: redo them on codex in a linked design improvement run. */
export const redoVisualStages = (item) => (item.nodes ?? []).filter((node) => node.fallback && node.status === 'passed');
export function redoVisualButton(item) {
  const stages = redoVisualStages(item);
  if (!stages.length) return '';
  return button('gpt-6.2-sol로 디자인·에셋 다시 만들기', 'redo-visual', 'data-run="' + e(item.id) + '" aria-label="gpt-6.2-sol로 디자인·에셋 다시 만들기: ' + e(stages.map((node) => VISUAL_TITLES[node.id] ?? node.id).join(', ')) + '은(는) ' + e(stages[0].fallback.to) + '로 만들어졌습니다"', 'small');
}
export function redoVisualInput(item) {
  const by = redoVisualStages(item)[0]?.fallback?.to ?? '다른 에이전트';
  return { template: 'improve', kind: 'design', projectId: item.projectId, parentRunId: item.id, requestId: 'redo-visual.' + item.id,
    goal: '이전 실행에서 이미지 생성 도구가 없는 ' + by + '로 만든 디자인·에셋을 codex(gpt-6.2-sol)의 이미지 도구로 다시 만듭니다. 화면 구조·기능·저장 데이터는 그대로 두고, 실제 앱 화면의 전후를 같은 조건으로 비교합니다.',
    assignments: { design: { agent: 'codex' }, assets: { agent: 'codex' } }, ...(item.profile ? { profile: item.profile } : {}) };
}
