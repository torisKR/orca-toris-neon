/**
 * Auto App (the work flowing through teams) and 에이전트 (the people on those teams).
 * Both render from teams.mjs view models; ctx carries the panel's state and callbacks.
 */
import { e, badge, button, options, title, descriptions } from './kit.mjs';
import { stageResult } from './result.mjs';
import { stageTokens, memberTokens } from './tokens.mjs';
import {
  stageView, relations, teamLanes, collaboration, agentRoster, teamOf,
  eccOverride, elapsed, LIVE_LABELS, STATE_LABELS, STATE_GLYPHS,
} from './teams.mjs';

const terminalStates = ['cancelled', 'completed'];
const assignmentMutable = (node) => !node.active && !['passed', 'awaiting-approval', 'skipped'].includes(node.status);
const since = (iso, now) => iso ? '<time data-since="' + e(iso) + '" datetime="' + e(iso) + '">' + e(elapsed(iso, now)) + '</time>' : '';
// Elapsed time with the stage's budget (src/proportion.mjs) when the job carries one.
const sinceWithBudget = (view, now) => since(view.startedAt, now) + (view.budgetMinutes ? ' / 예산 ' + e(view.budgetMinutes) + '분' : '');
const mark = () => '<span class="team-mark" aria-hidden="true"></span>';
// Lists without a team heading also name the team for screen readers.
const namedMark = (team) => mark() + '<span class="sr-only">' + e(team.name) + ' </span>';
const stateTag = (state, undelivered = false) => '<span class="state-tag is-' + (undelivered ? 'attention' : e(state)) +
  '"><span class="state-glyph" aria-hidden="true">' + e(undelivered ? '!' : STATE_GLYPHS[state]) + '</span>' +
  e(undelivered ? '지시 전달 전' : STATE_LABELS[state]) + '</span>';
const eccTag = (agent, applies) => agent
  ? '<span class="ecc-tag' + (applies ? '' : ' is-inactive') + '" title="' + (applies ? 'Claude 서브에이전트로 위임' : 'Claude 단계에서만 적용') + '">' + e(agent) + (applies ? '' : ' · 미적용') + '</span>'
  : '';

// ---------- shared ----------
function qaReturn(item) {
  if (terminalStates.includes(item.status)) return null;
  const build = item.nodes.find((node) => node.id === 'build');
  const test = item.nodes.find((node) => node.id === 'test');
  // The engine copies the same rejected test report to both stages on a QA loop.
  if (build?.feedback?.nonce && build.feedback.nonce === test?.feedback?.nonce) return { from: test, to: build };
  return null;
}

function crewState(item, node, view, back) {
  if (view.state === 'passed') return { direction: 'passed', label: '검토 통과' };
  if (terminalStates.includes(item.status)) return { direction: 'waiting', label: '인계 종료' };
  if (view.phase === 'review' && (view.state === 'reviewing' || view.state === 'queued')) {
    return { direction: 'forward', label: view.state === 'queued' ? '검토 대기' : '검토 인계', holder: 'review' };
  }
  if (node.feedback?.phase === 'review' && ![back?.from.id, back?.to.id].includes(node.id) && view.state !== 'attention') {
    return { direction: 'back', label: '수정 요청', holder: 'work' };
  }
  const holder = view.state === 'working' ? 'work' : null;
  return { direction: 'waiting', label: view.undelivered ? '지시 전달 전' : holder ? '작업 중' : '인계 대기', holder };
}

function conduit(direction, label, vertical = false) {
  const arrow = direction === 'back' ? '←' : vertical ? '↓' : '→';
  return '<span class="conduit is-' + direction + '"><span class="conduit-label">' + e(label) + '</span>' +
    (direction === 'back' ? '<span class="sr-only"> · 오른쪽에서 왼쪽으로</span>' : '') +
    '<span class="conduit-line" aria-hidden="true"><span>' + arrow + '</span></span></span>';
}

function compactCrew(item, node, view, back, id = '') {
  const state = crewState(item, node, view, back);
  const endpoint = (role, label, agent) => '<span class="crew-end' + (state.holder === role ? ' is-holder' : '') + '">' +
    '<span class="crew-role">' + label + '</span><strong>' + e(agent) + '</strong>' +
    (state.holder === role ? '<span class="holder-label">' + (view.undelivered || view.state === 'queued' || !node.active ? '다음 담당' : '현재 담당') + '</span>' : '') + '</span>';
  return '<span class="crew-track"' + (id ? ' id="' + e(id) + '"' : '') + '>' + endpoint('work', '작업', view.worker) +
    conduit(state.direction, state.label) + endpoint('review', '검토', view.reviewer) + '</span>';
}

