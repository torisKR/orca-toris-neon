import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerJobs, observeSessions, failedCheck, updateUsage, usageSummary, usageTargets, createUsageSync,
  FINAL_CHECKS, LOWER_CONFIRMATIONS, SESSION_LIMIT, USAGE_METHOD,
} from '../src/usage.mjs';
import { compactRun, archiveRun } from '../src/store.mjs';
import { projectState } from '../src/views.mjs';
import { createRun } from '../src/engine.mjs';

const START = Date.parse('2026-11-23T05:00:00.000Z');
const at = (minutes) => new Date(START + minutes * 60_000).toISOString();
const job = (extra = {}) => ({
  nonce: 'n1', nodeId: 'build', phase: 'work', attempt: 1, agent: 'codex', terminalId: 't1', sessionId: 's1',
  startedAt: at(0), selfDelivery: true, promptRecovery: { state: 'sent' }, ...extra,
});
const row = (extra = {}) => ({
  sessionId: 's1', agent: 'codex', hostId: 'local', workspaceId: 'w1', createdAt: START + 2000, updatedAt: START + 60_000,
  totalTokens: 0, running: true, title: 'x', branch: null, messageCount: 1, ...extra,
});
const observed = (usage, rows, extra = {}) => observeSessions(usage, { rows, truncated: false, workspaceId: 'w1', at: at(1), typed: new Set(['n1', 'n2', 'n3']), ...extra });
const ledger = (jobs) => registerJobs(undefined, jobs);

test('a cumulative session total is stored once: 100K, 150K, 150K and a restart redelivery stay 150K', () => {
  // Arrange
  let usage = ledger([job()]);
  // Act
  for (const total of [100_000, 150_000, 150_000]) usage = observed(usage, [row({ totalTokens: total })]);
  const restarted = observed(registerJobs(JSON.parse(JSON.stringify(usage)), [job()]), [row({ totalTokens: 150_000 })]);
  // Assert
  assert.equal(usageSummary(usage).total, 150_000);
  assert.equal(usageSummary(restarted).total, 150_000);
  assert.equal(restarted.sessions.length, 1, 're-registering the same job does not add a second session');
  assert.equal(usageSummary(restarted).scope, 'complete');
});

test('a resumed session counts only the part after its baseline, and without one is a session total, not this run', () => {
  // Arrange: the session existed before the job started (created an hour earlier) and already held 1M.
  const old = { createdAt: START - 3_600_000 };
  const untyped = job({ promptRecovery: undefined });
  // Act: seen once before the prompt was typed (baseline), then after the work.
  let withBaseline = observeSessions(ledger([untyped]), { rows: [row({ ...old, totalTokens: 1_000_000 })], workspaceId: 'w1', at: at(1), typed: new Set() });
  withBaseline = observed(withBaseline, [row({ ...old, totalTokens: 1_300_000 })]);
  const noBaseline = observed(ledger([job()]), [row({ ...old, totalTokens: 1_300_000 })]);
  // Assert
  assert.equal(usageSummary(withBaseline).total, 300_000);
  assert.equal(usageSummary(withBaseline).stages.build.work, 300_000);
  const summary = usageSummary(noBaseline);
  assert.equal(summary.total, null, 'never 1.3M for this run without a baseline');
  assert.equal(summary.sessionTotal, 1_300_000);
  assert.equal(summary.scope, 'session');
  assert.equal(summary.stages.build.work, null, 'no stage figure from a session total');
  assert.equal(summary.stages.build.uncounted, 1);
});

test('a session created after the job started is new: its baseline is zero', () => {
  const usage = observed(ledger([job()]), [row({ totalTokens: 42_000 })]);
  assert.equal(usage.sessions[0].baseline, 0);
  assert.equal(usageSummary(usage).total, 42_000);
});

