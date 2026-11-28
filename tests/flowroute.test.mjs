import test from 'node:test';
import assert from 'node:assert/strict';
import { routeRails, PORT_GAP, START_STUB } from '../panel/flowroute.mjs';

// Boxes in floor pixels, as layoutRails() measures them: three lanes of 150 px, 40 px between rows.
const box = (left, top, width = 150, height = 64) => ({ left, top, width, height });
const boxes = new Map([
  ['research', box(14, 20)], ['brief', box(176, 20)],
  ['architecture', box(14, 124)], ['design', box(176, 124)], ['notify', box(338, 124)],
  ['build', box(176, 228)], ['test', box(176, 332)],
]);
const edge = (sourceId, targetId) => ({ id: 'r:' + (sourceId ?? 'start') + ':' + targetId, sourceId, targetId });
const segments = (d) => d.match(/[MVH] -?[\d.]+(?: -?[\d.]+)?/g);
const point = (d) => { const [, x, y] = d.match(/^M (-?[\d.]+) (-?[\d.]+)/); return { x: Number(x), y: Number(y) }; };

test('a chain in one row is one straight rail from the source side to the arrival side', () => {
  const [rail] = routeRails(boxes, [edge('research', 'brief')], { width: 502 });
  assert.equal(rail.d, 'M 164 52 H 176');
  assert.deepEqual([rail.end.dir, rail.end.y], ['right', 52]);
});

test('a start port is a 16–24 px stub into the top of a stage without deps', () => {
  const [rail] = routeRails(boxes, [edge(null, 'research')], { width: 502 });
  assert.ok(START_STUB >= 16 && START_STUB <= 24);
  assert.equal(rail.d, 'M 89 ' + (20 - START_STUB) + ' V 20');
  assert.equal(rail.end.dir, 'down');
});

test('a fork leaves the source from separate ports at least 10 px apart and ends on each arrival top', () => {
  const rails = routeRails(boxes, ['architecture', 'design', 'notify'].map((id) => edge('brief', id)), { width: 502 });
  const starts = rails.map((rail) => point(rail.d));
  assert.ok(PORT_GAP >= 10);
  assert.ok(starts.every((p) => p.y === 84));
  assert.deepEqual(starts.map((p) => p.x), [251 - PORT_GAP, 251, 251 + PORT_GAP], 'ordered by where each arrival is');
  for (const [index, id] of ['architecture', 'design', 'notify'].entries()) assert.match(rails[index].d, new RegExp('V ' + boxes.get(id).top + '$'));
  assert.equal(rails[1].d, 'M 251 84 V 124', 'the middle branch drops straight');
});

test('a merge arrives on separate ports, and each horizontal leg gets its own track in the gap', () => {
  const rails = routeRails(boxes, ['architecture', 'design', 'notify'].map((id) => edge(id, 'build')), { width: 502 });
  const ends = rails.map((rail) => Number(rail.d.match(/H (-?[\d.]+) V 228$/)?.[1] ?? point(rail.d).x));
  assert.deepEqual(ends, [251 - PORT_GAP, 251, 251 + PORT_GAP]);
  const tracks = rails.map((rail) => segments(rail.d).find((part) => part.startsWith('V') && part !== 'V 228')).filter(Boolean);
  assert.equal(new Set(tracks).size, tracks.length, 'no two legs share a track');
  for (const track of tracks) { const y = Number(track.slice(2)); assert.ok(y > 188 && y < 228, track); }
});

test('a long rail that would cross a stage goes round by a side gutter; one with a clear lane drops straight', () => {
  const [blocked] = routeRails(boxes, [edge('brief', 'test')], { width: 502 });
  assert.match(blocked.d, /^M 251 84 V \d+ H (\d+) V \d+ H 251 V 332$/);
  const gutter = Number(blocked.d.match(/H (\d+) V/)[1]);
  assert.ok(gutter < 14 || gutter > 488, 'in the side gutter, outside every lane');
  const [clear] = routeRails(boxes, [edge('architecture', 'test')], { width: 502 });
  assert.doesNotMatch(clear.d, /H [0-9] V|H 4\d\d V/, 'no detour when nothing is in the way');
});

test('an arrival folded away ends on the folded header instead, and rails between hidden stages are skipped', () => {
  const folded = new Map([...boxes, ['release-summary', box(14, 436, 474, 36)]]);
  const rails = routeRails(folded, [edge('test', 'policy'), edge('policy', 'listing')], { width: 502, aliases: new Map([['policy', 'release-summary'], ['listing', 'release-summary']]) });
  assert.equal(rails.length, 1);
  assert.match(rails[0].d, /V 436$/);
});
