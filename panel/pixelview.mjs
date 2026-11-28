/**
 * The pixel workshop on the Auto App tab: the run header, and one station per stage on the path its
 * real deps draw (docs/design/pixel-ui/SPEC.md). Stations are buttons that open the existing stage
 * detail; every state is real text, sprites are decoration. Motion: CSS steps() from pixel/sprites.css,
 * loops only on a proven work signal, one-shot poses only inside the window the motion memory opened.
 */
import { e } from './kit.mjs';
import { teamOf } from './teams.mjs';
import { stagePixelOf, runPixel, shortTitle } from './pixelstate.mjs';

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
export function station(run, node, view, ctx) {
  const team = teamOf(node.id);
  const selected = node.id === ctx.selectedId;
  const tip = [team.name, ctx.fullTitle(node), view.label, view.detail, view.reason && view.reason !== view.detail ? view.reason : '', view.tooltip,
    view.activityAt ? '마지막 기록 ' + agoText(view.activityAt, ctx.now) : ''].filter(Boolean).join(' · ');
  const key = 'station-' + node.id;
  return '<button type="button" class="px-station" id="' + e(key) + '" data-action="select-node" data-node="' + e(node.id) + '" data-tone="' + e(view.tone) + '"' +
    ' data-px-piece="station" data-px-run="' + e(run.id) + '"' + until(view.until) + ' aria-pressed="' + selected + '" aria-controls="stage-inspector"' +
    ' aria-label="' + e(shortTitle(node) + ' · ' + view.label) + '" aria-describedby="' + e(key) + '-tip">' +
    sprite(team.id, view, { runId: run.id, nodeId: node.id, memory: ctx.memory, now: ctx.now }) +
    '<span class="px-station-text"><small class="px-team">' + e(team.name) + '</small><strong class="px-name">' + e(shortTitle(node)) + '</strong>' +
    '<span class="px-state">' + e(view.label) + '</span></span>' +
    '<span class="px-tip" role="tooltip" id="' + e(key) + '-tip">' + e(tip) + '</span></button>';
}

/**
 * Rows by dependency rank, at most two stations a row. The opening chain (a root a that only feeds b, b only
 * needs a) shares one row with an arrow, as research → brief; a lone stage sits under the column its deps came from.
 */
export function workshopRows(nodes) {
  const ids = new Set(nodes.map((node) => node.id));
  const deps = (node) => (node.deps ?? []).filter((id) => ids.has(id));
  const rank = new Map();
  const rankOf = (node) => {
    if (!rank.has(node.id)) { rank.set(node.id, 0); rank.set(node.id, deps(node).length ? 1 + Math.max(...deps(node).map((id) => rankOf(nodes.find((item) => item.id === id)))) : 0); }
    return rank.get(node.id);
  };
  const byRank = [];
  for (const node of nodes) (byRank[rankOf(node)] ??= []).push(node);
  const feeds = (node) => nodes.filter((item) => deps(item).includes(node.id));
  const rows = [];
  for (const group of byRank.filter(Boolean)) {
    const last = rows.at(-1);
    const [only] = group;
    if (group.length === 1 && last?.length === 1 && !last.chain && !deps(last[0].node).length && deps(only).length === 1 && deps(only)[0] === last[0].node.id && feeds(last[0].node).length === 1) {
      last.push({ node: only, col: 'right' }); last[0].col = 'left'; last.chain = true; continue;
    }
    for (let index = 0; index < group.length; index += 2) rows.push(group.slice(index, index + 2).map((node, at, pair) => ({ node, col: pair.length === 2 ? (at ? 'right' : 'left') : 'center' })));
  }
  const column = new Map();
  for (const row of rows) {
    for (const cell of row) {
      if (cell.col === 'center') {
        const cols = new Set(deps(cell.node).map((id) => column.get(id)));
        if (cols.size === 1 && ['left', 'right'].includes([...cols][0])) cell.col = [...cols][0];
      }
      column.set(cell.node.id, cell.col);
    }
  }
  return rows;
}

function rowsHtml(run, rows, stages, ctx) {
  const viewOf = (node) => stages.find((stage) => stage.node.id === node.id).view;
  const done = (id) => ['passed', 'skipped'].includes(run.nodes.find((node) => node.id === id)?.status);
  return rows.map((row, index) => {
    const needs = row.flatMap((cell) => cell.node.deps ?? []);
    const rail = index ? '<div class="px-rail" data-done="' + (needs.length > 0 && needs.every(done)) + '" aria-hidden="true"></div>' : '';
    const cells = row.map((cell, at) => '<div class="px-cell" data-col="' + cell.col + '">' + station(run, cell.node, viewOf(cell.node), ctx) + '</div>' +
      (row.chain && !at ? '<span class="px-arrow" data-done="' + done(cell.node.id) + '" aria-hidden="true">→</span>' : '')).join('');
    return rail + '<div class="px-row' + (row.chain ? ' is-chain' : '') + '">' + cells + '</div>';
  }).join('');
}

/** The workshop: the run's path from research to test, release preparation folded under it. */
export function workshop(run, ctx) {
  const stages = stagesOf(run, ctx);
  const nodes = run.nodes ?? [];
  const release = nodes.length > RELEASE_STAGES.size ? nodes.filter((node) => RELEASE_STAGES.has(node.id)) : [];
  const main = nodes.filter((node) => !release.includes(node));
  const counted = nodes.filter((node) => node.status !== 'skipped');
  const passed = counted.filter((node) => node.status === 'passed').length;
  const back = ctx.repair;
  let html = '<section class="px-workshop" aria-labelledby="px-workshop-title"><header class="px-workshop-head"><h2 id="px-workshop-title">제작 작업실</h2>' +
    '<span class="px-count">' + passed + ' / ' + counted.length + '단계 통과</span></header><div class="px-floor">' + rowsHtml(run, workshopRows(main), stages, ctx);
  if (back) html += '<p class="px-repair"><span aria-hidden="true">↩ </span>수정 요청 ' + e(run.repairLoops ?? 0) + '/' + e(run.maxRepairLoops ?? 0) + ' · ' + e(shortTitle(back.from)) + ' → ' + e(shortTitle(back.to)) + '</p>';
  if (release.length) {
    const left = release.filter((node) => !['passed', 'skipped'].includes(node.status)).length;
    const busy = stages.some((stage) => release.includes(stage.node) && !['idle', 'dependency', 'queue', 'passed', 'skipped'].includes(stage.view.pose));
    html += '<details class="px-release" data-disclosure="release:' + e(run.id) + '"' + (busy || release.some((node) => node.id === ctx.selectedId) ? ' open' : '') + '><summary>출시 준비 · ' +
      (left ? '남은 ' + left + '단계' : '모두 처리됨') + '</summary>' + rowsHtml(run, workshopRows(release), stages, ctx) + '</details>';
  }
  return html + '</div></section>';
}