test('a session with no creation time is not assumed new', () => {
  const usage = observed(ledger([job()]), [row({ createdAt: null, totalTokens: 42_000 })]);
  assert.equal(usageSummary(usage).total, null);
  assert.equal(usageSummary(usage).scope, 'session');
});

test('a session created just before this job cannot count its prior tokens against this run', () => {
  const usage = observed(ledger([job()]), [row({ createdAt: START - 2_000, totalTokens: 42_000 })]);
  const summary = usageSummary(usage);

  assert.equal(summary.total, null);
  assert.equal(summary.sessionTotal, 42_000);
});

test('a truncated list stays partial even when it contains every currently linked session', () => {
  const usage = observed(ledger([job()]), [row({ totalTokens: 42_000 })], { truncated: true });
  const summary = usageSummary(usage);

  assert.equal(summary.total, 42_000);
  assert.equal(summary.scope, 'partial');
  assert.equal(summary.counts.truncated, 0, 'zero linked sessions missing is not a complete list');
});

test('failed, cancelled and retried attempts keep their tokens and the retry part is not added again', () => {
  // Arrange: attempt 1 failed (s1), attempt 2 retried (s2), then a review (s3).
  const jobs = [
    job({ state: 'failed' }),
    job({ nonce: 'n2', attempt: 2, sessionId: 's2', terminalId: 't2', state: 'cancelled' }),
    job({ nonce: 'n3', phase: 'review', agent: 'claude', sessionId: 's3', terminalId: 't3' }),
  ];
  // Act
  const usage = observed(ledger(jobs), [
    row({ totalTokens: 500_000 }), row({ sessionId: 's2', totalTokens: 400_000 }), row({ sessionId: 's3', agent: 'claude', totalTokens: 400_000 }),
  ]);
  const summary = usageSummary(usage);
  // Assert
  assert.equal(summary.total, 1_300_000);
  assert.equal(summary.retry, 400_000);
  assert.deepEqual({ work: summary.stages.build.work, review: summary.stages.build.review, retry: summary.stages.build.retry, total: summary.stages.build.total },
    { work: 900_000, review: 400_000, retry: 400_000, total: 1_300_000 });
  assert.deepEqual(summary.stages.build.agents, { work: ['codex'], review: ['claude'] });
});

test('only sessions tied to the run\'s jobs count; other sessions in the workspace are ignored', () => {
  const usage = observed(ledger([job()]), [row({ totalTokens: 10_000 }), row({ sessionId: 'someone-else', totalTokens: 9_000_000 })]);
  assert.equal(usageSummary(usage).total, 10_000);
});

test('the host is pinned at first sight: the same session id from another host is not this session', () => {
  let usage = observed(ledger([job()]), [row({ totalTokens: 10_000 })]);
  usage = observed(usage, [row({ hostId: 'paired-runtime', totalTokens: 7_000_000 })], { at: at(2) });
  assert.equal(usage.sessions[0].latest, 10_000);
  assert.equal(usage.sessions[0].missing, 'absent');
  assert.equal(usageSummary(usage).scope, 'partial');
});

test('the agent must match too: a codex session id reported for claude is not mapped', () => {
  const usage = observed(ledger([job()]), [row({ agent: 'claude', totalTokens: 10_000 })]);
  assert.equal(usageSummary(usage).total, null);
  assert.equal(usageSummary(usage).scope, 'pending');
});

