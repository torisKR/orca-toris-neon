/**
 * The pixel rows outside the workshop: 오늘 이어하기 (what needs me first, then one row per run) and
 * 에이전트 (Neon's desks against its limits, and the team room). Same states as the workshop
 * (panel/pixelstate.mjs); the person's actions come first and automatic recovery is only observed.
 */
import { button, e, goalTitle } from './kit.mjs';
import { TEAMS, teamOf } from './teams.mjs';
import { msOf, shortTitle } from './pixelstate.mjs';
import { sinceText, stagesOf, sprite, rankGroups } from './pixelview.mjs';
import { runFlows } from './flowstate.mjs';

const FINISHED = new Set(['completed', 'cancelled']);
// Seen, not for the person: Neon is retrying or the agent is quiet; the reason is shown, no action asked.
const OBSERVED = new Set(['retry', 'quiet', 'start-slow']);
// Rows show only stages with something going on; waits and finished stages stay in the workshop.
const SHOWN = new Set(['work', 'review', 'start', 'start-slow', 'retry', 'quiet', 'report', 'approval', 'blocked', 'failed', 'unknown']);
const PERSON_ORDER = ['blocked', 'approval', 'failed'];

/** "내가 봐야 할 것": explicit actions first (start screen, approval, unconfirmed stop, failure), then observations. */
export function attention(runs, ctx) {
  const items = [];
  for (const run of runs) {
    if (run.status === 'completed') continue;
    if (run.status === 'cancelled') {
      if (run.cancelUnsaved || run.stopFailures?.length) items.push({ run, node: null, person: true, rank: 0, pose: 'blocked', label: run.cancelUnsaved ? '취소 저장 대기' : '종료 확인 필요', detail: '실행 카드에서 확인하세요' });
      continue;
    }
    for (const { node, view } of stagesOf(run, ctx)) {
      if (view.person) items.push({ run, node, view, person: true, rank: Math.max(0, PERSON_ORDER.indexOf(view.pose)), pose: view.pose, label: view.label, detail: view.detail || view.reason });
      else if (OBSERVED.has(view.pose)) items.push({ run, node, view, person: false, rank: 10, pose: view.pose, label: view.label, detail: view.detail });
    }
  }
  items.sort((a, b) => a.rank - b.rank);
  const people = items.filter((item) => item.person).length;
  const list = items.length ? '<ul class="px-attention-list">' + items.map((item) => attentionItem(item, ctx)).join('') + '</ul>'
    : '<p class="hint">지금 확인할 일이 없습니다. 멈추거나 승인이 필요하면 여기에 먼저 나타납니다.</p>';
  return '<section class="px-attention" aria-labelledby="px-attention-title"><div class="px-section-head"><h2 id="px-attention-title">내가 봐야 할 것</h2>' +
    '<span class="hint">' + (people ? '조치 ' + people + '건' : '조치 없음') + (items.length > people ? ' · 지켜보는 중 ' + (items.length - people) + '건' : '') + '</span></div>' + list + '</section>';
}

function attentionItem(item, ctx) {
  const team = item.node ? teamOf(item.node.id).id : 'other';
  const action = item.node ? 'data-action="open-stage" data-run="' + e(item.run.id) + '" data-node="' + e(item.node.id) + '"' : 'data-action="open-run" data-run="' + e(item.run.id) + '"';
  const what = item.node ? shortTitle(item.node) + ' · ' : '';
  return '<li><button type="button" class="px-attention-item" data-tone="' + e(item.person ? (item.pose === 'approval' ? 'warn' : 'stop') : 'watch') + '" ' + action + '>' +
    sprite(team, item.view ?? { pose: item.pose, motion: 'still' }) +
    '<span class="px-attention-text"><strong class="px-clamp-2" title="' + e(goalTitle(item.run.goal)) + '">' + e(goalTitle(item.run.goal)) + '</strong><span class="px-state">' + e(what + item.label) + '</span>' +
    (item.detail ? '<small class="px-clamp-3">' + e(item.detail) + '</small>' : '') + '<small class="px-kind">' + (item.person ? '내 조치 필요' : '자동 진행 중 · 지켜보기') + '</small></span>' +
    '<span class="px-chevron" aria-hidden="true">›</span></button></li>';
}

