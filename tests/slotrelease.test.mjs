import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseUncertainJob } from '../src/slotrelease.mjs';
import { globalCounts } from '../src/scheduler.mjs';
import { runOperations } from '../src/operations.mjs';

const AT = '2026-11-24T02:00:00.000Z';
const uncertainRun = (extra = {}) => ({
  id: 'r1', status: 'cancelled', updatedAt: '2026-11-24T01:00:00.000Z',
  nodes: [{ id: 'build', title: '앱 구현', status: 'blocked', active: null, pendingReceipt: { nonce: 'n1' }, launchUncertain: { nonce: 'n1', at: AT, reason: 'timeout' } }],
  jobs: [{ nonce: 'n1', nodeId: 'build', phase: 'work', state: 'uncertain', terminalId: null, startedAt: AT }],
  stopFailures: [{ terminalId: null, code: 'uncertain', message: '응답이 없는 실행 요청이 있습니다.' }],
  events: [], ...extra,
});

test('a person who confirmed no agent runs for an uncertain launch frees its slot; who and when are kept', () => {
  // Arrange
  const run = uncertainRun();
  assert.deepEqual(globalCounts([run]), { active: 1, heavy: 1 });
  // Act
  const { run: next, message } = releaseUncertainJob(run, { nonce: 'n1', confirmed: true, by: 'panel', at: AT });
  // Assert
  assert.deepEqual(globalCounts([next]), { active: 0, heavy: 0 });
  assert.deepEqual(next.jobs[0].released, { by: 'panel', at: AT });
  assert.equal(next.jobs[0].state, 'released');
  assert.deepEqual(next.stopFailures, [], 'nothing unconfirmed is left, so the run can be archived');
  assert.equal(next.nodes[0].pendingReceipt, undefined);
  assert.equal(next.nodes[0].launchUncertain, undefined);
  assert.match(message, /앱 구현.*슬롯을 해제했습니다.*panel/);
  assert.equal(run.jobs[0].state, 'uncertain', 'the input run is not changed');
});

test('only an uncertain assignment without a terminal id, and only with an explicit confirmation, is released', () => {
  // Arrange
  const withTerminal = uncertainRun({ jobs: [{ nonce: 'n1', nodeId: 'build', state: 'uncertain', terminalId: 't-1' }] });
  const running = uncertainRun({ jobs: [{ nonce: 'n1', nodeId: 'build', state: 'running', terminalId: null }] });
  // Act / Assert
  assert.throws(() => releaseUncertainJob(uncertainRun(), { nonce: 'n1', confirmed: false, by: 'panel', at: AT }), (error) => error.code === 'invalid_params' && /확인/.test(error.message));
  assert.throws(() => releaseUncertainJob(uncertainRun(), { nonce: 'n1', confirmed: true, by: '', at: AT }), /누가/);
  assert.throws(() => releaseUncertainJob(withTerminal, { nonce: 'n1', confirmed: true, by: 'panel', at: AT }), (error) => error.code === 'conflict' && /터미널 ID/.test(error.message));
  assert.throws(() => releaseUncertainJob(running, { nonce: 'n1', confirmed: true, by: 'panel', at: AT }), /불명확/);
  assert.equal(releaseUncertainJob(uncertainRun(), { nonce: 'n1', confirmed: true, by: '검토자', at: AT }).run.jobs[0].released.by, '검토자');
  assert.throws(() => releaseUncertainJob(uncertainRun({ jobs: [{ nodeId: 'build', state: 'uncertain', terminalId: null }] }), { confirmed: true, by: 'panel', at: AT }), /배정/);
  assert.throws(() => releaseUncertainJob(uncertainRun(), { nonce: 'missing', confirmed: true, by: 'panel', at: AT }), /찾을 수 없습니다/);
});

test('the operations view offers release only for an uncertain launch without a terminal and drops a released one', () => {
  // Arrange
  const run = uncertainRun({ status: 'blocked' });
  // Act
  const before = runOperations(run);
  const after = runOperations(releaseUncertainJob(run, { nonce: 'n1', confirmed: true, by: 'panel', at: AT }).run);
  // Assert
  assert.equal(before.length, 1);
  assert.equal(before[0].releasable, true);
  assert.equal(before[0].nonce, 'n1');
  assert.deepEqual(after, []);
  assert.equal(runOperations(uncertainRun({ status: 'blocked', jobs: [{ nonce: 'n1', nodeId: 'build', state: 'uncertain', terminalId: 't-1' }] }))[0].releasable, false);
});
