import test from 'node:test';
import assert from 'node:assert/strict';
import { planJobWatch, createJobWatch, ATTENTION_AFTER_MS, IDLE_NUDGE_AFTER_MS, RECEIPT_SETTLE_MS, WATCH_INTERVAL_MS } from '../src/watch.mjs';

const NOW = Date.parse('2026-11-22T09:00:00.000Z');
const job = (extra = {}) => ({ nonce: 'n1', terminalId: 't1', agentState: 'working', ...extra });
const agent = (extra = {}) => ({ terminalId: 't1', state: 'done', stateStartedAt: NOW - 60_000, sessionId: 's1', ...extra });
const plan = (jobs, agents, receipts = new Map()) => planJobWatch({ jobs, agents, receipts, now: NOW });

test('the watch runs every minute and acts within a few minutes', () => {
  assert.equal(WATCH_INTERVAL_MS, 60_000);
  for (const ms of [ATTENTION_AFTER_MS, IDLE_NUDGE_AFTER_MS, RECEIPT_SETTLE_MS]) assert.ok(ms <= 5 * 60_000);
});

test('a state the plugin missed is replayed from agents.list', () => {
  const [action] = plan([job()], [agent()]);
  assert.deepEqual(action, { kind: 'status', nonce: 'n1', event: { terminalId: 't1', state: 'done', sessionId: 's1', receivedAt: NOW - 60_000 } });
});

test('an idle agent whose report exists but was never taken in is picked up at once', () => {
  assert.deepEqual(plan([job({ agentState: 'done' })], [agent()], new Map([['n1', NOW - 1000]])), [{ kind: 'report', nonce: 'n1' }]);
  assert.deepEqual(plan([job({ agentState: 'done' })], [agent()], new Map([['n1', null]])), [{ kind: 'report', nonce: 'n1' }], 'time unknown');
});

test('a settled report is taken in even while Orca still says working (a lost done)', () => {
  // A live assets review: report written 09:38:21, turn over 09:38:33, Orca "working" an hour later.
  const working = job();
  const fresh = plan([working], [agent({ state: 'working' })], new Map([['n1', NOW - RECEIPT_SETTLE_MS + 5000]]));
  assert.deepEqual(fresh, [], 'a report still being written is left alone');
  assert.deepEqual(plan([working], [agent({ state: 'working' })], new Map([['n1', NOW - RECEIPT_SETTLE_MS - 1000]])), [{ kind: 'report', nonce: 'n1' }]);
  assert.deepEqual(plan([working], [agent({ state: 'working' })], new Map([['n1', null]])), [], 'no time, no settling');
});

test('a report already refused for its form is only taken again once rewritten', () => {
  const refused = job({ agentState: 'done', reportRejectedAt: NOW - 10 * 60_000 });
  assert.deepEqual(plan([refused], [agent({ stateStartedAt: NOW - 30_000 })], new Map([['n1', NOW - 10 * 60_000]])), []);
  assert.deepEqual(plan([refused], [agent({ stateStartedAt: NOW - 30_000 })], new Map([['n1', NOW - 20_000]])), [{ kind: 'report', nonce: 'n1' }]);
  assert.deepEqual(plan([{ ...refused }], [agent({ stateStartedAt: NOW - 30_000 })], new Map([['n1', null]])), [], 'time unknown after a refusal');
});

test('a turn that ended without a report is nudged after a few minutes', () => {
  const ended = job({ agentState: 'done' });
  assert.deepEqual(plan([ended], [agent({ stateStartedAt: NOW - IDLE_NUDGE_AFTER_MS + 1000 })]), []);
  assert.deepEqual(plan([ended], [agent({ stateStartedAt: NOW - IDLE_NUDGE_AFTER_MS - 1000 })]), [{ kind: 'idle', nonce: 'n1', idleMinutes: 3 }]);
});

