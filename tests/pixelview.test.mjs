import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, templateGraph } from '../src/engine.mjs';
import { workshopLayout, workshop, station, sprite, runBanner, observeRuns } from '../panel/pixelview.mjs';
import { attention, desks, teamRoom, runRows } from '../panel/pixelrooms.mjs';
import { createMotionMemory } from '../panel/pixelstate.mjs';
import { tickPixels, startTicker, TICK_MS } from '../panel/pixeltick.mjs';

const NOW = Date.parse('2026-11-28T03:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const ctx = (extra = {}) => ({ now: NOW, memory: createMotionMemory(), limits: null, cancelling: new Set(), fullTitle: (node) => node.title, selectedId: null, ...extra });
function stuckRun() {
  const run = createRun({ id: 'r1', goal: '샘플 앱', projectId: 'p', now: NOW - 3_600_000 });
  for (const node of run.nodes) { node.agent = 'codex'; node.reviewer = 'claude'; }
  Object.assign(run, { started: true, status: 'running', jobs: [], waiting: {}, operations: [] });
  for (const id of ['research', 'brief']) run.nodes.find((node) => node.id === id).status = 'passed';
  Object.assign(run.nodes.find((node) => node.id === 'design'), { status: 'running', deliveryRetries: 2, active: { nonce: 'n3', phase: 'work', startedAt: iso(NOW - 78_000) } });
  run.jobs.push({ nonce: 'n3', nodeId: 'design', state: 'running', selfDelivery: true, startedAt: iso(NOW - 78_000) });
  return run;
}

const placed = (cells) => cells.map((cell) => cell.node.id + ':' + cell.row + '/' + cell.start);
test('two lanes keep the SPEC path: research → brief in one row, architecture | design, assets under design, build and test centred', () => {
  const nodes = templateGraph('new-app').filter((node) => !['policy', 'listing', 'internal', 'release'].includes(node.id));
  // start is a half-lane track: 1 = left lane, 3 = right lane, 2 = between them.
  assert.deepEqual(placed(workshopLayout(nodes, 2)), ['research:1/1', 'brief:1/3', 'architecture:2/1', 'design:2/3', 'assets:3/3', 'build:4/2', 'test:5/2']);
});

test('three lanes: parallel stages from one source share a row; a join takes the middle lane', () => {
  const fan = [{ id: 'brief', deps: [] }, { id: 'a', deps: ['brief'] }, { id: 'b', deps: ['brief'] }, { id: 'c', deps: ['brief'] }, { id: 'build', deps: ['a', 'b', 'c'] }, { id: 'test', deps: ['build'] }];
  assert.deepEqual(placed(workshopLayout(fan, 3)), ['brief:1/3', 'a:2/1', 'b:2/3', 'c:2/5', 'build:3/3', 'test:4/3']);
  assert.deepEqual(placed(workshopLayout(fan, 2)), ['brief:1/2', 'a:2/1', 'b:2/3', 'c:3/2', 'build:4/2', 'test:5/2'], 'a rank wider than the lanes goes on to the next row');
});

test('a diagnosis follows one path in one row', () => {
  assert.deepEqual(placed(workshopLayout(templateGraph('diagnose'), 2)), ['identity:1/1', 'diagnose:1/3']);
});

test('a station is one button named "<단계> · <상태 문구>" with its state as text, a tooltip and the existing select action', () => {
  const run = stuckRun();
  const html = workshop(run, ctx({ selectedId: 'design' }));
  const button = html.match(/<button[^>]*id="station-design"[^>]*>/)[0];
  assert.match(button, /data-action="select-node" data-node="design"/);
  assert.match(button, /aria-label="화면 설계 · 시작 지연 · 재시도 2\/3 · 제품 기획에서 멈춤 · 시작 지연 · 재시도 2\/3"/, 'the rail into it is named too');
  assert.match(button, /aria-pressed="true"/);
  assert.match(button, /aria-describedby="station-design-tip"/);
  assert.match(html, /<span class="px-state">시작 지연 · 재시도 2\/3<\/span>/);
  assert.match(html, /role="tooltip" id="station-design-tip">디자인팀 · /);
  assert.doesNotMatch(html, /<button[^>]*>(?:(?!<\/button>).)*<button/s, 'no button inside a station');
  assert.match(html, /<details class="px-release"[^>]*><summary>출시 준비 · 남은 4단계/);
});

test('sprites are decoration; only proven work loops, and a one-shot plays only inside its window', () => {
  assert.match(sprite('build', { pose: 'work', motion: 'loop' }), /aria-hidden="true"/);
  assert.match(sprite('build', { pose: 'work', motion: 'loop' }), /data-motion="live"/);
  assert.doesNotMatch(sprite('build', { pose: 'quiet', motion: 'still' }), /data-motion/);
  const memory = createMotionMemory();
  const run = stuckRun();
  observeRuns(memory, [run], NOW); // the panel opens on this state: nothing replays
  const view = { pose: 'retry', motion: 'once', onceScope: 'delivery' };
  assert.doesNotMatch(sprite('design', view, { runId: 'r1', nodeId: 'design', memory, now: NOW }), /data-motion/);
  run.nodes.find((node) => node.id === 'design').deliveryRetries = 3 - 1 + 0; // unchanged
  observeRuns(memory, [{ ...run, nodes: run.nodes.map((node) => node.id === 'design' ? { ...node, deliveryRetries: 3 } : node) }], NOW + 200);
  assert.match(sprite('design', view, { runId: 'r1', nodeId: 'design', memory, now: NOW + 500 }), /data-motion="once" style="animation-delay:-300ms"/);
});

test('the run header names the cause, the elapsed time and the last record as live text', () => {
  const html = runBanner(stuckRun(), ctx());
  assert.match(html, /<h2 class="px-banner-title" id="px-banner-title">화면 설계 · 시작 지연 · 재시도 2\/3<\/h2>/);
  assert.match(html, /준비 신호 대기 · 반복되면 시작 화면 확인/);
  assert.match(html, /경과 <time data-px-since="\d+"[^>]*>1분 18초<\/time>/);
  assert.match(html, /data-px-until=|마지막 기록/);
});

test('오늘 이어하기 lists the person\'s actions before automatic recovery, which is only watched', () => {
  const blocked = stuckRun();
  blocked.id = 'r2'; blocked.goal = '멈춘 앱';
  Object.assign(blocked.nodes.find((node) => node.id === 'design'), { status: 'blocked', active: null, deliveryRetries: 3 });
  const html = attention([stuckRun(), blocked], ctx());
  assert.ok(html.indexOf('멈춘 앱') < html.indexOf('샘플 앱'));
  assert.match(html, /멈춤 · 시작 준비 실패 · 3\/3[\s\S]*내 조치 필요[\s\S]*시작 지연 · 재시도 2\/3[\s\S]*자동 진행 중 · 지켜보기/);
  assert.match(html, /data-action="open-stage" data-run="r2" data-node="design"/);
});

test('Neon\'s desks show real counts, never added together, and say when a count is missing or over the limit', () => {
  const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text(desks({ active: 3, activeJobs: 2, heavy: 1, heavyJobs: 1 })), /전체 작업 3 \/ 2 한도 초과 1 빌드·테스트 1 \/ 1/);
  assert.match(text(desks(null)), /전체 작업 집계 없음 빌드·테스트 집계 없음/);
});

