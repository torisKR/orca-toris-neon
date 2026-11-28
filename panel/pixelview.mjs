/**
 * The pixel workshop on the Auto App tab: the run header, and one station per stage on the path its
 * real deps draw (docs/design/pixel-ui/SPEC.md). Stations are buttons that open the existing stage
 * detail; every state is real text, sprites are decoration. Motion: CSS steps() from pixel/sprites.css,
 * loops only on a proven work signal, one-shot poses only inside the window the motion memory opened.
 */
import { e } from './kit.mjs';
import { teamOf } from './teams.mjs';
import { stagePixelOf, runPixel, shortTitle } from './pixelstate.mjs';
import { runFlows, incomingText } from './flowstate.mjs';
import { railsLayer, flowLegend, syncRails } from './flowview.mjs';

const RELEASE_STAGES = new Set(['policy', 'listing', 'internal', 'release']);
const scope = (runId, nodeId, kind) => runId + ':' + nodeId + ':' + kind;
// ctx.cancelling is the panel's Set of run ids being cancelled, or already this run's answer.
const cancellingOf = (ctx, run) => typeof ctx.cancelling?.has === 'function' ? ctx.cancelling.has(run.id) : Boolean(ctx.cancelling);

/** Feed one state push into the motion memory: assignment nonces and the two retry counters. */
export function observeRuns(memory, runs, now) {
  for (const run of runs ?? []) {
    for (const node of run.nodes ?? []) {
      memory.observe(scope(run.id, node.id, 'nonce'), node.active?.nonce ?? null, now);
      memory.observe(scope(run.id, node.id, 'delivery'), node.deliveryRetries ?? 0, now);
      memory.observe(scope(run.id, node.id, 'autonomy'), run.autonomy?.retries?.[node.id] ?? 0, now);
    }
  }
}

/** [{ node, view }] for every stage of a run, with the autonomy counter the memory saw grow. */
export function stagesOf(run, ctx) {
  const { now, memory, limits = null } = ctx, cancelling = cancellingOf(ctx, run);
  return (run.nodes ?? []).map((node) => ({ node, view: stagePixelOf(run, node, {
    now, limits, cancelling, autonomyRetry: memory?.raised(scope(run.id, node.id, 'autonomy')) ?? null,
  }) }));
}

/** A crew sprite. Loops say "work signal confirmed"; a one-shot pose joins its window where it is. */
export function sprite(team, view, { size = 32, runId = '', nodeId = '', memory = null, now = 0 } = {}) {
  let motion = '';
  if (view.motion === 'loop') motion = ' data-motion="live"';
  else if (view.motion === 'once' && view.onceScope && memory) {
    const delay = memory.delay(scope(runId, nodeId, view.onceScope), now);
    if (delay !== null) motion = ' data-motion="once" style="animation-delay:-' + Math.round(delay) + 'ms"';
  }
  return '<span class="px-sprite' + (size === 64 ? ' px-2x' : '') + '" data-team="' + e(team) + '" data-pose="' + e(view.pose) + '"' + motion + ' aria-hidden="true"></span>';
}

export const agoText = (ms, now) => {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  return seconds < 60 ? seconds + '초 전' : seconds < 3600 ? Math.floor(seconds / 60) + '분 전' : Math.floor(seconds / 3600) + '시간 전';
};
export const sinceText = (ms, now) => {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  return seconds < 60 ? seconds + '초' : seconds < 3600 ? Math.floor(seconds / 60) + '분 ' + (seconds % 60) + '초' : Math.floor(seconds / 3600) + '시간 ' + Math.floor(seconds % 3600 / 60) + '분';
};
const isoOf = (ms) => new Date(ms).toISOString();
const timeSince = (ms, now) => ms ? '<time data-px-since="' + ms + '" datetime="' + isoOf(ms) + '">' + sinceText(ms, now) + '</time>' : '미확인';
const timeAgo = (ms, now) => ms ? '<time data-px-ago="' + ms + '" datetime="' + isoOf(ms) + '">' + agoText(ms, now) + '</time>' : '기록 없음';
// The tick swaps a piece when its pose or text crosses a time boundary (15 s start, 180 s quiet, minutes).
const until = (ms) => Number.isFinite(ms) ? ' data-px-until="' + ms + '"' : '';