function endpointButton(node, prefix = '') {
  const team = teamOf(node.id);
  return '<button type="button" class="flow-endpoint team-' + e(team.id) +
    '" data-action="select-node" data-node="' + e(node.id) + '">' + mark() +
    '<span><small>' + e(prefix + team.name) + '</small><strong>' + e(title(node)) + '</strong></span></button>';
}

function repairConnector(back, item, ctx) {
  const label = '수정 요청 ' + (item.repairLoops ?? 0) + ' / ' + (item.maxRepairLoops ?? 0);
  const fromLabel = back.from.feedback.phase === 'review' ? '검토 · ' : '테스트 · ';
  return '<div class="repair-route' + pulseClass(ctx, back.to.id, 'retry') + '"' + pulseOffset(ctx, back.to.id) + '>' +
    '<div class="repair-track">' + endpointButton(back.to, '재작업 · ') + conduit('back', label) + endpointButton(back.from, fromLabel) + '</div>' +
    '<p>' + e(back.to.feedback.summary ?? '') + '</p></div>';
}

export function collabStrip(item, ctx) {
  const { live } = collaboration(item);
  const back = qaReturn(item);
  const pending = ['paused', 'blocked', ...terminalStates].includes(item.status) ? [] : item.nodes.filter((node) =>
    !node.active && (node.status === 'review' || crewState(item, node, stageView(item, node), back).direction === 'back'));
  const exchanges = [...live, ...pending.map((node) => stageView(item, node))];
  let html = '<section class="collab" aria-labelledby="collab-title"><h2 id="collab-title">현재 작업과 인계</h2>';
  if (!exchanges.length) {
    const idle = item.status === 'paused' ? '일시 정지 중 · 재개하면 다음 단계를 배정합니다.'
      : item.status === 'blocked' ? '확인 대기 · 새 작업 배정이 멈췄습니다.'
        : terminalStates.includes(item.status) ? '이 흐름은 끝났습니다.' : '대기 중 · 실행 중인 에이전트가 없습니다.';
    html += '<p class="collab-idle"><span aria-hidden="true">○</span> ' + e(idle) + '</p>';
  } else {
    html += '<ul class="collab-list">' + exchanges.map((view) => {
      const node = item.nodes.find((entry) => entry.id === view.id);
      const holder = view.undelivered ? '지시 전달 전' : view.state === 'waiting' ? '재작업 대기' : view.label;
      return '<li class="collab-item team-' + e(view.team.id) + pulseClass(ctx, node.id) + '"' + pulseOffset(ctx, node.id) + '><div class="collab-item-head">' +
        endpointButton(node) + '<span class="collab-time">' + e(holder) + (view.startedAt ? ' · ' + sinceWithBudget(view, ctx.now) : '') + '</span></div>' +
        compactCrew(item, node, view, back) + '</li>';
    }).join('') + '</ul>';
  }
  if (back && back.to.status !== 'passed') html += repairConnector(back, item, ctx);
  return html + '</section>';
}

function pulseClass(ctx, id, only) {
  const motion = ctx.motion?.get(id);
  return motion && (!only || motion.kind === only) ? ' pulse-' + motion.kind : '';
}

function pulseOffset(ctx, id) {
  const motion = ctx.motion?.get(id);
  // A state/detail refresh rebuilds the DOM. Join the original event's animation at its elapsed time.
  return motion ? ' style="--event-delay:-' + Math.max(0, ctx.now - motion.at) + 'ms"' : '';
}

