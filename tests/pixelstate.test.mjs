import test from 'node:test';
import assert from 'node:assert/strict';
import {
  stagePixel, stagePixelOf, runPixel, createMotionMemory, msOf,
  START_SLOW_MS, QUIET_MS, DELIVERY_ATTEMPTS, AUTONOMY_STAGE_RETRIES, ONCE_WINDOW_MS, QUIET_TOOLTIP,
} from '../panel/pixelstate.mjs';

const NOW = Date.parse('2026-11-28T03:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const node = (extra = {}) => ({ id: 'design', title: '화면 설계', deps: [], status: 'pending', attempts: 0, reviewAttempts: 0, active: null, ...extra });
const run = (extra = {}) => ({ id: 'r1', status: 'running', started: true, maxConcurrency: 2, nodes: [], jobs: [], waiting: {}, operations: [], ...extra });
const active = (startedAt, extra = {}) => ({ nonce: 'n1', phase: 'work', startedAt: iso(startedAt), ...extra });
// A job whose prompt was sent and whose agent proved a turn in its own session.
const working = (eventAt, extra = {}) => ({ nonce: 'n1', state: 'running', selfDelivery: true, startedAt: iso(NOW - 600_000),
  promptRecovery: { state: 'sent', at: iso(NOW - 590_000) }, promptSeen: true, sessionId: 's1', agentState: 'working', lastAgentEventAt: eventAt, ...extra });
const view = (input) => stagePixel({ run: run(), now: NOW, ...input });

// --- 상태표, one row each, top to bottom.
test('실행 완료: a completed run shows the trophy on the run, stages keep passed', () => {
  const nodes = [node({ status: 'passed' }), node({ id: 'assets', status: 'skipped' })];
  const item = run({ status: 'completed', nodes });
  assert.equal(runPixel(item, [], { now: NOW }).pose, 'completed');
  assert.equal(runPixel(item, [], { now: NOW }).headline, '실행 완료');
  assert.equal(stagePixel({ run: item, node: nodes[0], now: NOW }).pose, 'passed');
});

test('취소: requested, done, unsaved and unconfirmed stops are told apart; unfinished stages show cancelled', () => {
  assert.equal(runPixel(run(), [], { now: NOW, cancelling: true }).headline, '취소 요청 처리 중');
  assert.deepEqual(['pose', 'headline'].map((key) => runPixel(run({ status: 'cancelled' }), [], { now: NOW })[key]), ['cancelled', '취소 완료']);
  assert.equal(runPixel(run({ status: 'cancelled', cancelUnsaved: true, stopFailures: [{}] }), [], { now: NOW }).headline, '취소 저장 대기');
  const unconfirmed = runPixel(run({ status: 'cancelled', stopFailures: [{ terminalId: 't' }] }), [], { now: NOW });
  assert.deepEqual([unconfirmed.pose, unconfirmed.headline, unconfirmed.person], ['blocked', '종료 확인 필요', true]);
  assert.equal(view({ run: run({ status: 'cancelled' }), node: node({ status: 'blocked' }) }).pose, 'cancelled');
  assert.equal(view({ run: run({ status: 'cancelled' }), node: node({ status: 'passed' }) }).pose, 'passed');
});

test('통과 and 건너뜀 are still poses', () => {
  assert.deepEqual([view({ node: node({ status: 'passed' }) })].map((v) => [v.pose, v.label, v.motion]), [['passed', '통과', 'still']]);
  assert.deepEqual([view({ node: node({ status: 'skipped' }) })].map((v) => [v.pose, v.label]), [['skipped', '건너뜀']]);
});

test('확인 필요 · 시작 여부 불명: launchUncertain, an uncertain job or delivery, or an unclear operation', () => {
  const item = node({ status: 'blocked', pendingReceipt: { nonce: 'n1' } });
  for (const input of [{ node: { ...item, launchUncertain: { nonce: 'n1' } }, job: { nonce: 'n1', state: 'awaiting-report' } },
    { node: item, job: { nonce: 'n1', state: 'uncertain' } },
    { node: item, job: { nonce: 'n1', state: 'running', promptRecovery: { state: 'uncertain' } } },
    { node: item, job: { nonce: 'n1', state: 'running' }, operation: { nonce: 'n1', condition: 'unclear' } }]) {
    const result = view(input);
    assert.equal(result.pose, 'blocked');
    assert.equal(result.label, '확인 필요 · 시작 여부 불명');
    assert.equal(result.person, true);
  }
  const ended = view({ node: item, job: working(NOW - 1000, { state: 'uncertain' }) });
  assert.equal(ended.label, '확인 필요 · 작업 신호 종료 불명');
});

test('멈춤 · 시작 화면 / 로그인 필요 / 사용 한도 come from job.blocker; a start dialog names the dialog', () => {
  const item = node({ status: 'blocked', pendingReceipt: { nonce: 'n1' }, runtimeMessage: 'Claude 설정의 CLAUDE_CODE_EXPERIMENTAL_CODE_MODE를 끄거나, Claude Code를 직접 열어 안내를 확인하세요' });
  const dialog = view({ node: item, job: { nonce: 'n1', state: 'awaiting-report', blocker: { kind: 'start-dialog', agent: 'claude', dialog: 'code-mode' } } });
  assert.deepEqual([dialog.pose, dialog.label, dialog.tone, dialog.person], ['blocked', '멈춤 · 시작 화면', 'stop', true]);
  assert.match(dialog.detail, /claude · Code Mode 안내/);
  assert.match(dialog.reason, /CLAUDE_CODE_EXPERIMENTAL_CODE_MODE를 끄거나/);
  assert.equal(view({ node: item, job: { nonce: 'n1', blocker: { kind: 'hook-review', agent: 'codex' } } }).label, '멈춤 · 시작 화면');
  assert.equal(view({ node: item, job: { nonce: 'n1', blocker: { kind: 'login', agent: 'codex' } } }).label, '로그인 필요');
  assert.equal(view({ node: item, job: { nonce: 'n1', blocker: { kind: 'usage-limit', agent: 'codex' } } }).label, '사용 한도');
});

test('멈춤 · 시작 준비 실패 · 3/3 after three unready starts; a rejected delivery is 확인 필요', () => {
  const failed = view({ node: node({ status: 'blocked', deliveryRetries: DELIVERY_ATTEMPTS }) });
  assert.deepEqual([failed.pose, failed.label], ['blocked', '멈춤 · 시작 준비 실패 · 3/3']);
  const rejected = view({ node: node({ status: 'blocked', pendingReceipt: { nonce: 'n1' } }), job: { nonce: 'n1', state: 'awaiting-report', promptRecovery: { state: 'rejected' } } });
  assert.deepEqual([rejected.pose, rejected.label], ['blocked', '확인 필요']);
});

test('실패: a failed stage, an agent error waiting to be handled, an unexplained operation error', () => {
  assert.deepEqual([view({ node: node({ status: 'failed' }) })].map((v) => [v.pose, v.label, v.person]), [['failed', '실패', true]]);
  const errorTurn = view({ node: node({ status: 'running', active: active(NOW - 60_000) }), job: working(NOW - 5000, { agentOutcome: 'failure', agentState: 'done' }) });
  assert.deepEqual([errorTurn.pose, errorTurn.label, errorTurn.person], ['failed', '에이전트 오류 · 처리 대기', false]);
  const unexplained = view({ node: node({ status: 'running', active: active(NOW - 60_000) }), job: { nonce: 'n1', state: 'not-started' }, operation: { nonce: 'n1', condition: 'error' } });
  assert.equal(unexplained.label, '배정 확인 필요');
});

test('확인 필요 · 승인 대기, 터미널 응답 and 응답 대기 share the raised hand', () => {
  assert.equal(view({ node: node({ status: 'awaiting-approval' }) }).label, '확인 필요 · 승인 대기');
  assert.equal(view({ node: node(), waiting: '승인 대기' }).pose, 'approval');
  const running = node({ status: 'running', active: active(NOW - 60_000) });
  assert.equal(view({ node: running, job: working(NOW - 1000, { agentState: 'blocked' }) }).label, '확인 필요 · 터미널 응답');
  assert.equal(view({ node: running, job: working(NOW - 1000, { agentState: 'waiting' }) }).label, '응답 대기');
});

test('시작 지연 · 재시도 2/3 while a relaunch is checked, 재배정 대기 without one; the slot wait stays visible', () => {
  const launching = view({ node: node({ status: 'running', deliveryRetries: 2, active: active(NOW - 5000) }), job: { nonce: 'n1', state: 'running', selfDelivery: true, startedAt: iso(NOW - 5000) } });
  assert.deepEqual([launching.pose, launching.label, launching.motion, launching.retryKind, launching.retryCount], ['retry', '시작 지연 · 재시도 2/3', 'once', 'delivery', 2]);
  assert.match(launching.detail, /준비 실패 2회 · 세 번째 시작 확인 중/);
  const waiting = view({ node: node({ deliveryRetries: 1 }), waiting: '전체 작업 2개 실행 중' });
  assert.equal(waiting.label, '시작 지연 · 재시도 1/3');
  assert.match(waiting.detail, /재배정 대기 · 전체 작업 2개 실행 중/);
});

test('자율 재시도 n/3 while the new assignment is not yet confirmed; confirmed work wins', () => {
  const pending = view({ node: node(), autonomyRetry: 2, waiting: '배정 순서 대기' });
  assert.deepEqual([pending.pose, pending.label, pending.retryKind], ['retry', '자율 재시도 2/' + AUTONOMY_STAGE_RETRIES, 'autonomy']);
  const confirmed = view({ node: node({ status: 'running', active: active(NOW - 60_000) }), job: working(NOW - 1000), autonomyRetry: 2 });
  assert.equal(confirmed.pose, 'work');
});

test('시작 중 for under 15 s, then 시작 신호 대기; without a start time 시작 시각 미확인', () => {
  const job = (startedAt) => ({ nonce: 'n1', state: 'running', selfDelivery: true, startedAt: iso(startedAt) });
  const fresh = view({ node: node({ status: 'running', active: active(NOW - 4000) }), job: job(NOW - 4000) });
  assert.deepEqual([fresh.pose, fresh.label, fresh.motion, fresh.until], ['start', '시작 중', 'once', NOW - 4000 + START_SLOW_MS]);
  const slow = view({ node: node({ status: 'running', active: active(NOW - START_SLOW_MS) }), job: job(NOW - START_SLOW_MS) });
  assert.deepEqual([slow.pose, slow.label, slow.detail, slow.motion], ['start-slow', '시작 신호 대기', '준비 신호 대기', 'still']);
  const sent = view({ node: node({ status: 'running', active: active(NOW - 30_000) }), job: { ...job(NOW - 30_000), promptRecovery: { state: 'sent', at: iso(NOW - 20_000) } } });
  assert.equal(sent.detail, '작업 시작 확인 대기');
  const timeless = view({ node: node({ status: 'running', active: { nonce: 'n1', phase: 'work' } }), job: { nonce: 'n1', state: 'launching' } });
  assert.deepEqual([timeless.pose, timeless.label], ['start-slow', '시작 시각 미확인']);
});

test('보고서 확인 대기 and 턴 종료 · 보고서 대기', () => {
  const running = node({ status: 'running', active: active(NOW - 60_000) });
  assert.equal(view({ node: running, job: working(NOW - 1000), operation: { nonce: 'n1', condition: 'report' } }).label, '보고서 확인 대기');
  const ended = view({ node: running, job: working(NOW - 1000, { agentState: 'done' }) });
  assert.deepEqual([ended.pose, ended.label], ['report', '턴 종료 · 보고서 대기']);
});

test('작업 중 and 검토 중 loop only on a proven, recent work signal', () => {
  const work = view({ node: node({ status: 'running', active: active(NOW - 60_000) }), job: working(NOW - 10_000) });
  assert.deepEqual([work.pose, work.label, work.motion, work.tone, work.until], ['work', '작업 중', 'loop', 'good', NOW - 10_000 + QUIET_MS]);
  const review = view({ node: node({ status: 'review', active: active(NOW - 60_000, { phase: 'review' }) }), job: working(NOW - 10_000) });
  assert.deepEqual([review.pose, review.label, review.motion, review.phase], ['review', '검토 중', 'loop', 'review']);
});

test('x분째 조용함 from 180 s without a signal, rounded down, review keeps its role', () => {
  const quiet = view({ node: node({ status: 'running', active: active(NOW - 600_000) }), job: working(NOW - 4 * 60_000 - 30_000) });
  assert.deepEqual([quiet.pose, quiet.label, quiet.motion, quiet.tooltip], ['quiet', '4분째 조용함', 'still', QUIET_TOOLTIP]);
  const edge = view({ node: node({ status: 'running', active: active(NOW - 600_000) }), job: working(NOW - QUIET_MS) });
  assert.equal(edge.label, '3분째 조용함');
  const justBefore = view({ node: node({ status: 'running', active: active(NOW - 600_000) }), job: working(NOW - QUIET_MS + 1) });
  assert.equal(justBefore.pose, 'work');
  const review = view({ node: node({ status: 'review', active: active(NOW - 600_000, { phase: 'review' }) }), job: working(NOW - QUIET_MS) });
  assert.equal(review.label, '검토 · 3분째 조용함');
});

test('작업 신호 미확인: an assignment whose job is missing, or a legacy job with no session or time', () => {
  assert.deepEqual([view({ node: node({ status: 'running', active: active(NOW - 60_000) }) })].map((v) => [v.pose, v.label, v.detail]), [['unknown', '작업 신호 미확인', '기록 없음']]);
  const legacy = view({ node: node({ status: 'running', active: active(NOW - 60_000) }), job: { nonce: 'n1', state: 'running', promptSeen: true, agentState: 'working' } });
  assert.equal(legacy.pose, 'unknown');
});

test('새 배정 멈춤, 선행 대기, 슬롯/차례 대기 with real numbers, 검토 배정 대기, 시작 전 and 미배정', () => {
  assert.equal(view({ run: run({ status: 'paused' }), node: node() }).pose, 'paused');
  const deps = [node({ id: 'brief', title: '제품 기획', status: 'running' })];
  const dependency = stagePixel({ run: run({ nodes: deps }), node: node({ deps: ['brief'] }), waiting: '선행 단계 대기', now: NOW });
  assert.deepEqual([dependency.pose, dependency.label], ['dependency', '선행 대기']);
  assert.match(dependency.tooltip, /제품 기획/);
  assert.equal(view({ node: node(), waiting: '확인이 필요한 단계 처리 대기' }).label, '다른 단계 확인 대기');
  const slot = view({ node: node(), waiting: '전체 작업 2개 실행 중', limits: { active: 2, activeJobs: 2 } });
  assert.deepEqual([slot.pose, slot.label, slot.detail], ['queue', '슬롯 대기', '전체 2/2']);
  assert.equal(view({ node: node(), waiting: '배정 순서 대기' }).label, '차례 대기');
  assert.equal(view({ node: node({ status: 'review' }) }).label, '검토 배정 대기');
  assert.deepEqual([view({ run: run({ started: false }), node: node() })].map((v) => [v.pose, v.label]), [['idle', '시작 전']]);
  assert.equal(view({ node: node() }).label, '미배정');
});

// --- Precedence rules.
test('a blocker beats a terminal wait and uncertainty, and says the stop still needs checking', () => {
  const result = view({ node: node({ status: 'blocked', pendingReceipt: { nonce: 'n1' }, launchUncertain: { nonce: 'n1' } }),
    job: working(NOW - 1000, { state: 'uncertain', agentState: 'waiting', blocker: { kind: 'hook-review', agent: 'codex' } }) });
  assert.equal(result.label, '멈춤 · 시작 화면');
  assert.match(result.detail, /종료 확인 필요/);
});

test('a stale event never animates: an event older than the assignment or the send is no proof of work', () => {
  const before = view({ node: node({ status: 'running', active: active(NOW - 30_000) }), job: working(NOW - 40_000, { startedAt: iso(NOW - 30_000), promptRecovery: { state: 'sent', at: iso(NOW - 25_000) } }) });
  assert.notEqual(before.motion, 'loop');
  assert.equal(before.pose, 'start-slow');
});

test('promptSeen alone is not proof of work: a modal can raise it before any turn', () => {
  const result = view({ node: node({ status: 'running', active: active(NOW - 5000) }), job: { nonce: 'n1', state: 'running', selfDelivery: true, startedAt: iso(NOW - 5000), promptSeen: true, agentState: 'working', lastAgentEventAt: NOW - 1000 } });
  assert.equal(result.pose, 'start');
  assert.notEqual(result.motion, 'loop');
  // Sent and seen, but no session yet: still waiting for the turn to be confirmed.
  const noSession = view({ node: node({ status: 'running', active: active(NOW - 60_000) }), job: working(NOW - 1000, { sessionId: undefined }) });
  assert.deepEqual([noSession.pose, noSession.detail], ['start-slow', '작업 시작 확인 대기']);
});

test('times are read from ms numbers and ISO strings; anything else is no time', () => {
  assert.equal(msOf(NOW), NOW);
  assert.equal(msOf(iso(NOW)), NOW);
  for (const value of [0, -5, 'soon', null, undefined, NaN, {}]) assert.equal(msOf(value), null);
});

test('stagePixelOf links the current job, operation and wait by the assignment nonce', () => {
  const item = run({ nodes: [node({ status: 'running', active: active(NOW - 60_000, { nonce: 'n2' }) })],
    jobs: [working(NOW - 1000, { nonce: 'old', agentState: 'done' }), working(NOW - 1000, { nonce: 'n2' })],
    operations: [{ nonce: 'old', condition: 'report' }, { nonce: 'n2', condition: 'working', lastProgressAt: iso(NOW - 1000) }] });
  const result = stagePixelOf(item, item.nodes[0], { now: NOW });
  assert.equal(result.pose, 'work');
  assert.equal(result.activityAt, NOW - 1000);
});

// --- The run header.
const header = (item, extra = {}) => runPixel(item, item.nodes.map((entry) => ({ node: entry, view: stagePixelOf(item, entry, { now: NOW }) })), { now: NOW, ...extra });

test('the run header puts the most urgent cause first and still counts work in progress', () => {
  const nodes = [node({ id: 'architecture', title: '구조 설계', status: 'running', active: active(NOW - 78_000, { nonce: 'a' }) }),
    node({ id: 'design', status: 'blocked', pendingReceipt: { nonce: 'b' } })];
  const result = header(run({ nodes, jobs: [working(NOW - 2000, { nonce: 'a' }), { nonce: 'b', state: 'awaiting-report', blocker: { kind: 'start-dialog', agent: 'claude', dialog: 'code-mode' } }] }));
  assert.equal(result.headline, '화면 설계 · 멈춤 · 시작 화면');
  assert.match(result.detail, /작업 1개 계속/);
  assert.equal(result.person, true);
  assert.equal(result.nodeId, 'design');
});

test('two confirmed agents in parallel are summarised, timed from the oldest assignment', () => {
  const nodes = [node({ id: 'architecture', title: '구조 설계', status: 'running', active: active(NOW - 24_000, { nonce: 'a' }) }),
    node({ id: 'design', title: '화면 설계', status: 'running', active: active(NOW - 20_000, { nonce: 'b' }) })];
  const result = header(run({ nodes, jobs: [working(NOW - 8000, { nonce: 'a' }), working(NOW - 9000, { nonce: 'b' })] }));
  assert.equal(result.headline, '구조·화면 설계 · 2개 작업 중');
  assert.equal(result.detail, '두 작업 신호 확인됨');
  assert.equal(result.startedAt, NOW - 24_000);
  assert.equal(result.motion, 'loop');
});

test('a paused run with work still going says so', () => {
  const nodes = [node({ status: 'running', active: active(NOW - 60_000) }), node({ id: 'assets', title: '앱 에셋' })];
  assert.equal(header(run({ status: 'paused', nodes, jobs: [working(NOW - 1000)] })).headline, '새 배정 멈춤 · 작업 1개 계속');
});

test('a header without an assignment says 경과 미확인 through a null start', () => {
  assert.equal(header(run({ nodes: [node()] })).startedAt, null);
});

// --- One-shot motion.
test('a one-shot pose plays once per real change: never on the first observation, a re-render or a return', () => {
  const memory = createMotionMemory();
  memory.observe('r1:design:nonce', 'n1', NOW); // first push after opening the panel
  assert.equal(memory.delay('r1:design:nonce', NOW), null);
  memory.observe('r1:design:nonce', 'n2', NOW + 100); // a new assignment
  assert.equal(memory.delay('r1:design:nonce', NOW + 100), 0);
  memory.observe('r1:design:nonce', 'n2', NOW + 400); // the same nonce pushed again
  assert.equal(memory.delay('r1:design:nonce', NOW + 400), 300, 'a re-render joins the motion where it is');
  assert.equal(memory.delay('r1:design:nonce', NOW + 100 + ONCE_WINDOW_MS), null, 'after the window, a re-render or tab return is still');
});

test('a delivery counter knocks only when it increases; a reset is silent', () => {
  const memory = createMotionMemory();
  memory.observe('k', 0, NOW);
  memory.observe('k', 1, NOW + 10);
  assert.equal(memory.delay('k', NOW + 10), 0);
  memory.observe('k', 0, NOW + 20);
  assert.equal(memory.delay('k', NOW + 20), null);
  assert.equal(memory.raised('k'), null);
});

test('an autonomy counter is raised only against a comparable earlier push and stays raised until it changes', () => {
  const memory = createMotionMemory();
  memory.observe('a', 2, NOW);
  assert.equal(memory.raised('a'), null, 'a cumulative count alone never replays an old retry');
  memory.observe('a', 3, NOW + 5);
  assert.equal(memory.raised('a'), 3);
  memory.observe('a', 3, NOW + 60_000);
  assert.equal(memory.raised('a'), 3);
});