test('truncated lists, missing sessions, failed reads, unsupported Orca and a bare zero are never shown as 0 or complete', () => {
  const base = observed(ledger([job()]), [row({ totalTokens: 80_000 })]);
  const truncated = observed(base, [], { truncated: true, at: at(2) });
  assert.equal(truncated.sessions[0].latest, 80_000, 'a session past the list limit keeps its last value');
  assert.equal(truncated.sessions[0].missing, 'truncated');
  assert.equal(usageSummary(truncated).scope, 'partial');
  assert.equal(usageSummary(truncated).total, 80_000);

  const failed = failedCheck(base, { error: 'boom', at: at(2) });
  assert.equal(usageSummary(failed).total, 80_000);
  assert.equal(usageSummary(failed).scope, 'partial');
  assert.equal(usageSummary(failedCheck(ledger([job()]), { error: 'boom', at: at(2) })).scope, 'unavailable');
  assert.equal(usageSummary(failedCheck(ledger([job()]), { error: 'boom', at: at(2) })).total, null);

  const unsupported = usageSummary(failedCheck(base, { unsupported: true, error: 'no method', at: at(2) }));
  assert.equal(unsupported.scope, 'unavailable');
  assert.equal(unsupported.total, null, 'an Orca without the API shows no number, not 0');

  const zero = usageSummary(observed(ledger([job()]), [row({ totalTokens: 0 })]));
  assert.equal(zero.total, null, 'a zero alone does not prove no use');
  assert.equal(zero.scope, 'pending');

  const unmapped = usageSummary(observed(ledger([job(), job({ nonce: 'n2', terminalId: 't2', sessionId: undefined })]), [row({ totalTokens: 5_000 })]));
  assert.equal(unmapped.scope, 'partial', 'a launched job with no session yet narrows the scope');
  assert.equal(unmapped.counts.unmapped, 1);

  assert.equal(usageSummary(undefined).scope, 'pending');
  assert.equal(usageSummary(undefined).total, null);
});

test('a smaller value never overwrites silently: once is held, a confirmed correction is taken, zero never is', () => {
  // Arrange
  let usage = observed(ledger([job()]), [row({ totalTokens: 150_000 })]);
  // Act: one stale read
  usage = observed(usage, [row({ totalTokens: 120_000 })], { at: at(2) });
  // Assert
  assert.equal(usage.sessions[0].latest, 150_000);
  assert.equal(usageSummary(usage).scope, 'partial', 'held value is marked uncertain');
  for (let seen = 2; seen <= LOWER_CONFIRMATIONS; seen++) usage = observed(usage, [row({ totalTokens: 120_000 })], { at: at(1 + seen) });
  assert.equal(usage.sessions[0].latest, 120_000, 'the same smaller value seen again is a correction, not a stale read');
  assert.deepEqual(usage.sessions[0].corrected, { from: 150_000, to: 120_000, at: at(1 + LOWER_CONFIRMATIONS) });
  assert.equal(usageSummary(usage).scope, 'complete');

  let zeroed = observed(ledger([job()]), [row({ totalTokens: 150_000 })]);
  for (let seen = 0; seen < LOWER_CONFIRMATIONS + 2; seen++) zeroed = observed(zeroed, [row({ totalTokens: 0 })], { at: at(2 + seen) });
  assert.equal(zeroed.sessions[0].latest, 150_000, 'a zero after a real value is never taken as no use');
  assert.equal(usageSummary(zeroed).scope, 'partial');

  const back = observed(observed(observed(ledger([job()]), [row({ totalTokens: 150_000 })]), [row({ totalTokens: 120_000 })], { at: at(2) }), [row({ totalTokens: 160_000 })], { at: at(3) });
  assert.equal(back.sessions[0].latest, 160_000);
  assert.equal(back.sessions[0].lower, undefined, 'a larger value clears the doubt');
});

test('two jobs on one session count it once and leave the stage unclassified', () => {
  const jobs = [job(), job({ nonce: 'n2', nodeId: 'test', phase: 'review', terminalId: 't2' })];
  const summary = usageSummary(observed(ledger(jobs), [row({ totalTokens: 700_000 })]));
  assert.equal(summary.total, 700_000);
  assert.equal(summary.unattributed, 700_000);
  assert.equal(summary.stages.build, undefined);
  assert.equal(summary.stages.test, undefined);
});