/** "실행 현황": one article per run, each live stage a chip that opens its detail. Reservations are not work. */
export function runRows(runs, ctx) {
  const live = runs.filter((run) => !FINISHED.has(run.status));
  if (!live.length) return '';
  return '<section class="px-runs" aria-labelledby="px-runs-title"><div class="px-section-head"><h2 id="px-runs-title">실행 현황</h2><span class="hint">' + live.length + '개 실행</span></div>' +
    live.map((run) => {
      const stages = stagesOf(run, ctx).filter(({ view }) => SHOWN.has(view.pose));
      const counted = (run.nodes ?? []).filter((node) => node.status !== 'skipped');
      const chips = stages.length ? stages.map(({ node, view }) => chip(run, node, view, ctx)).join('')
        : '<span class="hint">' + (run.started ? (run.status === 'paused' ? '새 배정 멈춤' : '배정 대기') : '시작 전') + '</span>';
      return '<article class="px-run-row" aria-labelledby="px-run-' + e(run.id) + '"><div class="px-run-head"><button type="button" class="px-run-title" id="px-run-' + e(run.id) + '" data-action="open-run" data-run="' + e(run.id) + '" title="' + e(goalTitle(run.goal)) + '"><span class="px-clamp-2">' + e(goalTitle(run.goal)) + '</span></button>' +
        '<span class="px-count">' + counted.filter((node) => node.status === 'passed').length + ' / ' + counted.length + ' 통과</span></div><div class="px-chips">' + chips + '</div>' + miniPath(run, ctx) + '</article>';
    }).join('') + '</section>';
}

const until = (view) => Number.isFinite(view.until) ? ' data-px-until="' + view.until + '"' : '';

// A stage's mark in the path: the most telling of its incoming rails, drawn still (오늘 탭은 기본부터 정지).
const PATH_ORDER = ['stopped', 'live', 'handoff', 'queue', 'complete', 'idle'];
const PATH_MARK = { live: 'arrow', handoff: 'arrow', queue: 'queue', complete: 'complete' };
/**
 * Every stage of a run in rank order for the medium and wide rows (hidden below 561px, so no ids of its own);
 * parallel stages are bracketed. Each opens the existing stage detail. Skipped stages stay, not counted.
 */
export function miniPath(run, ctx) {
  const stages = stagesOf(run, ctx);
  const flows = runFlows(run, stages, { now: ctx.now, cancelling: typeof ctx.cancelling?.has === 'function' ? ctx.cancelling.has(run.id) : Boolean(ctx.cancelling) });
  const step = '<span class="px-mini-step" aria-hidden="true">→</span>';
  const button = (node) => {
    const view = stages.find((stage) => stage.node.id === node.id).view;
    const flow = flows.filter((item) => item.targetId === node.id).sort((a, b) => PATH_ORDER.indexOf(a.state) - PATH_ORDER.indexOf(b.state))[0];
    const mark = flow?.mark === 'quiet' ? 'quiet' : PATH_MARK[flow?.state] ?? (flow?.state === 'stopped' ? 'stop' : '');
    return '<button type="button" class="px-mini-node px-flow-swatch" data-flow="' + e(flow?.state ?? 'idle') + '"' + (flow?.phase ? ' data-phase="' + e(flow.phase) + '"' : '') +
      (flow?.tone ? ' data-tone="' + e(flow.tone) + '"' : '') + (node.status === 'skipped' ? ' data-skipped' : '') + ' data-action="open-stage" data-run="' + e(run.id) + '" data-node="' + e(node.id) + '"' +
      ' aria-label="' + e(shortTitle(node) + ' · ' + view.label) + '" title="' + e(shortTitle(node) + ' · ' + view.label) + '">' +
      (mark ? '<span class="px-flow-mark" data-mark="' + mark + '" aria-hidden="true"></span>' : '') + e(shortTitle(node)) + '</button>';
  };
  const soonest = Math.min(...stages.map(({ view }) => view.until ?? Infinity));
  return '<div class="px-mini-path" id="' + e('path-' + run.id) + '" data-px-piece="path" data-px-run="' + e(run.id) + '"' + until({ until: soonest }) + ' role="group" aria-label="' + e(goalTitle(run.goal) + ' 단계 경로') + '">' +
    rankGroups(run.nodes ?? []).map((group) => group.length > 1 ? '<span class="px-mini-branch">' + group.map(button).join('') + '</span>' : button(group[0])).join(step) + '</div>';
}
/** One live stage of a run row; the tick re-renders it alone when its time boundary passes. */
export function chip(run, node, view, ctx) {
  return '<button type="button" class="px-chip" id="' + e('chip-' + run.id + '-' + node.id) + '" data-tone="' + e(view.tone) + '" data-action="open-stage" data-run="' + e(run.id) + '" data-node="' + e(node.id) + '"' +
    ' data-px-piece="chip" data-px-run="' + e(run.id) + '"' + until(view) + ' aria-label="' + e(shortTitle(node) + ' · ' + view.label) + '">' +
    sprite(teamOf(node.id).id, view, { runId: run.id, nodeId: node.id, memory: ctx.memory, now: ctx.now }) + '<span>' + e(shortTitle(node) + ' · ' + view.label) + '</span></button>';
}