function eccSelect(node, ctx, disabled) {
  const current = ctx.draft('assignments', node.id + '.eccAgent', eccOverride(node) ?? '');
  const pinned = current && current !== 'none' ? [current] : [];
  const choices = [...new Set([...(ctx.eccChoices ?? []), ...pinned])];
  return '<select class="field" name="' + e(node.id) + '.eccAgent" ' + (disabled ? 'disabled' : '') + ' aria-label="' + e(title(node)) + ' ECC 에이전트">' +
    options([{ value: '', label: '자동(상황에 맞게)' }, { value: 'none', label: '사용 안 함' }, ...choices], current) + '</select>';
}
function assignmentFields(node, ctx) {
  const disabled = !assignmentMutable(node);
  const agent = ctx.draft('assignments', node.id + '.agent', node.agent);
  return '<td><select class="field" name="' + e(node.id) + '.agent" ' + (disabled ? 'disabled' : '') + ' aria-label="' + e(title(node)) + ' 작업 에이전트">' + options(ctx.providers, agent) + '</select></td>' +
    '<td><select class="field" name="' + e(node.id) + '.reviewer" ' + (disabled ? 'disabled' : '') + ' aria-label="' + e(title(node)) + ' 검토 에이전트">' + options(ctx.providers, ctx.draft('assignments', node.id + '.reviewer', node.reviewer)) + '</select></td>' +
    '<td>' + eccSelect(node, ctx, disabled) + (agent !== 'claude' && eccOverride(node) !== 'none' ? '<span class="hint ecc-note">Claude가 아니라 적용되지 않음</span>' : '') + '</td>' +
    modelFields(node, ctx, disabled, agent);
}
// Model and reasoning effort for the stage's work agent; Orca applies them through its launch hook.
function modelFields(node, ctx, disabled, agent) {
  const launch = ctx.launchOptions ?? {};
  const fallback = launch.visualStages?.includes(node.id) && agent === 'codex' ? launch.visualDefault : null;
  const off = disabled || agent !== 'codex';
  const model = ctx.draft('assignments', node.id + '.model', node.model ?? '');
  const effort = ctx.draft('assignments', node.id + '.effort', node.effort ?? '');
  return '<td class="model-cell"><input class="field" name="' + e(node.id) + '.model" value="' + e(model) + '" placeholder="' + e(fallback?.model ?? '에이전트 기본') +
    '" maxlength="64" autocomplete="off" aria-label="' + e(title(node)) + ' 모델"' + (off ? ' disabled' : '') + '>' +
    '<select class="field" name="' + e(node.id) + '.effort" aria-label="' + e(title(node)) + ' 추론 강도"' + (off ? ' disabled' : '') + '>' +
    options([{ value: '', label: fallback ? '기본(' + fallback.effort + ')' : '기본' }, ...(launch.efforts ?? [])], effort) + '</select>' +
    (agent !== 'codex' ? '<span class="hint ecc-note">Codex 단계에서 지정</span>' : '') + '</td>';
}
/** One form for both tabs: the same stored assignment, edited per stage or for all teams. */
export function assignmentForm(item, nodes, ctx) {
  return '<form id="assignments" data-run="' + e(item.id) + '"><div class="table-wrap"><table class="team-table"><thead><tr><th>단계</th><th>작업</th><th>검토</th><th>ECC</th><th>모델</th></tr></thead><tbody>' +
    nodes.map((node) => '<tr class="team-' + e(teamOf(node.id).id) + '"><th scope="row">' + mark() + e(title(node)) + '</th>' + assignmentFields(node, ctx) + '</tr>').join('') +
    '</tbody></table></div><p class="hint">자동은 시작할 때마다 설치된 ECC에서 프로젝트 스택, 단계, 실패 이력에 맞는 에이전트와 스킬을 고릅니다. 에이전트를 지정하면 그 에이전트를 먼저 제안합니다. ECC는 Claude Code에서만 동작합니다.</p>' +
    '<div class="actions"><button class="button primary" type="submit">배정 저장</button></div></form>';
}

// ---------- Team flow ----------
function relatedStages(item, selectedId, back) {
  const { upstream, downstream } = relations(item, selectedId);
  const related = new Map([...upstream.map((node) => [node.id, 'upstream']), ...downstream.map((node) => [node.id, 'downstream'])]);
  if (back && back.to.status !== 'passed') {
    if (back.to.id === selectedId) related.set(back.from.id, 'repair-source');
    if (back.from.id === selectedId) related.set(back.to.id, 'repair-target');
  }
  return related;
}

const relationLabels = {
  upstream: '선행 단계', downstream: '다음 단계', 'repair-source': '수정 요청 보냄', 'repair-target': '수정 요청 받음',
};
const relationTag = (relation) => relation ? '<span class="relation-tag">' + relationLabels[relation] + '</span>' : '';

function stageConnections(item, related) {
  if (!related.size) return '';
  return '<ul class="stage-connections" aria-label="연결된 단계">' + [...related].map(([id, relation]) => {
    const other = item.nodes.find((node) => node.id === id);
    return '<li>' + endpointButton(other, relationLabels[relation] + ' · ') + '</li>';
  }).join('') + '</ul>';
}