test('two attempts of the same stage and phase on one session stay with that stage', () => {
  const jobs = [job(), job({ nonce: 'n2', attempt: 2, terminalId: 't2' })];
  const summary = usageSummary(observed(ledger(jobs), [row({ totalTokens: 700_000 })]));
  assert.equal(summary.stages.build.work, 700_000);
  assert.equal(summary.unattributed, 0);
  assert.equal(summary.retry, 0, 'which part was the retry is unknown, so none is claimed');
});

test('a follow-up improvement run shows only its own sessions, never the parent run\'s again', () => {
  const parent = observed(ledger([job()]), [row({ totalTokens: 900_000 })]);
  const child = observed(ledger([job({ nonce: 'c1', sessionId: 's9', terminalId: 't9' })]), [row({ totalTokens: 900_000 }), row({ sessionId: 's9', totalTokens: 200_000 })]);
  assert.equal(usageSummary(parent).total, 900_000);
  assert.equal(usageSummary(child).total, 200_000);
});

test('jobs that never reached a terminal are not expected to have a session', () => {
  const usage = ledger([job({ terminalId: null, sessionId: undefined })]);
  assert.deepEqual(usage, { sessions: [], unmapped: [] });
  const waiting = usageSummary(ledger([job({ sessionId: undefined })]));
  assert.equal(waiting.counts.unmapped, 1);
  assert.equal(waiting.stages.build.uncertain, 1, 'the job\'s own stage knows it is not fully counted');
  assert.equal(usageSummary(usage).scope, 'pending');
});

test('updateUsage ignores check times, counts final checks, and marks real changes', () => {
  const run = { id: 'r1', status: 'running', workspaceId: 'w1', jobs: [job()] };
  const first = updateUsage(run, { rows: [row({ totalTokens: 10 })], truncated: false, workspaceId: 'w1' }, at(1));
  assert.equal(first.changed, true);
  const again = updateUsage({ ...run, usage: first.usage }, { rows: [row({ totalTokens: 10 })], truncated: false, workspaceId: 'w1' }, at(2));
  assert.equal(again.changed, false, 'only a newer check time: nothing to persist');
  assert.equal(again.usage.checkedAt, at(2));
  const done = updateUsage({ ...run, status: 'completed', usage: again.usage }, { rows: [row({ totalTokens: 10 })], truncated: false, workspaceId: 'w1' }, at(3));
  assert.equal(done.usage.finalChecks, 1);
  assert.equal(done.changed, true);
});

test('only live runs and a few final checks are queried, grouped per workspace, never archived runs', async () => {
  // Arrange
  const live = (id, workspaceId, extra = {}) => ({ id, workspaceId, status: 'running', jobs: [job()], ...extra });
  const runs = [
    live('a', 'w1'), live('b', 'w1'), live('c', 'w2'),
    live('done-fresh', 'w3', { status: 'completed', usage: { sessions: [], unmapped: [], finalChecks: FINAL_CHECKS - 1 } }),
    live('done-final', 'w4', { status: 'completed', usage: { sessions: [], unmapped: [], finalChecks: FINAL_CHECKS } }),
    live('idle', 'w5', { jobs: [] }),
  ];
  const calls = [];
  const applied = [];
  const sync = createUsageSync({
    targets: () => usageTargets(runs), supported: () => true,
    listSessions: async (workspaceId) => { calls.push(workspaceId); return { sessions: [row({ workspaceId, totalTokens: 5 })], truncated: false }; },
    apply: async (runId, observation) => { applied.push([runId, observation.rows.length]); },
  });
  // Act
  await sync();
  // Assert
  assert.deepEqual(calls, ['w1', 'w2', 'w3'], 'one read per workspace; finished runs stop after their final checks');
  assert.deepEqual(applied.map(([id]) => id), ['a', 'b', 'c', 'done-fresh']);
  assert.equal(SESSION_LIMIT, 200);
  assert.equal(USAGE_METHOD, 'agent.listSessions');
});