const DESKS_SHOWN = 8;
function deskLine(label, used, limit, mark) {
  if (!Number.isFinite(used) || !Number.isFinite(limit)) return '<div class="px-desk"><span class="px-desk-label">' + e(label) + '</span><strong class="px-desk-count">집계 없음</strong></div>';
  const desks = Array.from({ length: Math.min(limit, DESKS_SHOWN) }, (_, index) => '<span class="px-mark px-2x" data-mark="' + (index < used ? mark : 'desk') + '" aria-hidden="true"></span>').join('');
  return '<div class="px-desk"><span class="px-desk-label">' + e(label) + '</span><strong class="px-desk-count">' + e(used) + ' / ' + e(limit) + '</strong>' +
    (used > limit ? '<span class="px-over">한도 초과 ' + e(used - limit) + '</span>' : '') + '<span class="px-desk-row">' + desks + '</span></div>';
}

/** "Neon 작업 자리": occupied against the limits; heavy desks are part of all desks, never added to them. */
export function desks(limits) {
  return '<section class="px-desks" aria-labelledby="px-desks-title"><h2 id="px-desks-title">Neon 작업 자리</h2><div class="px-desk-grid">' +
    deskLine('전체 작업', limits?.active, limits?.activeJobs, 'desk-busy') + deskLine('빌드·테스트', limits?.heavy, limits?.heavyJobs, 'desk-heavy') + '</div>' +
    '<p class="hint">준비 중이거나 종료가 확인되지 않은 자리도 점유로 집계합니다. Neon이 배정하는 작업에만 적용됩니다. 직접 실행한 다른 에이전트는 세지 않습니다. 한도는 플러그인 설정에서 바꿀 수 있습니다.</p></section>';
}

// The team's representative: a stage that needs the person, then work, then starting, then waiting, then done.
const PICK = [['blocked', 'failed', 'approval'], ['work', 'review', 'quiet', 'report'], ['start', 'start-slow', 'retry', 'unknown'], ['queue', 'dependency', 'paused'], ['passed']];
const pickOrder = (pose) => { const index = PICK.findIndex((group) => group.includes(pose)); return index < 0 ? PICK.length : index; };

/** "팀 작업실": every team, a representative stage each; teams without a stage are shown unassigned. */
export function teamRoom(run, ctx) {
  const others = (run?.nodes ?? []).filter((node) => teamOf(node.id).id === 'other');
  const teams = [...TEAMS, ...(others.length ? [teamOf(others[0].id)] : [])];
  return '<section class="px-team-room" aria-labelledby="px-team-room-title"><div class="px-section-head"><h2 id="px-team-room-title">팀 작업실</h2><span class="hint">' + teams.length + '개 팀</span></div><ul class="px-team-grid">' +
    teams.map((team) => '<li>' + teamCard(run, team.id, ctx) + '</li>').join('') + '</ul></section>';
}

