/**
 * Rail geometry for the workshop floor (docs/design/pixel-ui/RESPONSIVE.md). Pure: boxes are measured stage
 * cards in floor pixels; each rail leaves its own port on the source, turns at 90° in the gap above its
 * arrival on its own track, and goes round by a side gutter when a straight drop would cross another card.
 */
export const PORT_GAP = 24; // ≥ 10 px between ports, and 8 px clear between two 16 px wait or stop marks
export const START_STUB = 18; // the start port: 16–24 px into a stage without deps
const GUTTER = 4, GUTTER_STEP = 6, CLEAR = 4;

const right = (b) => b.left + b.width, bottom = (b) => b.top + b.height, centre = (b) => b.left + b.width / 2;
const round = (value) => Math.round(value);

/** Spread n ports around a card's centre, ordered by the far end's centre, kept inside the card. */
function ports(b, count, index) {
  const x = centre(b) + (index - (count - 1) / 2) * PORT_GAP;
  return Math.min(right(b) - 8, Math.max(b.left + 8, x));
}

/**
 * boxes: Map id → { left, top, width, height }. edges: [{ id, sourceId|null, targetId }].
 * aliases: Map id → box id for a stage folded away (its rail ends on the folded header).
 * Returns [{ id, d, end: { x, y, dir } }]; a rail whose ends are both hidden, or the same box, is left out.
 */
export function routeRails(boxes, edges, { width, aliases = new Map() } = {}) {
  const keyOf = (id) => aliases.get(id) ?? id;
  const all = [...boxes.values()];
  const live = edges.map((edge) => ({ edge, s: edge.sourceId === null ? null : keyOf(edge.sourceId), t: keyOf(edge.targetId) }))
    .filter(({ s, t }) => boxes.has(t) && (s === null || (boxes.has(s) && s !== t)));
  const sameRow = (a, b) => Math.abs(a.top - b.top) < CLEAR && a.left !== b.left;
  // Ports: outgoing ordered by the arrival's centre, incoming by the source's centre.
  const outs = new Map(), ins = new Map();
  for (const item of live) {
    if (item.s === null || sameRow(boxes.get(item.s), boxes.get(item.t))) continue;
    (outs.get(item.s) ?? outs.set(item.s, []).get(item.s)).push(item);
    (ins.get(item.t) ?? ins.set(item.t, []).get(item.t)).push(item);
  }
  for (const [key, list] of outs) list.sort((a, b) => centre(boxes.get(a.t)) - centre(boxes.get(b.t))).forEach((item, i) => { item.sx = ports(boxes.get(key), list.length, i); });
  for (const [key, list] of ins) list.sort((a, b) => centre(boxes.get(a.s)) - centre(boxes.get(b.s))).forEach((item, i) => { item.tx = ports(boxes.get(key), list.length, i); });

  const gapAbove = (t) => Math.max(...all.filter((b) => bottom(b) <= t.top + 0.5).map(bottom), t.top - 2 * PORT_GAP);
  const gapBelow = (s) => Math.min(...all.filter((b) => b.top >= bottom(s) - 0.5).map((b) => b.top), bottom(s) + 2 * PORT_GAP);
  const crosses = (x, from, to, skip) => all.some((b) => !skip.includes(b) && b.left - CLEAR < x && x < right(b) + CLEAR && b.top < to && bottom(b) > from);
  // Each horizontal leg in a gap gets its own track; legs are ordered by where they leave from.
  const tracks = new Map(), gutters = { left: 0, right: 0 };
  for (const item of live.filter((entry) => entry.sx !== undefined).sort((a, b) => a.sx - b.sx)) {
    const s = boxes.get(item.s), t = boxes.get(item.t), top = gapAbove(t);
    item.detour = crosses(item.sx, bottom(s), t.top, [s, t]) && (item.sx === item.tx || crosses(item.sx, bottom(s), top, [s, t]));
    if (item.sx === item.tx && !item.detour) continue;
    const key = top + ':' + t.top;
    (tracks.get(key) ?? tracks.set(key, { top, bottom: t.top, list: [] }).get(key)).list.push(item);
  }
  for (const gap of tracks.values()) gap.list.forEach((item, k) => { item.y = round(gap.top + (gap.bottom - gap.top) * (k + 1) / (gap.list.length + 1)); });

  return live.map((item) => {
    const t = boxes.get(item.t);
    if (item.s === null) {
      const x = round(centre(t));
      return { id: item.edge.id, d: 'M ' + x + ' ' + round(t.top - START_STUB) + ' V ' + round(t.top), end: { x, y: round(t.top), dir: 'down' } };
    }
    const s = boxes.get(item.s);
    if (item.sx === undefined) { // the opening chain: side to side in one row
      const y = round(Math.min(s.top + s.height / 2, t.top + t.height / 2)), [from, to] = t.left >= right(s) ? [right(s), t.left] : [s.left, right(t)];
      return { id: item.edge.id, d: 'M ' + round(from) + ' ' + y + ' H ' + round(to), end: { x: round(to), y, dir: to >= from ? 'right' : 'left' } };
    }
    const sx = round(item.sx), tx = round(item.tx), from = round(bottom(s)), to = round(t.top);
    let d = 'M ' + sx + ' ' + from;
    if (item.detour) {
      const side = sx < width / 2 ? 'left' : 'right', step = gutters[side]++ * GUTTER_STEP;
      const gx = Math.min(Math.max(side === 'left' ? GUTTER + step : width - GUTTER - step, 2), width - 2); // many detours share the edge
      d += ' V ' + round(Math.min(from + PORT_GAP / 3, (from + gapBelow(s)) / 2)) + ' H ' + round(gx) + ' V ' + item.y + ' H ' + tx;
    } else if (sx !== tx) d += ' V ' + item.y + ' H ' + tx;
    return { id: item.edge.id, d: d + ' V ' + to, end: { x: tx, y: to, dir: 'down' } };
  });
}