test('the team room shows every team; a team without a stage is unassigned', () => {
  const html = teamRoom(stuckRun(), ctx());
  assert.equal((html.match(/class="px-team-card"/g) ?? []).length, 7);
  assert.match(html, /aria-label="디자인팀 · 화면 설계 · codex · 시작 지연 · 재시도 2\/3"/, 'the name carries what the card shows');
  assert.match(html, /수익화팀<\/strong><small>배정된 단계 없음<\/small><\/span><span class="px-state">미배정/);
});

// --- The one timer.
function fakeRoot(elements) {
  return { querySelectorAll: (selector) => elements.filter((element) => element.matches(selector)) };
}
const element = (selector, dataset, text = '') => ({ matches: (s) => s === selector, dataset, textContent: text });

test('the tick rewrites time text in place and hands back only the pieces whose time boundary passed', () => {
  const since = element('time[data-px-since]', { pxSince: String(NOW - 78_000) });
  const ago = element('time[data-px-ago]', { pxAgo: String(NOW - 18_000) });
  const due = element('[data-px-until]', { pxUntil: String(NOW - 1) });
  const later = element('[data-px-until]', { pxUntil: String(NOW + 10_000) });
  const handed = [];
  tickPixels(fakeRoot([since, ago, due, later]), NOW, (pieces) => handed.push(...pieces));
  assert.equal(since.textContent, '1분 18초');
  assert.equal(ago.textContent, '18초 전');
  assert.deepEqual(handed, [due]);
});

