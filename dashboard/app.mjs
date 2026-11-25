/**
 * Auto APP dashboard pages, rendered from /api/snapshot (and /api/run for one run). Read-only:
 * there is no button that changes Neon, Orca or Play. Labels and badges reuse the Neon panel's kit.
 */
import { e, badge, localDate } from '/panel/kit.mjs';
import { compactTokens } from '/panel/tokens.mjs';

const page = document.getElementById('page');
const REFRESH_MS = 60_000;
let snap = null;
const filters = { query: '', only: 'all' };

const ago = (value) => {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '');
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const minutes = Math.round((Date.now() - ms) / 60000);
  if (minutes < 1) return '방금';
  if (minutes < 60) return minutes + '분 전';
  if (minutes < 1440) return Math.round(minutes / 60) + '시간 전';
  return Math.round(minutes / 1440) + '일 전';
};
const tokens = (value) => value == null ? '—' : compactTokens(value);
const bytes = (value) => value == null ? '—' : (value / 1e9).toFixed(1) + ' GB';
const bar = (stages = []) => stages.length ? '<div class="bar" aria-hidden="true">' + stages.map((status) => '<i class="' + e(status) + '"></i>').join('') + '</div>' : '';
const runLink = (id, text) => '<a href="#/run/' + e(id) + '">' + e(text) + '</a>';
const section = (title, body, note = '') => '<section><h2 class="sec">' + e(title) + (note ? ' <small class="muted">' + e(note) + '</small>' : '') + '</h2>' + body + '</section>';
const empty = (text) => '<p class="muted">' + e(text) + '</p>';
const MATCH = { link: 'Neon 연결', package: '패키지 일치', name: '이름 일치' };
const PLAY_ROW = { published: '게시됨', in_review: '심사 중', rejected: '거부됨', draft: '초안', approved_not_published: '승인·게시 전', no_production: '프로덕션 없음', unknown: '미확인' };

function runCard(run) {
  return '<li class="card' + (run.status === 'blocked' ? ' red' : '') + '"><h3>' + badge(run.status) + runLink(run.id, run.project ?? '프로젝트 미상') + '</h3>' +
    '<div class="ellipsis muted">' + e(run.goal) + '</div>' + bar(run.stages) +
    '<div class="row muted" style="margin-top:4px;font-size:12px">' + run.passed + '/' + run.total + ' 단계 · ' + ago(run.updatedAt) + (run.tokens != null ? ' · 토큰 ' + tokens(run.tokens) : '') + '</div></li>';
}

function freshness() {
  return '<div class="fresh">' + snap.freshness.map((item) => '<span class="chip' + (item.error ? ' bad' : '') + '" title="' + e(item.note ?? item.source ?? '') + '">' +
    e(item.name) + ' ' + (item.error ? '오류' : ago(item.at)) + (item.source === 'storage' ? ' (storage.json 대체)' : '') + '</span>').join('') + '</div>' +
    snap.freshness.filter((item) => item.error).map((item) => '<p class="err" style="font-size:12px">' + e(item.name + ': ' + item.error) + '</p>').join('');
}