function teamHead(team, count, id = '') {
  return '<header class="lane-head">' + mark() + '<div class="lane-name"><h3' + (id ? ' id="' + e(id) + '"' : '') + '>' + e(team.name) +
    '</h3><p class="lane-craft">' + e(team.craft) + '</p></div><span class="lane-count">' + e(count) + '</span></header>';
}

function stageButton(item, node, ctx, related, back) {
  const view = stageView(item, node);
  const relation = related.get(node.id);
  const selected = node.id === ctx.selectedId;
  const classes = ['stage', 'is-' + view.state, selected ? 'is-selected' : '', relation ? 'is-related is-' + relation : ''].filter(Boolean).join(' ');
  const key = 'stage-' + e(node.id);
  return '<li><button type="button" id="' + key + '" class="' + classes + pulseClass(ctx, node.id) + '" data-action="select-node" data-node="' + e(node.id) + '" data-id="' + e(node.id) + '"' + pulseOffset(ctx, node.id) +
    ' aria-pressed="' + selected + '" aria-labelledby="' + key + '-name ' + key + '-state" aria-describedby="' + key + '-crew' + (relation ? ' ' + key + '-relation' : '') +
    '"><span class="stage-top"><strong class="stage-name" id="' + key + '-name">' + e(title(node)) + '</strong><span id="' + key + '-state">' + stateTag(view.state, view.undelivered) + '</span></span>' +
    compactCrew(item, node, view, back, key + '-crew') + (item.waiting?.[node.id] && !node.active ? '<span class="stage-wait" id="' + key + '-wait">대기 · ' + e(item.waiting[node.id]) + '</span>' : '') + (relation || selected ? '<span class="stage-relations" id="' + key + '-relation">' + (selected ? '<span class="relation-tag">선택한 단계</span>' : relationTag(relation)) + '</span>' : '') +
    '</button>' + (selected ? stageConnections(item, related) + '<div class="stage-actions">' +
      button('단계 상세 보기', 'inspect-stage', 'data-node="' + e(node.id) + '"', 'small') + '</div>' : '') + '</li>';
}

function handoffs(item, sources, ctx, vertical = false) {
  const sourceIds = new Set(sources.map((node) => node.id));
  const team = teamOf(sources[0].id);
  const targets = item.nodes.filter((node) => teamOf(node.id) !== team && node.deps?.some((id) => sourceIds.has(id)));
  if (!targets.length) return '';
  return '<ul class="lane-handoffs" aria-label="다른 팀으로 인계">' + targets.map((target) => {
    const from = sources.filter((node) => target.deps.includes(node.id));
    const done = from.every((node) => node.status === 'passed');
    const hot = from.some((node) => ctx.motion?.get(node.id)?.kind === 'verdict') && done;
    const moving = hot ? from.find((node) => ctx.motion?.get(node.id)?.kind === 'verdict') : null;
    const route = from.some((node) => node.id === ctx.selectedId) || ctx.selectedId === target.id;
    return '<li class="lane-handoff' + (route ? ' is-related' : '') + (moving ? pulseClass(ctx, moving.id, 'verdict') : '') + '"' +
      (moving ? pulseOffset(ctx, moving.id) : '') + '>' + conduit(done ? 'forward' : 'waiting', done ? '인계 완료' : '인계 대기', vertical) +
      endpointButton(target) + '</li>';
  }).join('') + '</ul>';
}

export function teamNavigator(item, ctx) {
  return '<nav class="team-navigator" aria-label="팀으로 이동">' + teamLanes(item).map(({ team, nodes }) => {
    const selected = nodes.find((node) => node.id === ctx.selectedId);
    const destination = selected ?? nodes.find((node) => node.active) ?? nodes.find((node) => !['passed', 'skipped'].includes(node.status)) ?? nodes[0];
    return '<button type="button" class="flow-endpoint team-' + e(team.id) + '" data-action="select-node" data-node="' + e(destination.id) +
      '"' + (selected ? ' aria-current="location"' : '') + '>' + mark() + '<span>' + e(team.name) + '</span></button>';
  }).join('') + '</nav>';
}

