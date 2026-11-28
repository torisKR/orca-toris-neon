/**
 * The workshop's supply rails (docs/design/pixel-ui/RESPONSIVE.md): one SVG rail and one port mark per real
 * dependency, keyed by edge id. Markup comes from runFlows() (panel/flowstate.mjs); geometry is read from the
 * laid-out cards only when the floor's size changes (ResizeObserver), never per frame. Parcels move with
 * CSS steps() in pixel/flow.css; 공급 모션 끄기 and prefers-reduced-motion leave still arrows.
 */
import { e } from './kit.mjs';
import { routeRails } from './flowroute.mjs';

const STILL_KEY = 'toris-neon.flow-still';
const FOLD = '__fold';
let still = null;

/** The viewer's 공급 모션 끄기 choice, or the system's reduced-motion setting when they never chose. */
export function flowStill() {
  if (still !== null) return still;
  try {
    const saved = globalThis.localStorage?.getItem(STILL_KEY);
    if (saved === '1' || saved === '0') return (still = saved === '1');
  } catch (error) { console.warn('Toris Neon: 공급 모션 설정을 읽지 못해 시스템 설정을 따릅니다.', error); }
  return (still = Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches));
}

function setFlowStill(next) {
  still = next;
  try { globalThis.localStorage?.setItem(STILL_KEY, next ? '1' : '0'); }
  catch (error) { console.warn('Toris Neon: 공급 모션 설정을 저장하지 못했습니다. 이 창에서만 적용됩니다.', error); }
  return still;
}

const signature = (flow) => [flow.state, flow.phase, flow.tone, flow.mark, flow.motion].join('|');
const flowAttrs = (flow) => ' data-edge="' + e(flow.id) + '" data-flow="' + e(flow.state) + '"' + (flow.phase ? ' data-phase="' + e(flow.phase) + '"' : '') +
  (flow.tone ? ' data-tone="' + e(flow.tone) + '"' : '');

/** One rail. A handoff carries data-pulse and joins its 720 ms window where it is (negative delay). */
export function railHtml(flow) {
  const pulse = flow.motion === 'once' ? ' data-pulse style="--px-flow-delay:-' + Math.round(flow.delay ?? 0) + 'ms"' : '';
  return '<g class="px-flow-line"' + flowAttrs(flow) + ' data-source="' + e(flow.sourceId ?? '') + '" data-target="' + e(flow.targetId) + '" data-sig="' + e(signature(flow)) + '"' + pulse + '>' +
    '<path class="px-flow-pipe"/><path class="px-flow-track"/><path class="px-flow-parcels"' + (flow.state === 'handoff' ? ' pathLength="100"' : '') + '/></g>';
}

/** The mark at the arrival port: still arrow (shown only when motion is off), wait dots, stop parcel, check. */
export function portHtml(flow) {
  if (!flow.mark) return '<span class="px-flow-port" data-edge="' + e(flow.id) + '" hidden></span>';
  const moving = flow.state === 'live' || flow.state === 'handoff';
  return '<span class="px-flow-port px-flow-swatch"' + flowAttrs(flow) + ' hidden><span class="px-flow-mark' + (moving ? ' px-flow-static' : '') + '" data-mark="' + e(flow.mark) + '"' +
    ' data-size="' + (flow.mark === 'complete' ? 1 : 2) + '"></span></span>';
}

export const railsLayer = (flows) => '<svg class="px-flow-svg" aria-hidden="true" focusable="false">' + flows.map(railHtml).join('') + '</svg>' +
  '<div class="px-flow-ports" aria-hidden="true">' + flows.map(portHtml).join('') + '</div>';

const swatch = (state, mark, label) => '<li class="px-flow-swatch" data-flow="' + state + '"><span class="px-flow-mark" data-mark="' + mark + '" data-size="2" aria-hidden="true"></span>' + label + '</li>';
/** The legend and the per-viewer motion switch under the floor. */
export const flowLegend = () => '<div class="px-flow-help"><ul class="px-flow-legend" aria-label="공급선 상태">' + swatch('live', 'parcel', '공급 중') + swatch('queue', 'queue', '대기') +
  swatch('stopped', 'stop', '멈춤') + swatch('complete', 'complete', '완료') + '</ul><button type="button" class="button small" data-action="flow-motion" aria-pressed="' + flowStill() + '">공급 모션 끄기</button></div>';

