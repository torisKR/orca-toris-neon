import test from 'node:test';
import assert from 'node:assert/strict';
import { closeCandidates, closesFinishedTerminals, createTerminalCleanup, CLOSE_GRACE_MS, MAX_CLOSE_ATTEMPTS } from '../src/cleanup.mjs';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const job = (nonce, extra = {}) => ({ nonce, nodeId: 'build', phase: 'work', terminalId: 't-' + nonce, sessionId: 's-' + nonce, state: 'complete', completedAt: iso(NOW - CLOSE_GRACE_MS - 1000), ...extra });
const run = (jobs, extra = {}) => ({ id: 'r', workspaceId: 'w', autonomous: true, nodes: [{ id: 'build', title: '구현', active: null }], jobs, ...extra });
const nonces = (list) => list.map((item) => item.nonce);

test('finished jobs are closed only after a short grace period', () => {
  assert.ok(CLOSE_GRACE_MS >= 60_000 && CLOSE_GRACE_MS <= 5 * 60_000);
  const fresh = job('fresh', { completedAt: iso(NOW - 10_000) });
  assert.deepEqual(nonces(closeCandidates(run([job('old'), fresh]), { now: NOW })), ['old']);
});

test('accepted, superseded, cancelled and undelivered jobs qualify; live, awaited and uncertain ones never do', () => {
  const r = run([
    job('complete'), job('superseded', { state: 'superseded', completedAt: undefined }), job('cancelled', { state: 'cancelled', completedAt: undefined }),
    job('undelivered', { state: 'undelivered', completedAt: undefined }),
    job('running', { state: 'running' }), job('awaiting', { state: 'awaiting-report' }), job('uncertain', { state: 'uncertain' }),
    job('launching', { state: 'launching' }), job('noterm', { terminalId: null }), job('closed', { terminalClosed: { at: iso(NOW) } }),
    job('gaveup', { closeAttempts: MAX_CLOSE_ATTEMPTS }),
  ]);
  assert.deepEqual(nonces(closeCandidates(r, { now: NOW })), ['complete', 'superseded', 'cancelled', 'undelivered']);
});

test('the terminal of the stage\'s current job, or one shared with a live job, stays open', () => {
  const r = run([job('current'), job('pending'), job('shared'), job('live', { state: 'running', terminalId: 't-shared' })]);
  r.nodes = [{ id: 'build', active: { nonce: 'current' } }, { id: 'test', pendingReceipt: { nonce: 'pending' } }];
  assert.deepEqual(nonces(closeCandidates(r, { now: NOW })), []);
});

test('the switch is on by default in autonomous runs, off otherwise, and an explicit choice wins', () => {
  assert.equal(closesFinishedTerminals({ autonomous: true }), true);
  assert.equal(closesFinishedTerminals({ autonomous: false }), false);
  assert.equal(closesFinishedTerminals({ autonomous: true, closeFinishedTerminals: false }), false);
  assert.equal(closesFinishedTerminals({ autonomous: false, closeFinishedTerminals: true }), true);
  assert.deepEqual(closeCandidates(run([job('a')], { closeFinishedTerminals: false }), { now: NOW }), []);
});

function harness({ terminals, agents, failClose = () => false, runs }) {
  const closed = [];
  const records = [];
  const cleanup = createTerminalCleanup({
    now: () => NOW,
    runs: () => runs,
    listTerminals: async () => terminals.map((id) => ({ id })),
    listAgents: async () => agents,
    close: async (terminalId) => { if (failClose(terminalId)) throw new Error('Orca could not complete this action'); closed.push(terminalId); return { closed: true }; },
    record: (r, j, outcome) => records.push({ nonce: j.nonce, ...outcome }),
  });
  return { cleanup, closed, records };
}

test('a pass closes idle terminals, marks vanished ones, leaves working ones and reports them', async () => {
  const runs = [run([job('idle'), job('shell'), job('gone'), job('busy'), job('asking')])];
  const h = harness({ runs, terminals: ['t-idle', 't-shell', 't-busy', 't-asking'],
    agents: [{ terminalId: 't-idle', state: 'done' }, { terminalId: 't-busy', state: 'working' }, { terminalId: 't-asking', state: 'waiting' }] });
  const summary = await h.cleanup.sweep();
  assert.deepEqual(h.closed, ['t-idle', 't-shell']);
  assert.deepEqual(summary.closed.map((item) => item.terminalId), ['t-idle', 't-shell']);
  assert.deepEqual(summary.gone.map((item) => item.terminalId), ['t-gone']);
  assert.deepEqual(summary.kept.map((item) => [item.terminalId, item.state]), [['t-busy', 'working'], ['t-asking', 'waiting']]);
  assert.deepEqual(h.records.map((item) => [item.nonce, item.kind]), [['idle', 'closed'], ['shell', 'closed'], ['gone', 'gone'], ['busy', 'kept'], ['asking', 'kept']]);
});

test('a failed close is recorded for a later retry and never throws', async () => {
  const runs = [run([job('a'), job('b')])];
  const h = harness({ runs, terminals: ['t-a', 't-b'], agents: [], failClose: (id) => id === 't-a' });
  const summary = await h.cleanup.sweep();
  assert.deepEqual(summary.failed.map((item) => item.terminalId), ['t-a']);
  assert.deepEqual(h.closed, ['t-b']);
  assert.equal(h.records.find((item) => item.nonce === 'a').kind, 'failed');
});

test('a run whose terminals cannot be listed is skipped, not guessed at', async () => {
  const runs = [run([job('a')])];
  const cleanup = createTerminalCleanup({ now: () => NOW, runs: () => runs, listTerminals: async () => { throw new Error('down'); },
    listAgents: async () => [], close: async () => assert.fail('must not close'), record: () => assert.fail('nothing to record') });
  const summary = await cleanup.sweep();
  assert.equal(summary.skipped.length, 1);
});

test('a truncated terminal list never marks an unlisted terminal as gone', async () => {
  const runs = [run([job('a'), job('b')])];
  const records = [];
  const closed = [];
  const cleanup = createTerminalCleanup({ now: () => NOW, runs: () => runs,
    listTerminals: async () => ({ terminals: [{ id: 't-a' }], truncated: true }), listAgents: async () => [],
    close: async (id) => { closed.push(id); return { closed: true }; }, record: (r, j, outcome) => records.push([j.nonce, outcome.kind]) });
  const summary = await cleanup.sweep();
  assert.deepEqual(closed, ['t-a']);
  assert.deepEqual(records, [['a', 'closed']]);
  assert.deepEqual(summary.gone, []);
});