function overview() {
  const o = snap.overview;
  const blocked = o.active.filter((run) => run.status === 'blocked').length;
  const tiles = [
    ['진행 중 실행', o.active.length - blocked, 'mint'], ['막힌 실행', blocked, blocked ? 'red' : ''],
    ['일하는 에이전트', o.workingAgents.length, ''], ['확인 필요', o.attention.length, o.attention.length ? 'amber' : ''],
    ['토큰 오늘', tokens(o.tokens.today), ''], ['토큰 7일', tokens(o.tokens.week), ''],
    ['앱', o.counts.apps, ''], ['Play↔프로젝트 매칭', o.counts.matched + '/' + o.counts.play, ''],
  ].map(([label, value, tone]) => '<div class="tile ' + tone + '"><small class="muted">' + e(label) + '</small><b>' + e(value) + '</b></div>').join('');
  const attention = o.attention.map((item) => '<li class="card ' + item.level + '"><h3>' + (item.runId ? runLink(item.runId, item.text) : e(item.text)) + '</h3><div class="ellipsis muted">' + e(item.detail ?? '') + '</div></li>').join('');
  const agents = o.workingAgents.map((agent) => '<li class="card"><h3><span class="chip ok">' + e(agent.type ?? '에이전트') + '</span>' + e(agent.project ?? '') + '</h3><div class="ellipsis muted">' + e(agent.title ?? agent.workspace ?? '') + ' · ' + ago(agent.updatedAt) + '</div></li>').join('');
  const passed = o.passedToday.map((item) => '<li class="card">' + runLink(item.runId, item.project ?? '') + ' · ' + e(item.stage) + '</li>').join('');
  return '<div class="tiles">' + tiles + '</div>' + freshness() +
    section('확인 필요', attention ? '<ul class="list cols">' + attention + '</ul>' : empty('지금 확인할 것이 없습니다.'), 'Neon 실행 · Play 심사/거부') +
    section('진행 중인 Neon 실행', o.active.length ? '<ul class="list">' + o.active.map(runCard).join('') + '</ul>' : empty('진행 중인 Neon 실행이 없습니다.')) +
    section('지금 일하는 에이전트', agents ? '<ul class="list">' + agents + '</ul>' : empty('작업 중으로 보고된 에이전트가 없습니다.'), 'Orca 작업 공간 전체(Neon 밖 포함)') +
    section('토큰', '<p class="muted" style="font-size:12.5px">오늘 ' + tokens(o.tokens.today) + ' · 최근 7일 ' + tokens(o.tokens.week) + ' — Neon 실행 세션만, 세션 첫 배정일 기준. Neon 밖 Orca 작업의 토큰은 포함하지 않습니다.</p>') +
    (passed ? section('오늘 통과한 단계', '<ul class="list">' + passed + '</ul>') : '');
}

function appCard(app) {
  const play = app.play.map((item) => '<span class="badge ' + e(item.production[0]) + '">' + e(item.production.map((status) => PLAY_ROW[status] ?? status).join(' · ')) + '</span>' +
    (item.stale ? '<span class="chip warn">관측 오래됨</span>' : '')).join(' ');
  const run = app.lastRun;
  const commit = app.lastCommit;
  return '<article class="card"><h3>' + e(app.name) + '</h3><div class="row">' +
    (app.stack ? '<span class="chip">' + e(app.stack) + '</span>' : '') +
    (app.projectName ? '<span class="chip">' + e(app.projectName) + '</span>' : '<span class="chip warn">Orca 프로젝트 없음</span>') +
    (app.play.length ? '<span class="chip ok">' + e(MATCH[app.match] ?? 'Play') + '</span>' : app.projectId ? '<span class="chip">Play 없음</span>' : '') + play + '</div>' +
    '<dl class="kv">' +
    '<dt>Neon</dt><dd>' + (run ? badge(run.status) + ' ' + runLink(run.id, run.passed + '/' + run.total + ' 단계') + ' · ' + ago(run.updatedAt) + (app.runCount > 1 ? ' · 실행 ' + app.runCount + '개' : '') + bar(Array.from({ length: run.total }, (_, i) => i < run.passed ? 'passed' : '')) : '<span class="muted">실행 없음</span>') + '</dd>' +
    '<dt>커밋</dt><dd>' + (commit ? ago(commit.at) + ' · <span class="muted">' + e(commit.subject) + '</span>' : '<span class="muted">—</span>') + '</dd>' +
    '<dt>작업 공간</dt><dd>' + (app.projectId ? app.workspaces + '개' + (app.activeWorkspaces ? ' · 활성 ' + app.activeWorkspaces : '') + (app.workingAgents ? ' · <b>에이전트 작업 중 ' + app.workingAgents + '</b>' : '') + (app.dirty ? ' · 미커밋 ' + app.dirty : '') : '—') + '</dd>' +
    (app.play.length ? '<dt>Play</dt><dd>' + app.play.map((item) => e(item.packageName) + ' · ' + e(item.account ?? '') + ' · 관측 ' + ago(item.observedAt)).join('<br>') + '</dd>' : '') +
    '</dl></article>';
}