/** One team's card; the tick re-renders it alone when its representative's time boundary passes. */
export function teamCard(run, teamId, ctx) {
  const team = TEAMS.find((item) => item.id === teamId) ?? teamOf('');
  const own = run ? stagesOf(run, ctx).filter(({ node }) => teamOf(node.id).id === teamId)
    .sort((a, b) => pickOrder(a.view.pose) - pickOrder(b.view.pose)) : [];
  if (!own.length) return '<div class="px-team-card" data-tone="neutral">' + sprite(team.id, { pose: 'idle', motion: 'still' }) + '<span class="px-team-text"><strong>' + e(team.name) + '</strong><small>배정된 단계 없음</small></span><span class="px-state">미배정</span></div>';
  const [{ node, view }] = own;
  const busy = own.filter((stage) => pickOrder(stage.view.pose) <= 2).length - (pickOrder(view.pose) <= 2 ? 1 : 0);
  const agent = view.phase === 'review' ? node.reviewer : node.agent;
  const more = busy > 0 ? ' · +' + busy + '개' : '';
  return '<button type="button" class="px-team-card" id="' + e('team-' + run.id + '-' + teamId) + '" data-tone="' + e(view.tone) + '" data-action="select-node" data-node="' + e(node.id) + '"' +
    ' data-px-piece="team" data-px-team="' + e(teamId) + '" data-px-run="' + e(run.id) + '"' + until(view) + ' aria-label="' + e(team.name + ' · ' + shortTitle(node) + (agent ? ' · ' + agent : '') + ' · ' + view.label + more) + '">' +
    sprite(team.id, view, { runId: run.id, nodeId: node.id, memory: ctx.memory, now: ctx.now }) + '<span class="px-team-text"><strong>' + e(team.name) + '</strong><small>' + e(shortTitle(node) + ' · ' + (agent ?? '')) + '</small></span>' +
    '<span class="px-state">' + e(view.label + more) + '</span></button>';
}


// Orca's current-workspace roster includes chat agents, which can report working without a terminal ID.
const ORCA_POSES = {
  working: { pose: 'work', motion: 'loop', label: '작업 중', tone: 'good' },
  blocked: { pose: 'blocked', label: '확인 필요', tone: 'stop' },
  waiting: { pose: 'approval', label: '응답 대기', tone: 'warn' },
  done: { pose: 'idle', label: '턴 종료', tone: 'neutral' },
};

// at: 'narrow' or 'wide' when the same room is placed twice for different panel widths (panel/responsive.css).
export function workspaceRoom(agents, { now, ownedTerminal, showIdle = false, at = '' }) {
  const activeCount = agents.filter((agent) => agent.state === 'working').length;
  const visible = showIdle ? agents : agents.filter((agent) => ['working', 'blocked', 'waiting'].includes(agent.state));
  if (!visible.length && !showIdle) return '';
  const rows = visible.map((agent) => {
    const view = Object.hasOwn(ORCA_POSES, agent.state) ? ORCA_POSES[agent.state] : { pose: 'unknown', label: '상태 미확인', tone: 'neutral' };
    const started = msOf(agent.stateStartedAt);
    const elapsed = started === null ? '' : ' · <time data-px-since="' + started + '" datetime="' + new Date(started).toISOString() + '">' + sinceText(started, now) + '</time>';
    const open = agent.terminalId && ownedTerminal(agent.terminalId) ? button('열기', 'focus-terminal', 'data-terminal="' + e(agent.terminalId) + '"', 'small') : '';
    return '<li class="px-team-card px-workspace-card" data-tone="' + view.tone + '">' + sprite('other', view, { size: 64 }) +
      '<span class="px-team-text"><strong>' + e(agent.title ?? agent.agent ?? 'Orca 에이전트') + '</strong><small>' +
      e(agent.agent ?? 'Orca') + elapsed + '</small></span><span class="px-state">' + view.label + '</span>' + open + '</li>';
  }).join('');
  const titleId = 'px-workspace-title' + (at === 'wide' ? '-wide' : '');
  return '<section class="px-workspace-room"' + (at ? ' data-at="' + e(at) + '"' : '') + ' aria-labelledby="' + titleId + '"><div class="px-section-head"><h2 id="' + titleId + '">현재 작업 공간 · Orca</h2>' +
    '<span class="px-count">' + activeCount + '개 작업 중</span></div>' +
    (rows ? '<ul class="px-team-grid">' + rows + '</ul>' : '<p class="hint">Orca가 보고한 에이전트가 없습니다.</p>') + '</section>';
}