test('an agent waiting on a prompt or permission gets attention after a few minutes, never typing', () => {
  // A live architecture stage: a Bash call waited on a permission prompt for 59 minutes, Orca said waiting.
  const waiting = job({ agentState: 'waiting' });
  assert.deepEqual(plan([waiting], [agent({ state: 'waiting', stateStartedAt: NOW - ATTENTION_AFTER_MS + 1000 })]), []);
  const [action] = plan([waiting], [agent({ state: 'waiting', stateStartedAt: NOW - 21 * 60_000 })]);
  assert.deepEqual(action, { kind: 'attention', nonce: 'n1', state: 'waiting', idleMinutes: 21 });
  const [blocked] = plan([job({ agentState: 'blocked' })], [agent({ state: 'blocked', stateStartedAt: NOW - 4 * 60_000 })]);
  assert.equal(blocked.kind, 'attention');
});

test('working agents, unknown states and missing terminals are left to the existing paths', () => {
  assert.deepEqual(plan([job()], [agent({ state: 'working' })]), []);
  assert.deepEqual(plan([job()], [agent({ state: 'mystery' })], new Map([['n1', NOW - 3_600_000]])), []);
  assert.deepEqual(plan([job()], [], new Map([['n1', NOW - 3_600_000]])), []);
});

test('the watch confirms only the same working session after the prompt arrived', () => {
  const started = job({ sessionId: 's1', promptSeen: true });
  const busy = agent({ state: 'working' });
  assert.deepEqual(plan([started], [busy]), [{ kind: 'confirmed-working', nonce: 'n1', sessionId: 's1', at: NOW }]);
  assert.deepEqual(plan([started], [{ ...busy, sessionId: 'other' }]), []);
  assert.deepEqual(plan([{ ...started, promptSeen: false }], [busy]), []);
  assert.deepEqual(plan([started], [busy], new Map([['n1', NOW - RECEIPT_SETTLE_MS]])), [{ kind: 'report', nonce: 'n1' }]);
});

test('one pass lists agents once per workspace, stats receipts, and never overlaps', async () => {
  const calls = { list: 0, receipt: 0, apply: [] };
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const watch = createJobWatch({
    now: () => NOW,
    watched: () => [
      { runId: 'r1', workspaceId: 'w1', jobs: [job({ agentState: 'done' }), job({ nonce: 'n2', terminalId: 't2' })] },
      { runId: 'r2', workspaceId: null, jobs: [job({ nonce: 'n3' })] },
    ],
    listAgents: async () => { calls.list++; await gate; return [agent(), agent({ terminalId: 't2', state: 'working' })]; },
    receiptAt: async (item) => { calls.receipt++; return item.nonce === 'n1' ? NOW - 1000 : false; },
    apply: async (runId, actions) => { calls.apply.push([runId, actions]); },
  });
  const first = watch.tick();
  const overlapping = watch.tick();
  release();
  await Promise.all([first, overlapping]);
  assert.equal(calls.list, 1, 'one agents.list for the workspace; a pass already running is not doubled');
  assert.equal(calls.receipt, 2);
  assert.deepEqual(calls.apply, [['r1', [{ kind: 'report', nonce: 'n1' }]]]);
});

test('a failing agents.list skips that run without stopping the pass', async () => {
  const applied = [];
  const watch = createJobWatch({
    now: () => NOW,
    watched: () => [{ runId: 'r1', workspaceId: 'w1', jobs: [job()] }, { runId: 'r2', workspaceId: 'w2', jobs: [job({ nonce: 'n2', terminalId: 't2' })] }],
    listAgents: async (workspaceId) => { if (workspaceId === 'w1') throw new Error('down'); return [agent({ terminalId: 't2' })]; },
    receiptAt: async () => false,
    apply: async (runId, actions) => { applied.push(runId + ':' + actions[0].kind); },
  });
  await watch.tick();
  assert.deepEqual(applied, ['r2:status']);
});