const APP_FILTERS = [['all', '전체'], ['neon', 'Neon 실행'], ['active', '작업 중'], ['play', 'Play 주의'], ['loose', '매칭 안 됨']];
function appsPage() {
  const query = filters.query.trim().toLowerCase();
  const keep = (app) => {
    if (query && ![app.name, app.projectName, ...app.play.map((item) => item.packageName)].some((text) => String(text ?? '').toLowerCase().includes(query))) return false;
    if (filters.only === 'neon') return Boolean(app.lastRun);
    if (filters.only === 'active') return app.activeWorkspaces > 0 || app.workingAgents > 0;
    if (filters.only === 'play') return app.play.some((item) => item.stale || item.production.join() !== 'published');
    if (filters.only === 'loose') return !app.projectId || (!app.play.length && app.stack);
    return true;
  };
  const shown = snap.apps.filter(keep);
  return '<div class="filters"><input type="search" id="q" placeholder="앱·프로젝트·패키지 검색" value="' + e(filters.query) + '" aria-label="앱 검색">' +
    APP_FILTERS.map(([id, label]) => '<button type="button" data-only="' + id + '" aria-pressed="' + (filters.only === id) + '">' + label + '</button>').join('') + '</div>' +
    '<p class="muted" style="font-size:12px">' + shown.length + '/' + snap.apps.length + '개 · 최근 활동 순 · Play 앱과 Orca 프로젝트의 합집합(매칭: Neon 연결 → 소스의 applicationId → 이름)</p>' +
    '<div class="apps">' + shown.map(appCard).join('') + '</div>';
}

function runsPage() {
  const live = snap.runs.filter((run) => !run.archived), archived = snap.runs.filter((run) => run.archived);
  return section('Neon 실행', '<ul class="list">' + live.map(runCard).join('') + '</ul>') +
    (archived.length ? section('보관한 실행', '<ul class="list">' + archived.map(runCard).join('') + '</ul>') : '');
}

function graph(nodes) {
  const depth = new Map();
  const level = (node) => depth.get(node.id) ?? depth.set(node.id, node.deps.length ? 1 + Math.max(...node.deps.map((id) => level(nodes.find((item) => item.id === id) ?? { id, deps: [] }))) : 0).get(node.id);
  const levels = [];
  for (const node of nodes) (levels[level(node)] ??= []).push(node);
  return '<div class="graph">' + levels.map((items) => '<div class="lvl">' + items.map((node) => '<div class="node ' + e(node.status) + '"><div class="row">' + badge(node.status) + '<b>' + e(node.title) + '</b></div>' +
    '<small class="muted">' + e([node.agent, node.reviewer && '검토 ' + node.reviewer].filter(Boolean).join(' · ')) + (node.attempts ? ' · 시도 ' + node.attempts + '/검토 ' + node.reviewAttempts : '') + '</small>' +
    (node.failureReason ? '<div class="err" style="font-size:11.5px">' + e(String(node.failureReason).slice(0, 160)) + '</div>' : '') + '</div>').join('') + '</div>').join('') + '</div>';
}