export function relay(item, ctx) {
  const back = qaReturn(item);
  const related = relatedStages(item, ctx.selectedId, back);
  return '<ol class="relay" aria-label="팀별 작업 흐름">' + teamLanes(item).map(({ team, nodes }) => {
    const passed = nodes.filter((node) => node.status === 'passed').length;
    const busy = nodes.some((node) => node.active);
    return '<li class="lane team-' + e(team.id) + (busy ? ' is-busy' : '') + '"><section class="team-sheet">' +
      teamHead(team, nodes.every((node) => node.status === 'skipped') ? '건너뜀' : passed + ' / ' + nodes.filter((node) => node.status !== 'skipped').length + ' 통과') +
      '<ol class="lane-stages">' + nodes.map((node) => stageButton(item, node, ctx, related, back)).join('') + '</ol></section>' +
      handoffs(item, nodes, ctx, true) + '</li>';
  }).join('') + '</ol>';
}

function exchange(item, node) {
  const { upstream, downstream } = relations(item, node.id);
  const row = (other, direction) => {
    const view = stageView(item, other);
    const said = direction === 'in'
      ? [other.report?.summary && '작업 · ' + other.report.summary, other.review?.summary && '검토 · ' + other.review.summary].filter(Boolean).join('\n')
      : view.message;
    return '<li class="team-' + e(view.team.id) + '"><button type="button" class="exchange-link" data-action="select-node" data-node="' + e(other.id) + '">' + namedMark(view.team) +
      '<span>' + e(title(other)) + '</span>' + stateTag(view.state) + '</button>' + (said ? '<p class="exchange-said">' + e(said.slice(0, 400)) + '</p>' : '') + '</li>';
  };
  let html = '';
  if (upstream.length) html += '<h4>받은 결과</h4><ul class="exchange">' + upstream.map((other) => row(other, 'in')).join('') + '</ul>';
  if (node.feedback && node.status !== 'passed') html += '<h4>돌아온 수정 요청</h4><p class="exchange-said is-feedback">' + e(node.feedback.summary ?? '') + '</p>';
  if (downstream.length) html += '<h4>결과를 받는 단계</h4><ul class="exchange">' + downstream.map((other) => row(other, 'out')).join('') + '</ul>';
  return html;
}

function recovery(item, node) {
  let html = '';
  if (node.launchUncertain) html += '<label class="checkbox"><input type="checkbox" id="retry-ack">Orca에서 이전 실행 상태를 확인했습니다.</label><p class="hint">응답을 못 받았더라도 에이전트는 시작됐을 수 있습니다. 중복 실행 여부를 먼저 확인하세요.</p>';
  if (node.pendingReceipt?.terminalId) html += '<div class="actions">' + button('이전 에이전트 확인', 'focus-terminal', 'data-terminal="' + e(node.pendingReceipt.terminalId) + '"', 'small') + '</div><label class="checkbox"><input type="checkbox" id="retry-stop">이전 에이전트가 실행 중이면 종료하고 다시 배정</label>';
  const job = (item.jobs ?? []).find((entry) => entry.nonce === node.pendingReceipt?.nonce);
  const open = !terminalStates.includes(item.status);
  if (node.status === 'blocked' && node.pendingReceipt?.terminalId && job?.state === 'awaiting-report' && !job.promptSeen && !job.promptRecovery && open) {
    html += '<div class="callout warning"><strong>터미널이 열렸지만 첫 지시가 전달되지 않았나요?</strong><br>이전 에이전트를 열어 작업을 시작하지 않은 빈 입력 화면인지 확인하세요. 확인한 경우 같은 터미널에 지시를 한 번 전달할 수 있습니다.</div><label class="checkbox"><input type="checkbox" id="delivery-ack">작업이 시작되지 않았고 입력이 비어 있음을 확인했습니다.</label><div class="actions">' +
      button('기존 터미널에 지시 전달', 'deliver-prompt', 'data-run="' + e(item.id) + '" data-node="' + e(node.id) + '" data-nonce="' + e(node.pendingReceipt?.nonce ?? node.active?.nonce ?? '') + '"', 'small') + '</div>';
  }
  if (['failed', 'blocked'].includes(node.status) && !node.active && open) {
    html += '<div class="actions">' + button('이 단계 다시 시도', 'retry-node', 'data-run="' + e(item.id) + '" data-node="' + e(node.id) + '" data-nonce="' + e(node.active?.nonce ?? node.pendingReceipt?.nonce ?? '') + '"', 'primary') + '</div><p class="hint">정해진 시도 횟수 안에서만 다시 실행합니다. 한도를 넘으면 새 흐름을 만들어 범위를 조정해 주세요.</p>';
  }
  return html;
}