/** Reads the cards' boxes in floor pixels and writes every rail's path and port position. */
export function layoutRails(floor) {
  const base = floor.getBoundingClientRect();
  const rect = (element) => { const box = element.getBoundingClientRect(); return { left: box.left - base.left, top: box.top - base.top, width: box.width, height: box.height }; };
  const boxes = new Map(), aliases = new Map();
  const fold = floor.querySelector('.px-release > summary');
  if (fold?.getClientRects().length) boxes.set(FOLD, rect(fold)); // an obstacle when open, the arrival when folded
  for (const station of floor.querySelectorAll('.px-station[data-node]')) {
    // A closed <details> may still report boxes for its content, so the fold itself decides.
    if (!station.closest('details:not([open])') && station.getClientRects().length) boxes.set(station.dataset.node, rect(station));
    else if (boxes.has(FOLD)) aliases.set(station.dataset.node, FOLD);
  }
  const lines = [...floor.querySelectorAll('.px-flow-line[data-edge]')];
  const edges = lines.map((line) => ({ id: line.dataset.edge, sourceId: line.dataset.source || null, targetId: line.dataset.target }));
  const rails = new Map(routeRails(boxes, edges, { width: base.width, aliases }).map((rail) => [rail.id, rail]));
  const svg = floor.querySelector('.px-flow-svg');
  svg?.setAttribute('width', String(Math.round(base.width)));
  svg?.setAttribute('height', String(Math.round(base.height)));
  for (const line of lines) {
    const rail = rails.get(line.dataset.edge);
    line.style.display = rail ? '' : 'none';
    for (const path of line.querySelectorAll('path')) path.setAttribute('d', rail?.d ?? 'M 0 0');
  }
  for (const port of floor.querySelectorAll('.px-flow-port[data-edge]')) {
    const rail = rails.get(port.dataset.edge);
    port.hidden = !rail || !port.firstElementChild;
    if (!rail) continue;
    const turn = { down: '90deg', left: '180deg', right: '0deg' }[rail.end.dir];
    port.style.cssText = 'left:' + rail.end.x + 'px;top:' + rail.end.y + 'px;--px-flow-turn:' + turn;
    port.dataset.dir = rail.end.dir;
  }
}

/** Swaps only the rails whose state changed (a looping parcel keeps its place), then re-lays them out. */
export function syncRails(floor, flows) {
  for (const flow of flows) {
    const line = floor.querySelector('.px-flow-line[data-edge="' + CSS.escape(flow.id) + '"]');
    const port = floor.querySelector('.px-flow-port[data-edge="' + CSS.escape(flow.id) + '"]');
    if (!line || !port) throw new Error('공급선 ' + flow.id + '을 화면에서 찾지 못했습니다.');
    if (line.dataset.sig === signature(flow) && flow.motion !== 'once') continue;
    line.outerHTML = railHtml(flow);
    port.outerHTML = portHtml(flow);
  }
  layoutRails(floor);
}

let observer = null;
const layoutSafely = (floor) => {
  try { layoutRails(floor); }
  catch (error) { // the rails stay hidden; every station still says its rails' state in words
    for (const line of floor.querySelectorAll('.px-flow-line')) line.style.display = 'none';
    console.error('Toris Neon: 공급선 배치를 계산하지 못했습니다:', error);
  }
};
/** After each render: lay out every floor now and whenever its size changes (lanes, fold, panel width). */
export function mountRails(root) {
  observer?.disconnect();
  const floors = [...root.querySelectorAll('.px-floor')];
  if (typeof ResizeObserver !== 'function') { floors.forEach(layoutSafely); return; }
  observer ??= new ResizeObserver((entries) => { for (const entry of entries) layoutSafely(entry.target); });
  for (const floor of floors) observer.observe(floor);
}

/** The 공급 모션 끄기 switch (data-action="flow-motion"): the display only, for this viewer, without a render. */
export function toggleFlowMotion(root, button) {
  const next = setFlowStill(button.getAttribute('aria-pressed') !== 'true');
  for (const workshop of root.querySelectorAll('.px-workshop')) workshop.toggleAttribute('data-px-flow-still', next);
  button.setAttribute('aria-pressed', String(next));
}