function card(item, index) {
  const thumbs = item.evidence.filter((ev) => ev.image).map((ev) => ev.ok ? '<a href="' + e(ev.url) + '" target="_blank" rel="noopener"><img loading="lazy" src="' + e(ev.url) + '" alt="' + e(ev.path) + '"></a>' : '<span class="chip bad" title="' + e(ev.reason) + '">' + e(ev.path) + ' · ' + e(ev.reason) + '</span>').join('');
  const others = item.evidence.filter((ev) => !ev.image);
  return '<li class="card ' + (item.outcome === 'failed' ? 'red' : item.outcome === 'blocked' ? 'amber' : '') + '"><h3>' + badge(item.outcome === 'passed' ? 'passed' : item.outcome === 'failed' ? 'failed' : item.outcome ?? 'unknown') +
    e(item.stage) + ' <small class="muted">' + e((item.phase === 'review' ? '검토' : '작업') + ' ' + (item.attempt ?? '?') + '차 · ' + localDate(item.at)) + '</small>' + (item.failureClass ? '<span class="chip bad">' + e(item.failureClass) + '</span>' : '') + '</h3>' +
    (item.error ? '<p class="err">' + e(item.error) + '</p>' : '') + '<p style="font-size:12.5px">' + e(item.summary ?? '') + '</p>' +
    (item.criteria.length ? '<details><summary>수락 기준 ' + item.criteria.filter((c) => c.met).length + '/' + item.criteria.length + ' 충족</summary><ul class="crit">' + item.criteria.map((c) => '<li class="' + (c.met ? 'ok' : 'no') + '">' + (c.met ? '✓ ' : '✗ ') + e(c.criterion) + '</li>').join('') + '</ul></details>' : '') +
    (item.notVerified ? '<details><summary>검증하지 않은 것</summary><p style="font-size:12.5px">' + e(typeof item.notVerified === 'string' ? item.notVerified : JSON.stringify(item.notVerified)) + '</p></details>' : '') +
    (thumbs ? '<details' + (index < 3 ? ' open' : '') + '><summary>스크린샷</summary><div class="thumbs">' + thumbs + '</div></details>' : '') + // older attempts load their images only when opened
    (others.length ? '<details><summary>근거 파일 ' + others.length + '개</summary><div class="row" style="margin-top:4px">' + others.map((ev) => '<span class="chip' + (ev.ok ? '' : ' bad') + '">' + e(ev.path) + (ev.ok ? '' : ' · ' + e(ev.reason)) + '</span>').join('') + '</div></details>' : '') + '</li>';
}

async function runPage(id) {
  const response = await fetch('/api/run?id=' + encodeURIComponent(id));
  if (!response.ok) return empty('실행을 찾을 수 없습니다.');
  const run = await response.json();
  const usage = run.tokenUsage;
  return '<section><h2 class="sec">' + badge(run.status) + e(run.goal) + '</h2><p class="muted" style="font-size:12.5px">' + e(run.workspace ?? '') + ' · 만든 시각 ' + localDate(run.createdAt) + ' · 갱신 ' + ago(run.updatedAt) +
    (usage?.total != null ? ' · 토큰 ' + tokens(usage.total) : '') + (run.archived ? ' · 보관됨' : '') + '</p></section>' +
    section('단계 그래프', graph(run.nodes)) +
    (Object.keys(run.waiting ?? {}).length ? section('대기 이유', '<ul class="list">' + Object.entries(run.waiting).map(([node, why]) => '<li class="card">' + e(node) + ': ' + e(why) + '</li>').join('') + '</ul>') : '') +
    section('시도별 결과', run.cards.length ? '<ul class="list">' + run.cards.toReversed().map((item, index) => card(item, index)).join('') + '</ul>' : empty('result.json이 아직 없습니다.'), 'result.json · 최신순') +
    section('최근 이벤트', '<details><summary>' + run.events.length + '개</summary><ul class="list" style="margin-top:6px">' + run.events.map((ev) => '<li class="card" style="font-size:12.5px"><span class="muted">' + localDate(ev.at) + '</span> ' + e(ev.text) + '</li>').join('') + '</ul></details>');
}