// What the worker chose from the installed ECC for this stage's latest launch, and why.
function eccShortlist(node, view) {
  if (view.eccOverride === 'none') return '<p class="hint ecc-shortlist">ECC 사용 안 함</p>';
  const list = view.eccShortlist;
  if (!list) return '<p class="hint ecc-shortlist">시작할 때 설치된 ECC에서 이 단계 상황에 맞는 에이전트와 스킬을 고릅니다.</p>';
  const agent = list.phase === 'review' ? node.reviewer : node.agent;
  const row = (item) => '<li>' + eccTag(item.name, agent === 'claude') + ' <span class="hint">' + e(item.why) + '</span></li>';
  const context = [list.phase === 'review' ? '검토' : '작업', list.stack?.label, list.situation?.summary].filter(Boolean).join(' · ');
  return '<section class="ecc-shortlist" aria-label="ECC 추천"><h4>ECC 추천</h4><p class="hint">' + e(context) + '</p>' +
    (list.agents?.length ? '<ul>' + list.agents.map(row).join('') + '</ul>' : '') +
    (list.skills?.length ? '<p class="hint">스킬</p><ul>' + list.skills.map(row).join('') + '</ul>' : '') +
    (!list.agents?.length && !list.skills?.length ? '<p class="hint">맞는 ECC 항목을 찾지 못했습니다' + (list.error ? ': ' + e(list.error) : '.') + '</p>' : '') +
    (agent !== 'claude' ? '<p class="hint">이 단계 담당이 Claude가 아니라 전달하지 않았습니다.</p>' : '') + '</section>';
}

// Image, sprite and pixel-art skills chosen for this stage's latest work launch, and its model.
function visualPanel(node) {
  const list = node.visualShortlist;
  const launch = node.launchSettings;
  if (!list && !launch) return '';
  const art = list?.art ? (list.art.pixel ? '픽셀 아트' : '픽셀 아트 아님') : '';
  const model = launch ? [launch.model, launch.effort].filter(Boolean).join(' · ') : '';
  return '<section class="ecc-shortlist" aria-label="시각 스킬"><h4>시각 스킬</h4>' + (art ? '<p class="hint">' + e(art) + '</p>' : '') +
    (list?.skills?.length ? '<ul>' + list.skills.map((item) => '<li><span class="ecc-tag">' + e(item.name) + '</span> <span class="hint">' + e(item.why) + '</span></li>').join('') + '</ul>'
      : list ? '<p class="hint">맞는 설치 스킬을 찾지 못했습니다' + (list.error ? ': ' + e(list.error) : '.') + '</p>' : '') +
    (launch ? '<p class="hint">모델 ' + e(model) + (launch.applied ? ' 적용됨' : ' — 적용하지 못했습니다: ' + e(launch.reason ?? '')) + '</p>' : '') + '</section>';
}