test('with nothing focused every time keeps moving; only a focused control keeps its own text', () => {
  const body = { contains: () => true };
  const time = element('time[data-px-ago]', { pxAgo: String(NOW - 18_000) }, 'old');
  const saved = globalThis.document;
  globalThis.document = { body, activeElement: body };
  try {
    tickPixels(fakeRoot([time]), NOW, () => {});
    assert.equal(time.textContent, '18초 전');
    globalThis.document = { body, activeElement: { contains: (node) => node === time } };
    tickPixels(fakeRoot([time]), NOW + 60_000, () => {});
    assert.equal(time.textContent, '18초 전', 'the focused control keeps its text');
  } finally { globalThis.document = saved; }
});

test('the ticker runs every 5 s only while the panel is visible', () => {
  const listeners = {}, intervals = [];
  const document = { visibilityState: 'visible', addEventListener: (name, fn) => { listeners[name] = fn; } };
  const timers = { setInterval: (fn, ms) => { intervals.push(ms); return intervals.length; }, clearInterval: () => intervals.push('cleared') };
  let ticks = 0;
  startTicker(() => ticks++, { document, timers });
  assert.deepEqual(intervals, [TICK_MS]);
  assert.equal(TICK_MS, 5000);
  document.visibilityState = 'hidden'; listeners.visibilitychange();
  assert.deepEqual(intervals, [TICK_MS, 'cleared']);
  document.visibilityState = 'visible'; listeners.visibilitychange();
  assert.equal(ticks, 2, 'ticks at once when shown again');
});

test('a long run goal is a clamped title with the full text in its title attribute, and the pass count is kept apart', () => {
  // Arrange: a goal written as one long sentence.
  const goal = '하루 일정과 습관을 한 화면에서 기록하고 주간 통계를 보여 주며 알림 시간과 위젯을 사용자가 직접 고를 수 있는 생산성 앱의 첫 버전을 만들고 안드로이드 실기기에서 저장과 복원까지 확인해 주세요 그리고 다크 모드도 지원해야 합니다';
  const run = { ...stuckRun(), goal };
  // Act
  const rows = runRows([run], ctx());
  const needs = attention([run], ctx());
  // Assert
  assert.match(rows, /<button[^>]*class="px-run-title"[^>]*title="하루 일정과[^"]*다크 모드도 지원해야 합니다"[^>]*><span class="px-clamp-2">/);
  assert.match(rows, /<span class="px-count">2 \/ 11 통과<\/span>/);
  assert.match(needs, /<strong class="px-clamp-2" title="하루 일정과[^"]*">/);
  assert.match(needs, /<small class="px-clamp-3">/);
});

test('in the light theme the dark pixel floor points the page ink tokens at pixel ink that meets AA', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = (name) => readFile(new URL('../panel/' + name, import.meta.url), 'utf8');
  const [readable, layout] = await Promise.all([css('pixel-readable.css'), css('pixel-layout.css')]);
  const rule = readable.match(/html\.light :is\(([^)]*)\) \{([^}]*)\}/);
  assert.ok(rule, 'a light-theme override for the pixel pieces');
  assert.match(rule[1], /\.px-workshop/);
  for (const [page, pixel] of [['fg', 'px-text'], ['muted', 'px-muted'], ['line', 'px-line']]) assert.match(rule[2], new RegExp('--' + page + ': var\\(--' + pixel + '\\)'), page);
  const token = (name) => layout.match(new RegExp('--' + name + ': (#[0-9a-f]{6})'))[1];
  const lum = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const ink of ['px-text', 'px-muted']) for (const ground of ['px-bg', 'px-panel', 'px-raised', 'px-well', 'px-work-bg', 'px-warn-bg', 'px-stop-bg']) {
    assert.ok(ratio(token(ink), token(ground)) >= 4.5, ink + ' on ' + ground);
  }
});
