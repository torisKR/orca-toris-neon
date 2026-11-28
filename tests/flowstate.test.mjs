import test from 'node:test';
import assert from 'node:assert/strict';
import { stagePixelOf } from '../panel/pixelstate.mjs';
import { flowEdges, edgeFlow, runFlows, incomingText, createHandoffMemory, HANDOFF_MS } from '../panel/flowstate.mjs';

const NOW = Date.parse('2026-11-28T03:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
// brief feeds three parallel stages (the RESPONSIVE.md sample); build joins them.
const graph = () => [
  { id: 'research', title: '시장·앱 조사', deps: [] },
  { id: 'brief', title: '제품 기획', deps: ['research'] },
  { id: 'architecture', title: '구조 설계', deps: ['brief'] },
  { id: 'design', title: '화면 설계', deps: ['brief'] },
  { id: 'notify', title: '알림 설계', deps: ['brief', 'missing'] },
  { id: 'build', title: '앱 구현', deps: ['architecture', 'design', 'notify'] },
].map((node) => ({ status: 'pending', active: null, attempts: 0, ...node }));
function sample({ passed = ['research', 'brief'], ...extra } = {}) {
  const run = { id: 'r1', status: 'running', started: true, maxConcurrency: 3, nodes: graph(), jobs: [], waiting: {}, operations: [], ...extra };
  for (const id of passed) Object.assign(node(run, id), { status: 'passed', completedAt: iso(NOW - 600_000) });
  return run;
}
const node = (run, id) => run.nodes.find((item) => item.id === id);
// A turn proven in the agent's own session after the prompt was sent (panel/pixelstate.mjs workSignal).
function working(run, id, { phase = 'work', ago = 5000 } = {}) {
  Object.assign(node(run, id), { status: phase === 'review' ? 'review' : 'running', active: { nonce: id + '-n', phase, startedAt: iso(NOW - ago - 60_000) } });
  run.jobs.push({ nonce: id + '-n', nodeId: id, state: 'running', agentState: 'working', promptSeen: true, sessionId: 's-' + id, lastAgentEventAt: NOW - ago, startedAt: iso(NOW - ago - 60_000) });
}
const views = (run, opts = {}) => run.nodes.map((item) => ({ node: item, view: stagePixelOf(run, item, { now: NOW, ...opts }) }));
const flowOf = (run, sourceId, targetId, opts = {}) => {
  const flows = runFlows(run, views(run, opts), { now: NOW, ...opts });
  return flows.find((flow) => flow.sourceId === sourceId && flow.targetId === targetId);
};

test('edges come only from target.deps: one per real dep, a start port for a stage without deps, unknown ids dropped', () => {
  const edges = flowEdges(sample());
  assert.deepEqual(edges.map((edge) => [edge.sourceId, edge.targetId]), [
    [null, 'research'], ['research', 'brief'], ['brief', 'architecture'], ['brief', 'design'], ['brief', 'notify'],
    ['architecture', 'build'], ['design', 'build'], ['notify', 'build']]);
  assert.equal(edges[1].id, 'r1:research:brief');
  assert.equal(edges[0].id, 'r1:start:research');
});

// --- the RESPONSIVE.md table, one row each.
test('complete: a completed run settles every rail; while running, only a rail into an already passed stage', () => {
  const run = sample();
  assert.equal(flowOf(run, 'research', 'brief').state, 'complete');
  assert.equal(flowOf(run, 'research', 'brief').label, '완료');
  assert.equal(flowOf(run, 'brief', 'architecture').state, 'idle');
  const done = sample({ status: 'completed', passed: ['research', 'brief'] });
  working(done, 'design'); // stale work evidence on a finished run never flows
  assert.deepEqual(runFlows(done, views(done), { now: NOW }).map((flow) => flow.state), Array(8).fill('complete'));
});

test('stopped: the stop parcel at the arrival port, the stage reason in the label; quiet and slow starts are amber', () => {
  const run = sample();
  Object.assign(node(run, 'notify'), { status: 'running', active: { nonce: 'nn', phase: 'work', startedAt: iso(NOW - 78_000) } });
  run.jobs.push({ nonce: 'nn', nodeId: 'notify', state: 'running', selfDelivery: true, startedAt: iso(NOW - 78_000), blocker: { kind: 'start-dialog', agent: 'claude', dialog: 'code-mode' } });
  const stop = flowOf(run, 'brief', 'notify');
  assert.deepEqual([stop.state, stop.label, stop.mark, stop.tone, stop.motion], ['stopped', '멈춤 · 시작 화면', 'stop', 'stop', 'still'], 'a reason that already says 멈춤 is not doubled');
  const quiet = sample();
  working(quiet, 'design', { ago: 250_000 });
  const flow = flowOf(quiet, 'brief', 'design');
  assert.deepEqual([flow.state, flow.mark, flow.tone], ['stopped', 'quiet', 'warn']);
  assert.match(flow.label, /^멈춤 · 4분째 조용함$/);
});

test('stopped: cancelling or a cancelled run takes motion off every unfinished rail at once', () => {
  const run = sample();
  working(run, 'architecture');
  assert.equal(flowOf(run, 'brief', 'architecture', { cancelling: true }).state, 'stopped');
  assert.equal(flowOf(run, 'research', 'brief', { cancelling: true }).state, 'complete');
  const cancelled = sample({ status: 'cancelled' });
  working(cancelled, 'architecture');
  assert.equal(flowOf(cancelled, 'brief', 'architecture').state, 'stopped');
});

test('live: only a confirmed work or review turn at the arrival flows, from a passed source or the start port', () => {
  const run = sample();
  working(run, 'architecture');
  working(run, 'design', { phase: 'review' });
  const work = flowOf(run, 'brief', 'architecture'), review = flowOf(run, 'brief', 'design');
  assert.deepEqual([work.state, work.label, work.motion, work.phase, work.mark], ['live', '공급 중', 'loop', 'work', 'arrow']);
  assert.deepEqual([review.state, review.label, review.phase], ['live', '검토 · 공급 중', 'review']);
  const first = sample({ passed: [] });
  working(first, 'research');
  assert.deepEqual([flowOf(first, null, 'research').state, flowOf(first, null, 'research').label], ['live', '공급 중']);
});

test('live never starts from a start notice, a slot reservation, an old signal or the previous assignment', () => {
  const starting = sample();
  Object.assign(node(starting, 'architecture'), { status: 'running', active: { nonce: 'a', phase: 'work', startedAt: iso(NOW - 3000) } });
  starting.jobs.push({ nonce: 'a', nodeId: 'architecture', state: 'launching', startedAt: iso(NOW - 3000) });
  assert.equal(flowOf(starting, 'brief', 'architecture').state, 'idle', 'a start is not a turn');
  const reserved = sample({ waiting: { architecture: '전체 작업 3개 실행 중' } });
  assert.equal(flowOf(reserved, 'brief', 'architecture').state, 'queue');
  const old = sample();
  working(old, 'architecture');
  old.jobs[0].lastAgentEventAt = NOW - 400_000; // older than the 180 s window and never re-checked by Orca
  assert.equal(flowOf(old, 'brief', 'architecture').state, 'stopped');
  const stale = sample();
  working(stale, 'architecture');
  stale.jobs[0].nonce = 'previous-assignment';
  assert.notEqual(flowOf(stale, 'brief', 'architecture').state, 'live');
});

test('handoff: one parcel the whole way, 720 ms once, on the rail the memory chose', () => {
  const run = sample();
  const flow = edgeFlow({ run, sourceId: 'brief', target: node(run, 'architecture'), sourceView: { pose: 'passed' }, targetView: { pose: 'idle', label: '미배정' }, handoffDelay: 300 });
  assert.deepEqual([flow.state, flow.label, flow.motion, flow.delay, flow.mark], ['handoff', '인계', 'once', 300, 'arrow']);
});

test('queue: a slot or dependency wait at the arrival, with its reason', () => {
  const run = sample({ waiting: { design: '전체 작업 3개 실행 중' } });
  working(run, 'architecture');
  const slot = flowOf(run, 'brief', 'design');
  assert.deepEqual([slot.state, slot.label, slot.mark, slot.motion], ['queue', '대기 · 슬롯 대기', 'queue', 'still']);
  const dep = flowOf(run, 'architecture', 'build');
  assert.deepEqual([dep.state, dep.label], ['queue', '대기 · 선행 대기']);
});

test('idle: unassigned, starting and skipped arrivals rest; a skipped stage says so', () => {
  const run = sample();
  assert.deepEqual([flowOf(run, 'brief', 'architecture').state, flowOf(run, 'brief', 'architecture').label], ['idle', '대기']);
  node(run, 'design').status = 'skipped';
  assert.deepEqual([flowOf(run, 'brief', 'design').state, flowOf(run, 'brief', 'design').label], ['idle', '건너뜀']);
  const before = sample({ started: false, status: 'ready', passed: [] });
  assert.equal(flowOf(before, null, 'research').state, 'idle');
});

// --- priority
test('priority: completed > stopped > live > handoff > queue > idle', () => {
  const run = sample();
  const at = (targetView, extra = {}) => edgeFlow({ run, sourceId: 'brief', target: node(run, 'design'), sourceView: { pose: 'passed' }, targetView, handoffDelay: 100, ...extra }).state;
  assert.equal(at({ pose: 'passed', label: '통과' }), 'complete', 'a passed arrival is done even inside a handoff window');
  assert.equal(at({ pose: 'blocked', label: '확인 필요', tone: 'stop' }), 'stopped', 'a stop closes the handoff window');
  assert.equal(at({ pose: 'work', label: '작업 중', motion: 'loop', phase: 'work' }), 'live', 'an arrival already working keeps flowing');
  assert.equal(at({ pose: 'start', label: '시작 중' }), 'handoff');
  assert.equal(at({ pose: 'queue', label: '슬롯 대기' }), 'queue', 'no parcel moves on a rail with a wait mark');
  assert.equal(at({ pose: 'idle', label: '미배정' }, { handoffDelay: null }), 'idle');
  assert.equal(edgeFlow({ run: { ...run, status: 'completed' }, sourceId: 'brief', target: node(run, 'design'), sourceView: { pose: 'passed' }, targetView: { pose: 'blocked', tone: 'stop', label: 'x' } }).state, 'complete');
});

test('two branches from the same stage each flow; a blocked branch beside them stops alone', () => {
  const run = sample();
  working(run, 'architecture');
  working(run, 'design', { phase: 'review' });
  node(run, 'notify').status = 'blocked';
  const flows = runFlows(run, views(run), { now: NOW });
  const state = (target) => flows.find((flow) => flow.sourceId === 'brief' && flow.targetId === target).state;
  assert.deepEqual(['architecture', 'design', 'notify'].map(state), ['live', 'live', 'stopped']);
  assert.equal(incomingText(flows, 'design', run.nodes), '제품 기획에서 검토 · 공급 중');
  assert.equal(incomingText(flows, 'build', run.nodes), '구조 설계에서 대기 · 선행 대기 · 화면 설계에서 대기 · 선행 대기 · 알림 설계에서 대기 · 선행 대기');
  assert.equal(incomingText(flows, 'research', run.nodes), '시작 포트에서 완료');
});

test('reduced motion or the 공급 모션 끄기 toggle stills the parcels without changing any state or label', () => {
  const run = sample();
  working(run, 'architecture');
  const moving = flowOf(run, 'brief', 'architecture'), still = flowOf(run, 'brief', 'architecture', { still: true });
  assert.deepEqual([still.state, still.label, still.mark], [moving.state, moving.label, moving.mark]);
  assert.equal(moving.motion, 'loop');
  assert.equal(still.motion, 'still');
  const handoff = edgeFlow({ run, sourceId: 'brief', target: node(run, 'design'), sourceView: { pose: 'passed' }, targetView: { pose: 'idle' }, handoffDelay: 0, still: true });
  assert.deepEqual([handoff.state, handoff.motion], ['handoff', 'still']);
});

// --- the handoff memory: fed by pushes only.
test('handoff memory: the first snapshot is a baseline, a new pass opens one window on the first ready successor, and it closes', () => {
  const memory = createHandoffMemory();
  const poseOf = (run, item) => stagePixelOf(run, item, { now: NOW }).pose;
  const before = sample({ passed: ['research'] });
  working(before, 'brief', { phase: 'review' });
  memory.observe([before], { now: NOW, poseOf });
  assert.equal(memory.delay('r1', 'research', 'brief', NOW), null, 'a reload or first read never plays');
  const after = sample(); // brief passed with a new completedAt
  node(after, 'brief').completedAt = iso(NOW - 1000);
  memory.observe([after], { now: NOW, poseOf });
  assert.equal(memory.delay('r1', 'brief', 'architecture', NOW + 200), 200);
  assert.equal(memory.delay('r1', 'brief', 'design', NOW + 200), null, 'one arrival: the first ready successor in run.nodes order');
  assert.equal(memory.until('r1', 'architecture'), NOW + HANDOFF_MS);
  memory.observe([structuredClone(after)], { now: NOW + 300, poseOf });
  assert.equal(memory.delay('r1', 'brief', 'architecture', NOW + 300), 300, 'a duplicate summary does not restart it');
  assert.equal(memory.delay('r1', 'brief', 'architecture', NOW + HANDOFF_MS), null, 'closed after 720 ms');
  assert.equal(memory.until('r1', 'architecture'), null);
});

test('handoff memory: no window while hidden or for a waiting arrival; a reset that passes again plays again', () => {
  const poseOf = (run, item) => stagePixelOf(run, item, { now: NOW }).pose;
  const hidden = createHandoffMemory();
  const before = sample({ passed: ['research'] });
  hidden.observe([before], { now: NOW, poseOf });
  hidden.observe([sample()], { now: NOW, poseOf, open: false });
  assert.equal(hidden.delay('r1', 'brief', 'architecture', NOW), null);
  hidden.observe([sample()], { now: NOW + 100, poseOf });
  assert.equal(hidden.delay('r1', 'brief', 'architecture', NOW + 100), null, 'returning to the tab does not replay it');

  const queued = createHandoffMemory();
  queued.observe([before], { now: NOW, poseOf });
  const waits = sample({ waiting: { architecture: '전체 작업 3개 실행 중', design: '전체 작업 3개 실행 중', notify: '전체 작업 3개 실행 중' } });
  queued.observe([waits], { now: NOW, poseOf });
  for (const target of ['architecture', 'design', 'notify']) assert.equal(queued.delay('r1', 'brief', target, NOW), null);

  const reset = createHandoffMemory();
  reset.observe([sample()], { now: NOW, poseOf });
  reset.observe([sample({ passed: ['research'] })], { now: NOW + 1000, poseOf });
  const again = sample();
  node(again, 'brief').completedAt = iso(NOW + 1500);
  reset.observe([again], { now: NOW + 2000, poseOf });
  assert.equal(reset.delay('r1', 'brief', 'architecture', NOW + 2100), 100);
});