export function inspector(item, node, ctx) {
  if (!node) return '';
  const view = stageView(item, node);
  let html = '<aside id="stage-inspector" class="details team-' + e(view.team.id) + '" tabindex="-1" aria-label="선택한 단계 상세"><div class="inspector-head">' + mark() +
    '<div class="grow"><p class="inspector-team">' + e(view.team.name) + '</p><h3>' + e(title(node)) + '</h3></div>' + stateTag(view.state, view.undelivered) + '</div>' +
    '<p class="muted inspector-desc">' + e(descriptions[node.id] ?? node.title) + '</p>' +
    '<p class="meta">작업 시도 ' + (node.attempts ?? 0) + ' / ' + item.maxAttempts + ' · 검토 시도 ' + (node.reviewAttempts ?? 0) + '</p>' + stageTokens(ctx.tokens, node, item.id);
  const submission = node.approval?.submission;
  if (submission?.developerId) html += '<div class="callout"><strong>' + e(submission.accountName) + ' · ' + e(submission.developerId) + '</strong><br>' + e(submission.packageName) + ' · ' + e(submission.track) + ' · v' + e(submission.versionCode) + '</div>';
  if (node.active) {
    html += '<div class="callout live"><strong>' + e(view.undelivered ? view.agent + ' · 지시 전달 전' : view.phase === 'review' ? view.reviewer + '가 독립 검토 중' : view.worker + '가 작업 중') + '</strong> · ' + sinceWithBudget(view, ctx.now) + ' 경과' +
      (view.eccApplies ? '<br>' + e(view.eccAgent) + ' 등 ECC 후보를 함께 전달했습니다.' : '') + '</div><div class="actions">' +
      (node.active.terminalId ? button('에이전트 터미널 열기', 'focus-terminal', 'data-terminal="' + e(node.active.terminalId) + '"', 'primary') : '') +
      button('에이전트 탭에서 보기', 'show-agent', 'data-node="' + e(node.id) + '" data-role="' + e(view.phase) + '"', 'small') + '</div>';
  }
  if (node.failureReason || node.runtimeMessage) html += '<div class="callout warning" role="status">' + e(node.runtimeMessage || node.failureReason) + '</div>';
  html += eccShortlist(node, view);
  html += visualPanel(node);
  html += exchange(item, node);
  if (node.status === 'passed') html += stageResult(item, node, { artifacts: ctx.artifacts ?? new Map() });
  for (const [label, report] of [['작업 보고서', node.report], ['독립 검토 결과', node.review]]) {
    if (!report) continue;
    html += '<div class="divider"></div><h4>' + label + ' ' + badge(report.outcome) + '</h4><p class="note-line">' + e(report.summary) + '</p>';
    if (report.followUps?.length) html += '<div class="follow-ups"><strong>후속 과제 ' + report.followUps.length + '개</strong> · 다음 관련 단계의 지시에 전달됩니다.<ul>' + report.followUps.map((item) => '<li>' + e(item) + '</li>').join('') + '</ul></div>';
    if (report.evidence?.length) {
      html += '<details class="report-evidence" data-disclosure="evidence:' + e(item.id + ':' + node.id + ':' + label) + '"><summary>검증 근거 ' + report.evidence.length + '개</summary>' +
        report.evidence.map((evidence) => '<div class="evidence">' + e(evidence.kind === 'command' ? evidence.command + '\nexit ' + evidence.exitCode : evidence.kind === 'artifact' ? evidence.path : evidence.text ?? JSON.stringify(evidence)) + '</div>').join('') + '</details>';
    }
  }
  if (node.status === 'awaiting-approval') html += ctx.approvalForm(item, node);
  html += recovery(item, node);
  html += '<details class="stage-assign" data-disclosure="assign:' + e(item.id + ':' + node.id) + '"><summary>이 단계 배정 바꾸기</summary>' + assignmentForm(item, [node], ctx) + '</details>';
  return html + '</aside>';
}

export function attachCard(item, ctx) {
  const project = (ctx.state?.projects ?? []).find((entry) => entry.id === item.projectId);
  const candidates = (ctx.state?.workspaces ?? []).filter((workspace) => workspace.projectId === item.projectId &&
    (!workspace.hostId || workspace.hostId === 'local') && workspace.name === item.workspaceCreation?.name && workspace.path !== project?.path)
    .map((workspace) => ({ value: workspace.id, label: workspace.name + ' · ' + (workspace.branch ?? workspace.path) }));
  if (!candidates.length) {
    const unknown = (ctx.state?.warnings ?? []).some((warning) => warning.startsWith('workspace.list'));
    return '<section class="card"><h3>작업 공간 생성 결과 확인 중</h3><p class="hint">' + e(item.workspaceCreation?.name ?? '예약된') +
      (unknown ? ' 작업 공간 목록을 읽지 못해 생성 여부를 아직 알 수 없습니다. 상태 동기화로 다시 확인하세요.</p></section>'
        : ' 작업 공간이 Orca에 없습니다. \'상태 확인 후 재개\'를 누르면 같은 이름으로 다시 만듭니다.</p></section>');
  }
  return '<section class="card"><h3>생성된 작업 공간 연결</h3><p class="hint">응답은 받지 못했지만 예약한 이름의 작업 공간이 Orca에 있습니다. 확인한 뒤 연결하면 일시 정지 상태로 유지됩니다.</p><form id="attach-workspace" data-run="' + e(item.id) + '"><label class="label" for="attach-workspace-id">예약한 이름의 작업 공간</label><select class="field" id="attach-workspace-id" name="workspaceId" required><option value="">확인한 작업 공간 선택</option>' + options(candidates, '') + '</select><div class="actions"><button class="button primary" type="submit">확인한 공간 연결</button></div></form></section>';
}