test('an unsupported Orca is not called, a refused method is unsupported, and a bad reply is a failed read', async () => {
  const runs = [{ id: 'a', workspaceId: 'w1', status: 'running', jobs: [job()] }];
  const seen = [];
  const make = (supported, listSessions) => createUsageSync({ targets: () => usageTargets(runs), supported: () => supported, listSessions, apply: async (_, observation) => { seen.push(observation); } });
  let called = 0;
  await make(false, async () => { called++; })();
  assert.equal(called, 0);
  await make(true, async () => { throw Object.assign(new Error('no'), { code: 'unknown_method' }); })();
  await make(true, async () => { throw new Error('timeout'); })();
  await make(true, async () => ({ sessions: 'nope' }))();
  assert.deepEqual(seen.map((item) => [Boolean(item.unsupported), Boolean(item.rows)]), [[true, false], [true, false], [false, false], [false, false]]);
  assert.match(seen[3].error, /형식/);
});

test('the summary survives a restart and every storage compaction level, archived runs keep a frozen copy', () => {
  // Arrange
  const run = createRun({ id: 'r1', goal: 'g', projectId: 'p1', nodes: [{ id: 'build', title: 'B', deps: [], write: true }], now: START });
  run.jobs = [job({ state: 'completed' })];
  run.usage = observed(ledger(run.jobs), [row({ totalTokens: 245_000 })]);
  const expected = usageSummary(run.usage);
  // Act / Assert
  for (const level of [0, 1, 2]) assert.deepEqual(usageSummary(JSON.parse(JSON.stringify(compactRun(run, level))).usage), expected, 'level ' + level);
  const archived = archiveRun({ ...run, status: 'completed' }, at(9));
  assert.deepEqual(usageSummary(archived.usage), expected);
  assert.deepEqual(usageSummary(archiveRun(archived, at(10)).usage), expected, 'archiving again keeps it');
});

test('the summary view carries the computed token usage, not the raw ledger', () => {
  const run = createRun({ id: 'r1', goal: 'g', projectId: 'p1', nodes: [{ id: 'build', title: 'B', deps: [], write: true }], now: START });
  run.usage = observed(ledger([job()]), [row({ totalTokens: 245_000 })]);
  const view = projectState({ version: 2, revision: 1, runs: [run], archivedRuns: [{ ...run, archivedAt: at(5) }] }, 'summary');
  assert.equal(view.runs[0].usage, undefined);
  assert.equal(view.runs[0].tokenUsage.total, 245_000);
  assert.equal(view.archivedRuns[0].tokenUsage.total, 245_000);
});

test('review fixes: a read that never answers times out, one run failing to store never skips the others', async () => {
  // Arrange
  const runs = [{ id: 'a', workspaceId: 'w1', status: 'running', jobs: [job()] }, { id: 'b', workspaceId: 'w1', status: 'running', jobs: [job()] }];
  const seen = [];
  const logs = [];
  const hung = createUsageSync({ targets: () => usageTargets(runs), supported: () => true, timeoutMs: 20, log: (line) => logs.push(line),
    listSessions: () => new Promise(() => {}),
    apply: async (runId, observation) => { seen.push([runId, observation.error]); if (runId === 'a') throw new Error('disk full'); } });
  // Act
  await hung();
  // Assert
  assert.deepEqual(seen.map(([id]) => id), ['a', 'b']);
  assert.match(seen[0][1], /응답하지 않았습니다/);
  assert.ok(logs.some((line) => /실행 a.*disk full/.test(line)));
});

test('review fixes: an error without a message still names a reason', async () => {
  const runs = [{ id: 'a', workspaceId: 'w1', status: 'running', jobs: [job()] }];
  const seen = [];
  await createUsageSync({ targets: () => usageTargets(runs), supported: () => true, listSessions: async () => { throw Object.assign(new Error(''), { code: 'action_failed' }); },
    apply: async (_, observation) => { seen.push(observation); } })();
  assert.equal(seen[0].error, 'action_failed');
  assert.equal(failedCheck(ledger([job()]), { at: at(1) }).error, '알 수 없는 오류');
});

