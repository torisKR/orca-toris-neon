/** The summary push carries what the pixel workshop reads (panel/pixelstate.mjs), and stays small. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, claimNode } from '../src/engine.mjs';
import { projectState } from '../src/views.mjs';
import { stagePixelOf } from '../panel/pixelstate.mjs';

const NOW = Date.parse('2026-11-28T03:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const ORCA_PANEL_MESSAGE_BYTES = 256 * 1024; // Orca drops panel messages over 256 KiB (src/views.mjs)
// Ten live runs with parallel work. A fresh run's summary is ~6.6 KB (launchPlan ~2.4 KB), so the
// 40 runs src/runtime.mjs keeps would not fit today; that limit predates this bundle.
const BUSY_DAY_RUNS = 10;

function liveRun(index) {
  let run = createRun({ id: 'run-' + index, goal: '샘플 앱 ' + index + ' · 하루 루틴', projectId: 'p1', now: NOW - 3_600_000 });
  Object.assign(run, { started: true, status: 'running', workspaceId: 'w' + index, workspacePath: '/example/w' + index, autonomous: true, autonomy: { retries: { design: 1 }, total: 1 } });
  for (const id of ['research', 'brief']) Object.assign(run.nodes.find((node) => node.id === id), { status: 'passed', attempts: 1, reviewAttempts: 1 });
  run = claimNode(run, 'architecture', { phase: 'work', nonce: 'a-' + index, now: NOW - 60_000 });
  run = claimNode(run, 'design', { phase: 'work', nonce: 'd-' + index, now: NOW - 20_000 });
  run.nodes.find((node) => node.id === 'design').deliveryRetries = 2;
  run.jobs = [
    { runId: run.id, nodeId: 'architecture', nonce: 'a-' + index, phase: 'work', attempt: 1, agent: 'codex', state: 'running', selfDelivery: true, terminalId: 't-a',
      startedAt: iso(NOW - 60_000), promptRecovery: { state: 'sent', at: iso(NOW - 50_000), terminalId: 't-a', acceptedAt: iso(NOW - 50_000) },
      promptSeen: true, sessionId: 'session-a', agentState: 'working', lastAgentEventAt: NOW - 5_000 },
    { runId: run.id, nodeId: 'design', nonce: 'd-' + index, phase: 'work', attempt: 1, agent: 'claude', state: 'awaiting-report', selfDelivery: true, terminalId: 't-d',
      startedAt: iso(NOW - 20_000), blocker: { kind: 'start-dialog', agent: 'claude', dialog: 'code-mode' } },
    ...Array.from({ length: 30 }, (_, n) => ({ nodeId: 'research', nonce: 'old-' + index + '-' + n, state: 'complete', sessionId: 's', receiptPath: '/example/' + n })),
  ];
  run.events = Array.from({ length: 200 }, (_, n) => ({ id: 'e' + n, at: iso(NOW - n * 1000), type: 'runtime', summary: '샘플 이벤트 '.repeat(8) }));
  return run;
}
const state = (count) => ({ version: 2, revision: 7, runs: Array.from({ length: count }, (_, index) => liveRun(index)), archivedRuns: [] });

test('the summary keeps every field the pixel states read: job signals, blocker, counters, operations, waits and limits', () => {
  // Arrange / Act
  const summary = projectState(state(1), 'summary');
  const run = summary.runs[0];
  const work = run.jobs.find((job) => job.nodeId === 'architecture');
  const stuck = run.jobs.find((job) => job.nodeId === 'design');
  // Assert
  for (const field of ['agentState', 'lastAgentEventAt', 'sessionId', 'promptSeen', 'selfDelivery', 'startedAt']) assert.ok(field in work, field);
  assert.equal(work.promptRecovery.state, 'sent');
  assert.deepEqual(stuck.blocker, { kind: 'start-dialog', agent: 'claude', dialog: 'code-mode' });
  assert.equal(run.nodes.find((node) => node.id === 'design').deliveryRetries, 2);
  assert.equal(run.autonomy.retries.design, 1);
  assert.ok(run.operations.every((operation) => 'condition' in operation && 'lastProgressAt' in operation && operation.nonce));
  assert.equal(typeof run.waiting, 'object');
  for (const field of ['active', 'activeJobs', 'heavy', 'heavyJobs']) assert.ok(Number.isFinite(summary.limits[field]), field);
  assert.equal(run.events, undefined, 'events stay out of the push');
  assert.deepEqual(run.jobs.map((job) => job.nonce).sort(), ['a-0', 'd-0'], 'only current jobs are pushed');
  // The states read from it end to end.
  assert.equal(stagePixelOf(run, run.nodes.find((node) => node.id === 'architecture'), { now: NOW }).pose, 'work');
  assert.equal(stagePixelOf(run, run.nodes.find((node) => node.id === 'design'), { now: NOW }).label, '멈춤 · 시작 화면');
});

test('the pixel fields add only the dialog name to the push, and a busy day still fits one panel message', () => {
  // Arrange: the same state with and without what this bundle added (job.blocker.dialog).
  const withDialog = state(BUSY_DAY_RUNS);
  const without = structuredClone(withDialog);
  for (const run of without.runs) for (const job of run.jobs) if (job.blocker) delete job.blocker.dialog;
  // Act
  const bytes = Buffer.byteLength(JSON.stringify(projectState(withDialog, 'summary')));
  const before = Buffer.byteLength(JSON.stringify(projectState(without, 'summary')));
  // Assert
  assert.ok(bytes - before <= BUSY_DAY_RUNS * 24, 'added ' + (bytes - before) + ' bytes');
  assert.ok(bytes < ORCA_PANEL_MESSAGE_BYTES, 'summary push is ' + bytes + ' bytes');
});