/** The run header: what is happening, why it stopped, and whether something is for the person. */
export function runBanner(run, ctx) {
  const stages = stagesOf(run, ctx);
  const head = runPixel(run, stages, { cancelling: cancellingOf(ctx, run) });
  const node = head.nodeId ? run.nodes.find((item) => item.id === head.nodeId) : null;
  const team = node ? teamOf(node.id).id : 'other';
  const view = { pose: head.pose, motion: head.motion, onceScope: null };
  const elapsed = head.startedAt ? '경과 ' + timeSince(head.startedAt, ctx.now) : '경과 미확인';
  return '<section class="px-banner" data-tone="' + e(head.tone) + '" data-px-piece="banner" data-px-run="' + e(run.id) + '"' + until(head.until) + ' aria-labelledby="px-banner-title">' +
    '<div class="px-banner-main">' + sprite(team, view, { size: 64 }) + '<div class="px-banner-text">' +
    '<h2 class="px-banner-title" id="px-banner-title">' + e(head.headline) + '</h2>' + (head.detail ? '<p class="px-banner-detail">' + e(head.detail) + '</p>' : '') +
    (head.person ? '<p class="px-person">내가 확인할 일이 있습니다' + (node ? ' · 아래 단계 상세에서 조치를 확인하세요' : '') + '</p>' : '') + '</div></div>' +
    '<p class="px-banner-meta">' + elapsed + '<span aria-hidden="true"> · </span>마지막 기록 ' + timeAgo(head.activityAt, ctx.now) + '</p></section>';
}

/** One station: a single button with the stage's crew member, team, name and state as text. */
export function station(run, node, view, ctx, flows = workshopFlows(run, ctx)) {
  const team = teamOf(node.id);
  const selected = node.id === ctx.selectedId;
  const tip = [team.name, ctx.fullTitle(node), view.label, view.detail, view.reason && view.reason !== view.detail ? view.reason : '', view.tooltip,
    view.activityAt ? '마지막 기록 ' + agoText(view.activityAt, ctx.now) : ''].filter(Boolean).join(' · ');
  const key = 'station-' + node.id;
  // The rails into this stage, in words; a handoff ending is a time boundary like the pose's own.
  const into = incomingText(flows, node.id, run.nodes);
  const settles = Math.min(view.until ?? Infinity, ...flows.filter((flow) => flow.targetId === node.id && flow.until).map((flow) => flow.until));
  return '<button type="button" class="px-station" id="' + e(key) + '" data-action="select-node" data-node="' + e(node.id) + '" data-tone="' + e(view.tone) + '"' +
    ' data-px-piece="station" data-px-run="' + e(run.id) + '"' + until(settles) + ' aria-pressed="' + selected + '" aria-controls="stage-inspector"' +
    ' aria-label="' + e(shortTitle(node) + ' · ' + view.label + (into ? ' · ' + into : '')) + '" aria-describedby="' + e(key) + '-tip">' +
    sprite(team.id, view, { runId: run.id, nodeId: node.id, memory: ctx.memory, now: ctx.now }) +
    '<span class="px-station-text"><small class="px-team">' + e(team.name) + '</small><strong class="px-name">' + e(shortTitle(node)) + '</strong>' +
    '<span class="px-state">' + e(view.label) + '</span></span>' +
    '<span class="px-tip" role="tooltip" id="' + e(key) + '-tip">' + e(tip) + '</span></button>';
}

/** Stages grouped by dependency rank (0 = no deps among these nodes), each group in run.nodes order. */
export function rankGroups(nodes) {
  const ids = new Set(nodes.map((node) => node.id));
  const deps = (node) => (node.deps ?? []).filter((id) => ids.has(id));
  const rank = new Map();
  const rankOf = (node) => {
    if (!rank.has(node.id)) { rank.set(node.id, 0); rank.set(node.id, deps(node).length ? 1 + Math.max(...deps(node).map((id) => rankOf(nodes.find((item) => item.id === id)))) : 0); }
    return rank.get(node.id);
  };
  const byRank = [];
  for (const node of nodes) (byRank[rankOf(node)] ??= []).push(node);
  return byRank.filter(Boolean);
}

/**
 * Lanes by dependency rank (RESPONSIVE.md 단계 위치): the same rank shares a row, in run.nodes order, at most
 * `lanes` a row. Positions are half-lane tracks (a card spans two), so a lone stage can sit between lanes.
 * The opening chain (a root that only feeds b, b only needs it) shares one row left to right, as research
 * → brief; a lone stage keeps its only source's place, and a join of several sources is centred.
 */