// ---------- 에이전트 ----------
function memberControl(member, transfer, selectedRole, now, tokens) {
  const role = member.role === 'review' ? '검토' : '작업';
  const selected = selectedRole === member.role;
  const partner = selectedRole && !selected;
  const holder = transfer.holder === member.role;
  const key = e(member.view.id) + '-' + member.role;
  return '<button type="button" class="member is-' + e(member.live) + (holder ? ' is-holder' : '') + (partner ? ' is-partner' : '') +
    '" id="member-' + key + '" data-action="select-agent" data-node="' + e(member.view.id) + '" data-role="' + member.role + '" aria-pressed="' + selected + '">' +
    '<span class="member-role">' + role + '</span><strong class="member-name">' + e(member.agent) + '</strong>' + memberTokens(tokens, member.view.id, member.role) +
    '<span class="live-tag is-' + e(member.live) + '">' + e(LIVE_LABELS[member.live]) + '</span>' +
    (holder ? '<span class="holder-label">' + (member.view.undelivered || !member.view.startedAt ? '다음 담당' : '현재 담당') + '</span>' : '') +
    (partner ? '<span class="member-selection">협업 상대</span>' : '') +
    (selected ? '<span class="member-selection">선택됨</span>' : '') +
    (holder && member.view.startedAt ? '<span class="collab-time">' + since(member.view.startedAt, now) + '</span>' : '') + '</button>';
}

function pairCard(item, node, worker, reviewer, ctx, related, back) {
  const selected = node.id === ctx.selectedId;
  const relation = related.get(node.id);
  const transfer = crewState(item, node, worker.view, back);
  const role = selected ? ctx.selectedRole : null;
  const key = 'pair-' + e(node.id);
  const ecc = [worker, reviewer].filter((member) => member.eccAgent);
  return '<li class="pair' + (selected ? ' is-selected' : '') + (relation ? ' is-related is-' + relation : '') + pulseClass(ctx, node.id) + '" id="' + key +
    '" tabindex="-1" aria-labelledby="' + key + '-title"' + pulseOffset(ctx, node.id) + '>' +
    '<div class="pair-stage"><strong id="' + key + '-title">' + e(title(node)) + '</strong>' + stateTag(worker.view.state, worker.view.undelivered) + '</div>' +
    '<div class="crew-track">' + memberControl(worker, transfer, role, ctx.now, ctx.tokens) + conduit(transfer.direction, transfer.label) +
    memberControl(reviewer, transfer, role, ctx.now, ctx.tokens) + '</div>' + stageTokens(ctx.tokens, node, item.id, 'pair') +
    (relation || selected ? '<div class="stage-relations">' + (selected ? '<span class="relation-tag">선택한 단계</span>' : relationTag(relation)) + '</div>' : '') +
    (selected ? stageConnections(item, related) : '') +
    '<div class="stage-actions">' + button('흐름에서 보기', 'open-stage', 'data-node="' + e(node.id) + '"', 'small') +
    (node.active?.terminalId ? button('터미널 열기', 'focus-terminal', 'data-terminal="' + e(node.active.terminalId) + '"', 'small') : '') + '</div>' +
    (ecc.length ? '<details class="pair-ecc" data-disclosure="ecc:' + e(item.id + ':' + node.id) + '"><summary>ECC 배정</summary><div>' +
      ecc.map((member) => '<span>' + (member.role === 'review' ? '검토 ' : '작업 ') + eccTag(member.eccAgent, member.eccApplies) + '</span>').join('') + '</div></details>' : '') + '</li>';
}

export function people(item, ctx) {
  const back = qaReturn(item);
  const related = relatedStages(item, ctx.selectedId, back);
  return agentRoster(item).map(({ team, members }) => {
    const pairs = [];
    const nodes = [];
    for (let index = 0; index < members.length; index += 2) {
      const worker = members[index];
      const node = item.nodes.find((entry) => entry.id === worker.view.id);
      nodes.push(node);
      pairs.push(pairCard(item, node, worker, members[index + 1], ctx, related, back));
    }
    const working = members.filter((member) => ['working', 'reviewing'].includes(member.live)).length;
    const passed = nodes.filter((node) => node.status === 'passed').length;
    return '<section class="team-block team-' + e(team.id) + '" aria-labelledby="team-' + e(team.id) + '"><div class="team-sheet">' +
      teamHead(team, working ? working + '명 진행 중' : nodes.every((node) => node.status === 'skipped') ? '건너뜀' : passed === nodes.filter((node) => node.status !== 'skipped').length ? '완료' : '대기', 'team-' + team.id) +
      '<ul class="pairs">' + pairs.join('') + '</ul></div>' + handoffs(item, nodes, ctx) + '</section>';
  }).join('');
}
