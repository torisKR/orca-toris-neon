import test from 'node:test';
import assert from 'node:assert/strict';
import { railHtml, portHtml, railsLayer, flowLegend } from '../panel/flowview.mjs';
import { workshop } from '../panel/pixelview.mjs';
import { runRows, miniPath, workspaceRoom } from '../panel/pixelrooms.mjs';
import { createMotionMemory } from '../panel/pixelstate.mjs';
import { playAppList, lastObserved } from '../panel/play.mjs';
import { createRun } from '../src/engine.mjs';

const NOW = Date.parse('2026-11-28T03:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const ctx = (extra = {}) => ({ now: NOW, memory: createMotionMemory(), limits: null, cancelling: new Set(), fullTitle: (node) => node.title, selectedId: null, ...extra });
const flow = (extra = {}) => ({ id: 'r:a:b', sourceId: 'a', targetId: 'b', state: 'live', label: '공급 중', motion: 'loop', phase: 'work', tone: '', mark: 'arrow', delay: null, ...extra });
function forkRun() {
  const run = createRun({ id: 'r1', goal: '샘플 앱', projectId: 'p', now: NOW - 3_600_000 });
  Object.assign(run, { started: true, status: 'running', jobs: [], waiting: {}, operations: [] });
  for (const id of ['research', 'brief']) Object.assign(run.nodes.find((node) => node.id === id), { status: 'passed', completedAt: iso(NOW - 600_000) });
  Object.assign(run.nodes.find((node) => node.id === 'architecture'), { status: 'running', active: { nonce: 'n1', phase: 'work', startedAt: iso(NOW - 60_000) } });
  run.jobs.push({ nonce: 'n1', nodeId: 'architecture', state: 'running', agentState: 'working', promptSeen: true, sessionId: 's1', lastAgentEventAt: NOW - 5000 });
  run.nodes.find((node) => node.id === 'assets').status = 'skipped';
  return run;
}

test('a rail is decoration keyed by its edge; only a handoff carries pathLength and a one-shot pulse', () => {
  const live = railHtml(flow());
  assert.match(live, /^<g class="px-flow-line" data-edge="r:a:b" data-flow="live" data-phase="work" data-source="a" data-target="b"/);
  assert.doesNotMatch(live, /pathLength|data-pulse/);
  const handoff = railHtml(flow({ state: 'handoff', motion: 'once', delay: 300, phase: '' }));
  assert.match(handoff, /data-pulse style="--px-flow-delay:-300ms"/);
  assert.match(handoff, /<path class="px-flow-parcels" pathLength="100"\/>/);
  assert.doesNotMatch(railHtml(flow({ state: 'handoff', motion: 'still', delay: 300 })), /data-pulse/, 'motion off: the still arrow only');
  assert.match(railsLayer([flow()]), /^<svg class="px-flow-svg" aria-hidden="true" focusable="false">/);
  assert.match(railsLayer([flow()]), /<div class="px-flow-ports" aria-hidden="true">/);
});

test('port marks: a still arrow only shown without motion, wait dots, a stop parcel, a small check; idle has none', () => {
  assert.match(portHtml(flow()), /class="px-flow-mark px-flow-static" data-mark="arrow" data-size="2"/);
  assert.match(portHtml(flow({ state: 'queue', mark: 'queue' })), /class="px-flow-mark" data-mark="queue" data-size="2"/);
  assert.match(portHtml(flow({ state: 'stopped', mark: 'quiet', tone: 'warn' })), /data-tone="warn"[^>]*><span class="px-flow-mark" data-mark="quiet"/);
  assert.match(portHtml(flow({ state: 'complete', mark: 'complete' })), /data-size="1"/);
  assert.doesNotMatch(portHtml(flow({ state: 'idle', mark: '' })), /px-flow-mark/);
});

test('the legend names the four states in words, and the motion switch is a pressed toggle', () => {
  const html = flowLegend();
  for (const word of ['공급 중', '대기', '멈춤', '완료']) assert.match(html, new RegExp('</span>' + word + '</li>'));
  assert.match(html, /<button type="button" class="button small" data-action="flow-motion" aria-pressed="(true|false)">공급 모션 끄기<\/button>/);
});

test('the workshop draws one rail per real dependency and a start port, each named on its arrival station', () => {
  const html = workshop(forkRun(), ctx());
  assert.equal((html.match(/<g class="px-flow-line"/g) ?? []).length, 1 + 12, 'a start port + the 12 deps of the default graph');
  assert.match(html, /data-edge="r1:brief:architecture" data-flow="live" data-phase="work"/);
  assert.match(html, /aria-label="구조 설계 · 작업 중 · 제품 기획에서 공급 중"/);
  assert.match(html, /<div class="px-floor" data-px-flow-run="r1">/);
  assert.match(html, /style="--r2:2;--c2:1;--r3:2;--c3:2"/, 'two placements per card, picked by the workshop width');
  assert.match(workshop(forkRun(), ctx({ flowStill: true })), /<section class="px-workshop"[^>]*data-px-flow-still/);
});

test('오늘: the narrow chips stay, and the whole path is a second, still view without duplicate ids', () => {
  const html = runRows([forkRun()], ctx());
  assert.match(html, /<div class="px-chips">/);
  const path = miniPath(forkRun(), ctx());
  assert.match(path, /^<div class="px-mini-path" id="path-r1" data-px-piece="path" data-px-run="r1"/);
  assert.equal((path.match(/ id="/g) ?? []).length, 1, 'only the container has an id');
  assert.match(path, /<span class="px-mini-branch">.*구조 설계.*화면 설계.*<\/span>/s, 'parallel stages are bracketed');
  assert.match(path, /data-flow="live" data-phase="work"[^>]*data-action="open-stage" data-run="r1" data-node="architecture" aria-label="구조 설계 · 작업 중"/);
  assert.match(path, /data-skipped data-action="open-stage" data-run="r1" data-node="assets"/, 'a skipped stage stays in the path');
  assert.doesNotMatch(path, /data-motion|data-pulse/, 'the path never moves');
});

test('the workspace room placed twice keeps distinct title ids', () => {
  const agents = [{ terminalId: 't', agent: 'codex', title: '샘플', state: 'working', stateStartedAt: NOW - 1000 }];
  const narrow = workspaceRoom(agents, { now: NOW, ownedTerminal: () => true, at: 'narrow' });
  const wide = workspaceRoom(agents, { now: NOW, ownedTerminal: () => true, at: 'wide' });
  assert.match(narrow, /data-at="narrow" aria-labelledby="px-workspace-title"/);
  assert.match(wide, /data-at="wide" aria-labelledby="px-workspace-title-wide"/);
});

test('Play rows carry the wide columns: track count and the newest valid observation, else 미확인', () => {
  const item = { name: '샘플 앱', packageName: 'com.example.sample', storeUrl: 'https://example.com', tracks: [
    { track: 'production', observedAt: '2026-11-28T01:00:00.000Z', releases: [] }, { track: 'internal', observedAt: 'not a date', releases: [] }] };
  assert.equal(lastObserved({ tracks: [] }), '미확인');
  assert.notEqual(lastObserved(item), '미확인');
  const html = playAppList([{ item, statuses: ['published'], check: null }], { id: 'acc' }, { links: [], projects: [], internal: () => null });
  assert.match(html, /^<div class="play-list-head" aria-hidden="true">/);
  assert.match(html, /<span class="play-app-tracks-count">2개 트랙<\/span>/);
  assert.match(html, /<span class="play-app-checked"><span class="sr-only">마지막 확인 <\/span>/);
});