function opsPage() {
  const ops = snap.ops, limits = ops.limits ?? {};
  const disk = ops.disk;
  const tiles = [['동시 작업', (limits.active ?? 0) + '/' + (limits.activeJobs ?? '?')], ['무거운 작업', (limits.heavy ?? 0) + '/' + (limits.heavyJobs ?? '?')],
    ['디스크 여유', disk ? bytes(disk.free) + ' / ' + bytes(disk.total) : '—'], ['Neon 결과 폴더', disk ? bytes(disk.receipts.bytes) + ' · ' + disk.receipts.files + '개' : '—']]
    .map(([label, value]) => '<div class="tile"><small class="muted">' + e(label) + '</small><b style="font-size:17px">' + e(value) + '</b></div>').join('');
  const waiting = ops.waiting.map((item) => '<li class="card"><h3>' + runLink(item.runId, item.project ?? item.goal) + '</h3>' + Object.entries(item.waiting).map(([node, why]) => '<div style="font-size:12.5px">' + e(node) + ': <span class="muted">' + e(why) + '</span></div>').join('') + '</li>').join('');
  const spaces = ops.workspaces.map((tree) => '<li class="card"><h3>' + badge(tree.status === 'working' ? 'working' : tree.live ? 'active' : 'pending') + e(tree.project ?? '') + ' <small class="muted">' + e(tree.name) + '</small></h3>' +
    '<div class="row muted" style="font-size:12px"><span class="ellipsis">' + e(tree.branch) + '</span>' + (tree.dirty ? '<span class="chip warn">미커밋 ' + tree.dirty + '</span>' : '') + (tree.bot ? '<span class="chip">' + e(tree.bot) + '</span>' : '') + '<span>' + ago(tree.lastActivityAt) + '</span></div>' +
    (tree.agents.length ? '<div class="row" style="margin-top:4px">' + tree.agents.map((agent) => '<span class="chip' + (agent.state === 'working' ? ' ok' : '') + '">' + e(agent.type) + ' · ' + e(agent.state) + '</span>').join('') + '</div>' : '') + '</li>').join('');
  return '<div class="tiles">' + tiles + '</div>' + (ops.diskError ? '<p class="err">' + e(ops.diskError) + '</p>' : '') +
    '<p class="muted" style="font-size:12px">CPU·메모리: ' + e(ops.resources?.reason ?? '미측정') + '</p>' +
    section('스케줄러 대기', waiting ? '<ul class="list">' + waiting + '</ul>' : empty('대기 중인 단계가 없습니다.')) +
    section('작업 공간', '<ul class="list">' + spaces + '</ul>', ops.workspaces.length + '개 · Neon·오케스트레이션·수동 작업 포함, 최근 활동 순');
}

const KIND = { neon: ['Neon', 'ok'], git: ['커밋', ''], journal: ['일지', 'warn'] };
function timelinePage() {
  return snap.timeline.map((entry) => '<section class="day"><h3>' + e(entry.day) + '</h3><ul class="list">' + entry.items.map((item) =>
    '<li class="card"><div class="row"><span class="chip ' + KIND[item.kind][1] + '">' + KIND[item.kind][0] + (item.count > 1 ? ' ' + item.count : '') + '</span><b>' + (item.runId ? runLink(item.runId, item.project ?? '') : e(item.project ?? '')) + '</b>' +
    (item.branches?.length ? '<span class="muted ellipsis" style="font-size:11.5px">' + e(item.branches.join(', ')) + '</span>' : '') + '</div>' +
    '<div class="muted" style="font-size:12.5px;margin-top:3px">' + e(item.text ?? '') + '</div></li>').join('') + '</ul></section>').join('') || empty('최근 14일 기록이 없습니다.');
}

async function render() {
  const [, name, id] = /^#\/(\w*)\/?([\w-]*)/.exec(location.hash || '#/') ?? [];
  const current = name === 'run' ? 'runs' : name || 'overview';
  for (const link of document.querySelectorAll('.dash-nav a')) {
    if (link.dataset.page === current) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  }
  if (!snap) return;
  const pages = { overview, apps: appsPage, runs: runsPage, ops: opsPage, timeline: timelinePage };
  const focused = document.activeElement?.id;
  page.innerHTML = name === 'run' && id ? await runPage(id) : (pages[name] ?? overview)();
  page.setAttribute('aria-busy', 'false');
  if (focused === 'q') { const input = document.getElementById('q'); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); }
}

async function load() {
  try {
    const response = await fetch('/api/snapshot');
    if (!response.ok) throw new Error((await response.json()).error ?? response.status);
    snap = await response.json();
    document.getElementById('stamp').textContent = localDate(snap.generatedAt) + ' 기준' + (snap.build?.label ? ' · Neon ' + snap.build.label : '');
    if (!location.hash.startsWith('#/run/') || !page.dataset.loaded) await render();
    page.dataset.loaded = '1';
  } catch (error) {
    page.innerHTML = '<p class="err">데이터를 불러오지 못했습니다: ' + e(error.message) + '</p>';
  }
}

page.addEventListener('input', (event) => { if (event.target.id === 'q') { filters.query = event.target.value; render(); } });
page.addEventListener('click', (event) => { const only = event.target.closest('[data-only]')?.dataset.only; if (only) { filters.only = only; render(); } });
addEventListener('hashchange', () => { render(); scrollTo(0, 0); });
load();
setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