export function workshopLayout(nodes, lanes) {
  const ids = new Set(nodes.map((node) => node.id));
  const deps = (node) => (node.deps ?? []).filter((id) => ids.has(id));
  const byRank = rankGroups(nodes);
  const feeds = (node) => nodes.filter((item) => deps(item).includes(node.id));
  const place = new Map();
  let row = 0, last = null;
  for (const group of byRank) {
    const [only] = group;
    if (group.length === 1 && last?.length === 1 && !last.chain && !deps(last[0]).length && deps(only).length === 1 && deps(only)[0] === last[0].id && feeds(last[0]).length === 1) {
      place.set(last[0].id, { row, start: 1 }); place.set(only.id, { row, start: 3 }); last.chain = true; continue;
    }
    for (let index = 0; index < group.length; index += lanes) {
      const chunk = group.slice(index, index + lanes);
      row += 1; last = chunk;
      chunk.forEach((node, at) => {
        const from = new Set(deps(node).map((id) => place.get(id)?.start));
        const start = chunk.length === 1 && from.size === 1 && [...from][0] ? [...from][0] : lanes - chunk.length + 2 * at + 1;
        place.set(node.id, { row, start });
      });
    }
  }
  return nodes.map((node) => ({ node, ...place.get(node.id) })).sort((a, b) => a.row - b.row || a.start - b.start);
}

/** Every rail of a run for the workshop, from the same stage views as its stations. */
export function workshopFlows(run, ctx, stages = stagesOf(run, ctx)) {
  return runFlows(run, stages, { now: ctx.now, cancelling: cancellingOf(ctx, run), handoffs: ctx.handoffs ?? null, still: Boolean(ctx.flowStill) });
}

/** After a station is redrawn on its own: bring its run's rails to the same state. */
export function refreshRails(root, run, ctx) {
  const floor = root.querySelector('.px-floor[data-px-flow-run="' + CSS.escape(run.id) + '"]');
  if (floor) syncRails(floor, workshopFlows(run, ctx));
}

// Two placements per card, 2 lanes and 3; pixel-layout.css picks one by the workshop's own width.
function gridHtml(run, nodes, stages, flows, ctx) {
  const viewOf = (node) => stages.find((stage) => stage.node.id === node.id).view;
  const three = new Map(workshopLayout(nodes, 3).map((cell) => [cell.node.id, cell]));
  return '<div class="px-grid">' + workshopLayout(nodes, 2).map(({ node, row, start }) => {
    const wide = three.get(node.id);
    return '<div class="px-cell" style="--r2:' + row + ';--c2:' + start + ';--r3:' + wide.row + ';--c3:' + wide.start + '"' + (start > 2 ? ' data-end2' : '') + (wide.start > 3 ? ' data-end3' : '') + '>' +
      station(run, node, viewOf(node), ctx, flows) + '</div>';
  }).join('') + '</div>';
}

/** The workshop: the run's path from research to test, release preparation folded under it, rails between. */
export function workshop(run, ctx) {
  const stages = stagesOf(run, ctx);
  const flows = workshopFlows(run, ctx, stages);
  const nodes = run.nodes ?? [];
  const release = nodes.length > RELEASE_STAGES.size ? nodes.filter((node) => RELEASE_STAGES.has(node.id)) : [];
  const main = nodes.filter((node) => !release.includes(node));
  const counted = nodes.filter((node) => node.status !== 'skipped');
  const passed = counted.filter((node) => node.status === 'passed').length;
  const back = ctx.repair;
  let html = '<section class="px-workshop" aria-labelledby="px-workshop-title"' + (ctx.flowStill ? ' data-px-flow-still' : '') + '><header class="px-workshop-head"><h2 id="px-workshop-title">제작 작업실</h2>' +
    '<span class="px-count">' + passed + ' / ' + counted.length + '단계 통과</span></header><div class="px-floor" data-px-flow-run="' + e(run.id) + '">' + railsLayer(flows) + gridHtml(run, main, stages, flows, ctx);
  if (back) html += '<p class="px-repair"><span aria-hidden="true">↩ </span>수정 요청 ' + e(run.repairLoops ?? 0) + '/' + e(run.maxRepairLoops ?? 0) + ' · ' + e(shortTitle(back.from)) + ' → ' + e(shortTitle(back.to)) + '</p>';
  if (release.length) {
    const left = release.filter((node) => !['passed', 'skipped'].includes(node.status)).length;
    const busy = stages.some((stage) => release.includes(stage.node) && !['idle', 'dependency', 'queue', 'passed', 'skipped'].includes(stage.view.pose));
    html += '<details class="px-release" data-disclosure="release:' + e(run.id) + '"' + (busy || release.some((node) => node.id === ctx.selectedId) ? ' open' : '') + '><summary>출시 준비 · ' +
      (left ? '남은 ' + left + '단계' : '모두 처리됨') + '</summary>' + gridHtml(run, release, stages, flows, ctx) + '</details>';
  }
  return html + '</div>' + flowLegend() + '</section>';
}