test('review fixes: non-integer totals are unavailable, not waiting', () => {
  const summary = usageSummary(observed(ledger([job()]), [row({ totalTokens: '12000' })]));
  assert.equal(summary.counts.invalid, 1);
  assert.equal(summary.scope, 'unavailable');
  assert.equal(summary.total, null);
});

test('review fixes: failed reads after a run ends do not use up its final checks, but are capped', () => {
  let run = { id: 'r1', status: 'completed', workspaceId: 'w1', jobs: [job()] };
  for (let pass = 0; pass < 3; pass++) run = { ...run, usage: updateUsage(run, { error: 'down' }, at(pass)).usage };
  assert.equal(run.usage.finalChecks, undefined);
  assert.equal(usageTargets([run]).length, 1, 'still owed its successful final checks');
  for (let pass = 3; pass < 10; pass++) run = { ...run, usage: updateUsage(run, { error: 'down' }, at(pass)).usage };
  assert.equal(usageTargets([run]).length, 0, 'a run that keeps failing is left alone');
});

test('review fixes: a persistent failure does not rewrite storage every pass', () => {
  const run = { id: 'r1', status: 'running', workspaceId: 'w1', jobs: [job()] };
  const first = updateUsage(run, { error: 'down' }, at(1));
  assert.equal(updateUsage({ ...run, usage: first.usage }, { error: 'down' }, at(2)).changed, false);
});

test('review fixes: a correction below the baseline becomes a session total; an ungrown resumed session waits, never 0', () => {
  const old = { createdAt: START - 3_600_000 };
  const untyped = job({ promptRecovery: undefined });
  const resumed = observeSessions(ledger([untyped]), { rows: [row({ ...old, totalTokens: 1_000_000 })], workspaceId: 'w1', at: at(1), typed: new Set() });
  const ungrown = usageSummary(observed(resumed, [row({ ...old, totalTokens: 1_000_000 })]));
  assert.equal(ungrown.total, null);
  assert.equal(ungrown.scope, 'pending');
  let corrected = resumed;
  for (let pass = 0; pass < LOWER_CONFIRMATIONS; pass++) corrected = observed(corrected, [row({ ...old, totalTokens: 900_000 })], { at: at(2 + pass) });
  const summary = usageSummary(corrected);
  assert.equal(summary.total, null);
  assert.equal(summary.sessionTotal, 900_000);
  assert.equal(summary.scope, 'session');
});

test('review fixes: a missing read between two smaller reads restarts the confirmation', () => {
  let usage = observed(ledger([job()]), [row({ totalTokens: 150_000 })]);
  usage = observed(usage, [row({ totalTokens: 120_000 })], { at: at(2) });
  usage = observed(usage, [], { at: at(3) });
  usage = observed(usage, [row({ totalTokens: 120_000 })], { at: at(4) });
  assert.equal(usage.sessions[0].latest, 150_000);
});

test('review fixes: a damaged stored ledger is unavailable instead of breaking every summary', () => {
  const summary = usageSummary({ sessions: [{ sessionId: 's1', latest: 5 }] });
  assert.equal(summary.scope, 'unavailable');
  assert.match(summary.error, /저장된 토큰 기록/);
});

test('review fixes: a run from before token usage has no token summary rather than a permanent wait', () => {
  const run = createRun({ id: 'r1', goal: 'g', projectId: 'p1', nodes: [{ id: 'build', title: 'B', deps: [], write: true }], now: START });
  const view = projectState({ version: 2, revision: 1, runs: [run], archivedRuns: [{ ...run, archivedAt: at(5) }] }, 'summary');
  assert.equal(view.runs[0].tokenUsage, null);
  assert.equal(view.archivedRuns[0].tokenUsage, null);
});
