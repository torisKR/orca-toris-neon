import test from 'node:test';
import assert from 'node:assert/strict';
import { planAutonomy, AUTONOMY_LIMITS, AUTONOMY_BRIEF, DECIDE_PROMPT, otherAgent } from '../src/autonomy.mjs';

const node = (id, extra = {}) => ({ id, title: id, deps: [], agent: 'claude', reviewer: 'codex', status: 'pending', attempts: 1, reviewAttempts: 0, active: null, history: [], ...extra });
const run = (nodes, extra = {}) => ({ id: 'r', autonomous: true, status: 'blocked', nodes, jobs: [], repairLoops: 0, maxRepairLoops: 3, maxAttempts: 3, autonomy: {}, ...extra });
const types = (actions) => actions.map((action) => action.type + ':' + (action.nodeId ?? ''));

test('the limits are explicit, bounded and cover stage, run, agent switch, decision nudges and repair loops', () => {
  assert.deepEqual(AUTONOMY_LIMITS, { retriesPerStage: 3, retriesPerRun: 12, switchAgentAfter: 2, decisionNudgesPerJob: 2, extraRepairLoopsPerRun: 3 });
  assert.match(AUTONOMY_BRIEF, /사람이 없습니다/);
  assert.match(DECIDE_PROMPT, /스스로/);
  assert.deepEqual([otherAgent('claude'), otherAgent('codex'), otherAgent('gemini')], ['codex', 'claude', null]);
});

test('manual runs and paused runs are left to the person', () => {
  assert.deepEqual(planAutonomy(run([node('build', { status: 'failed' })], { autonomous: false })), []);
  assert.deepEqual(planAutonomy(run([node('build', { status: 'failed' })], { status: 'paused' })), []);
});

test('a failed or blocked stage gets a fresh attempt carrying the failure; repeated failures switch claude and codex', () => {
  const failed = node('build', { status: 'failed', failureReason: '검토 실패: 저장 버튼이 반응하지 않음' });
  const [retry] = planAutonomy(run([failed]));
  assert.deepEqual([retry.type, retry.nodeId, retry.switchTo], ['retry', 'build', null]);
  assert.match(retry.reason, /저장 버튼/);
  const [switched] = planAutonomy(run([failed], { autonomy: { retries: { build: 2 }, total: 2, streak: { build: { agent: 'claude', count: 2 } } } }));
  assert.deepEqual([switched.switchTo, switched.field], ['codex', 'agent']);
  const review = node('build', { status: 'blocked', blockedPhase: 'review', reviewer: 'codex', report: { outcome: 'passed' }, pendingReceipt: { nonce: 'j' } });
  const [reviewRetry] = planAutonomy(run([review], { autonomy: { streak: { build: { agent: 'codex', count: 2, field: 'reviewer' } } } }));
  assert.deepEqual([reviewRetry.field, reviewRetry.switchTo], ['reviewer', 'claude']);
});

test('an exhausted QA repair loop is reopened within its own bound', () => {
  const test = node('test', { status: 'failed', failureReason: '테스트 실패 · 테스트 수정 루프 또는 단계별 실행 한도에 도달했습니다.' });
  const [action] = planAutonomy(run([test], { repairLoops: 3 }));
  assert.equal(action.extendRepairLoop, true);
  const [stop] = planAutonomy(run([test], { repairLoops: 3, autonomy: { extraRepairLoops: 3 } }));
  assert.equal(stop.type, 'stop');
  assert.match(stop.reason, /수정 루프/);
});

test('the stage and run limits stop the run with one summary of what was tried', () => {
  const failed = node('build', { status: 'failed' });
  const [stage] = planAutonomy(run([failed], { autonomy: { retries: { build: 3 }, total: 3, tried: ['build: claude 재시도', 'build: codex로 전환'] } }));
  assert.deepEqual([stage.type, stage.notify], ['stop', true]);
  assert.match(stage.reason, /3번/);
  assert.match(stage.reason, /codex로 전환/);
  const [runLimit] = planAutonomy(run([node('test', { status: 'failed' })], { autonomy: { total: 12 } }));
  assert.match(runLimit.reason, /12번/);
});

test('what the plugin must not decide stays stopped with a notification', () => {
  const uncertain = node('build', { status: 'blocked', launchUncertain: { nonce: 'j' }, pendingReceipt: { nonce: 'j' } });
  const reported = node('policy', { status: 'blocked', failureReason: '서비스 계정 키가 필요합니다', history: [{ outcome: 'blocked' }] });
  const rejected = node('design', { status: 'blocked', pendingReceipt: { nonce: 'k' } });
  const actions = planAutonomy(run([uncertain, reported, rejected], { jobs: [{ nonce: 'k', promptRecovery: { state: 'rejected' } }] }));
  assert.deepEqual(types(actions), ['stop:build', 'stop:policy', 'stop:design']);
  assert.ok(actions.every((action) => action.notify && action.key));
  assert.match(actions[1].reason, /서비스 계정 키/);
});

test('internal gates are approved for preparation only on the evidence of passed reviews; submission is never planned', () => {
  const policy = node('listing', { status: 'passed', review: { outcome: 'passed', summary: '스토어 자료 검토 통과' } });
  const gate = node('internal', { status: 'awaiting-approval', deps: ['listing'], requiresApproval: true });
  const [approve] = planAutonomy(run([policy, gate], { status: 'ready' }));
  assert.deepEqual([approve.type, approve.nodeId], ['approve', 'internal']);
  assert.match(approve.note, /listing/);
  assert.match(approve.note, /제출은 포함하지 않/);
  assert.equal(Object.hasOwn(approve, 'submission'), false);
});

test('a completed run is announced once, naming the submission that waits for the person', () => {
  const done = run([node('release', { status: 'passed', approval: { note: 'auto' } })], { status: 'completed' });
  const [complete] = planAutonomy(done);
  assert.equal(complete.type, 'complete');
  assert.match(complete.body, /제출/);
  assert.deepEqual(planAutonomy({ ...done, autonomy: { notified: ['completed'] } }), []);
});

test('an autonomous update run stops at the product catalog with one notice instead of approving it', () => {
  const catalog = node('catalog', { status: 'awaiting-approval', requiresApproval: true, humanApproval: true, deps: ['listing'] });
  const monetization = node('monetization', { status: 'passed', report: { outcome: 'passed', products: [{ productId: 'premium_unlock', type: 'inapp', price: '₩3,900' }] } });
  const r = run([monetization, node('listing', { status: 'passed' }), catalog, node('internal', { deps: ['listing', 'catalog'], requiresApproval: true })],
    { status: 'ready', template: 'improve' });
  const actions = planAutonomy(r);
  assert.deepEqual(types(actions), ['stop:catalog']);
  assert.equal(actions[0].notify, true);
  assert.match(actions[0].reason, /premium_unlock/);
  assert.match(actions[0].reason, /Play Console/);
  // A preparation gate next to it is still approved by autonomy; the human gate never is.
  const prep = node('internal', { status: 'awaiting-approval', requiresApproval: true });
  assert.deepEqual(types(planAutonomy(run([prep], { status: 'ready' }))), ['approve:internal']);
});

test('an external condition is never retried; autonomy stops and says what is needed', () => {
  const held = node('test', { status: 'blocked', failureReason: '연결된 Android 기기가 없습니다', history: [{ outcome: 'failed', failureClass: 'external' }] });
  const [action] = planAutonomy(run([held]));
  assert.equal(action.type, 'stop');
  assert.match(action.reason, /기기/);
});
