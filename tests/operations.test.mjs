import test from 'node:test';
import assert from 'node:assert/strict';
import { jobCondition, lastProgressAt, runOperations, RESOURCE_MEASUREMENT } from '../src/operations.mjs';
import { cleanupSummary, CLOSE_GRACE_MS } from '../src/cleanup.mjs';
import { projectState } from '../src/views.mjs';

const NOW = Date.parse('2026-11-23T08:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const job = (extra = {}) => ({ nonce: 'n1', nodeId: 'build', phase: 'work', agent: 'codex', attempt: 1, terminalId: 't-1', state: 'running', agentState: 'working', startedAt: iso(NOW - 600_000), selfDelivery: true, promptRecovery: { state: 'sent', at: iso(NOW - 590_000) }, ...extra });

test('an uncertain launch or prompt delivery reads as unclear delivery, not as an error', () => {
  // Arrange
  const launch = job({ state: 'uncertain' });
  const prompt = job({ promptRecovery: { state: 'uncertain', at: iso(NOW) } });
  // Act / Assert
  assert.equal(jobCondition(launch), 'unclear');
  assert.equal(jobCondition(prompt), 'unclear');
});

test('a failed agent turn or a launch that never started reads as an execution error', () => {
  assert.equal(jobCondition(job({ agentState: 'done', agentOutcome: 'failure' })), 'error');
  assert.equal(jobCondition(job({ agentState: 'done', agentOutcome: 'interruption' })), 'error');
  assert.equal(jobCondition(job({ state: 'not-started' })), 'error');
});

test('an agent asking for input or permission reads as waiting for the person', () => {
  assert.equal(jobCondition(job({ agentState: 'waiting' })), 'needs-user');
  assert.equal(jobCondition(job({ agentState: 'blocked' })), 'needs-user');
});

test('a held report, a launch not yet typed into, an idle turn and live work each have their own condition', () => {
  assert.equal(jobCondition(job({ state: 'awaiting-report' })), 'report');
  assert.equal(jobCondition(job({ state: 'launching' })), 'launching');
  assert.equal(jobCondition(job({ promptRecovery: undefined })), 'launching');
  assert.equal(jobCondition(job({ agentState: 'done' })), 'idle');
  assert.equal(jobCondition(job({ agentState: 'working' })), 'working');
});

test('a typed job with no agent state yet reads as unknown, not as working', () => {
  assert.equal(jobCondition(job({ agentState: undefined })), 'unknown');
});

test('a stage whose current job record is missing is still listed, as unclear', () => {
  // Arrange
  const run = { id: 'r1', nodes: [{ id: 'build', active: { nonce: 'gone', phase: 'work' } }], jobs: [] };
  // Act
  const [item] = runOperations(run);
  // Assert
  assert.equal(item.nodeId, 'build');
  assert.equal(item.condition, 'unclear');
  assert.equal(item.lastProgressAt, null);
});

test('last progress is the newest recorded moment of the job, never invented', () => {
  // Arrange
  const moved = job({ lastAgentEventAt: NOW - 30_000 });
  // Act / Assert
  assert.equal(lastProgressAt(moved), iso(NOW - 30_000));
  assert.equal(lastProgressAt(job()), iso(NOW - 590_000));
  assert.equal(lastProgressAt({ startedAt: 'not a date' }), null);
});

test('run operations list only the current job of each stage with phase, agent, condition and last progress', () => {
  // Arrange
  const run = {
    id: 'r1', nodes: [{ id: 'build', active: { nonce: 'n1' } }, { id: 'test', pendingReceipt: { nonce: 'n2' } }, { id: 'design', active: null }],
    jobs: [job(), job({ nonce: 'n2', nodeId: 'test', phase: 'review', state: 'awaiting-report' }), job({ nonce: 'old', state: 'superseded' })]
  };
  // Act
  const list = runOperations(run);
  // Assert
  assert.deepEqual(list.map((item) => [item.nodeId, item.phase, item.condition]), [['build', 'work', 'working'], ['test', 'review', 'report']]);
  assert.equal(list[0].agent, 'codex');
  assert.equal(list[0].lastProgressAt, iso(NOW - 590_000));
});

test('a cancelled run still shows a reserved job whose terminal closure is unconfirmed', () => {
  const run = { id: 'r1', status: 'cancelled', nodes: [{ id: 'build', active: null }], jobs: [job()] };

  const list = runOperations(run);

  assert.deepEqual(list.map((item) => [item.nodeId, item.condition, item.terminalId]), [['build', 'unclear', 't-1']]);
});

test('CPU and memory are reported as not measured, with the reason, never as zero', () => {
  assert.equal(RESOURCE_MEASUREMENT.measured, false);
  assert.match(RESOURCE_MEASUREMENT.reason, /프로세스 ID/);
  assert.equal('cpu' in RESOURCE_MEASUREMENT, false);
});

test('cleanup summary counts finished terminals still waiting to be closed', () => {
  // Arrange: one finished and waiting, one just finished (inside grace), one kept, one closed
  const finished = (nonce, extra = {}) => ({ nonce, nodeId: 'build', terminalId: 't-' + nonce, state: 'complete', completedAt: iso(NOW - CLOSE_GRACE_MS - 1000), ...extra });
  const run = { id: 'r', autonomous: true, nodes: [], jobs: [finished('a'), finished('b', { completedAt: iso(Date.now()) }), finished('c', { terminalKept: { state: 'working' } }), finished('d', { terminalClosed: { at: iso(NOW) } })] };
  // Act
  const summary = cleanupSummary(run);
  // Assert
  assert.equal(summary.pending, 2);
  assert.equal(summary.closed, 1);
  assert.equal(cleanupSummary({ ...run, autonomous: false, jobs: [finished('a')] }), null, 'nothing pends when auto close is off');
});

test('the summary view carries each run\'s operations and the resource measurement scope', () => {
  // Arrange
  const state = { version: 1, revision: 3, runs: [{ id: 'r1', goal: 'g', status: 'running', nodes: [{ id: 'build', deps: [], status: 'pending', active: { nonce: 'n1' } }], jobs: [job()], events: [] }], archivedRuns: [] };
  // Act
  const view = projectState(state, 'summary');
  // Assert
  assert.equal(view.runs[0].operations[0].condition, 'working');
  assert.deepEqual(view.resources, RESOURCE_MEASUREMENT);
});
