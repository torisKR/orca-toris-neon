import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_GRAPH, createRun, validateGraph, nextActions, claimNode, recordLaunch,
  applyReport, approveNode, pauseRun, resumeRun, recoverRun, retryNode, blockNode,
  cancelRun, dateKey, dailySnapshot, releaseClaim, ECC_AGENT_PATTERN,
} from '../src/engine.mjs';

const NOW = '2026-11-18T15:10:00.000Z';
let nonceNumber = 0;
const nonce = () => 'claim-' + (++nonceNumber);
const graph = (...rows) => rows.map(([id, deps = [], write = false, requiresApproval = false]) => ({ id, title: id, deps, write, requiresApproval }));
const make = (options = {}) => createRun({ id: 'run-1', goal: '검증 가능한 앱을 만듭니다.', now: NOW, ...options });
const result = (run, id, outcome = 'passed', extras = {}) => {
  const active = run.nodes.find(node => node.id === id).active;
  return {
    runId: run.id, nodeId: id, phase: active.phase, nonce: active.nonce, attempt: active.attempt,
    outcome, summary: id + ' ' + outcome,
    evidence: outcome === 'passed' ? [{ kind: 'artifact', path: 'artifacts/' + id + '.md' }] : [],
    ...extras,
  };
};
function complete(run, id, now = NOW) {
  run = claimNode(run, id, { nonce: nonce(), now });
  run = applyReport(run, id, result(run, id), { now });
  assert.equal(run.nodes.find(node => node.id === id).status, 'review');
  run = claimNode(run, id, { phase: 'review', nonce: nonce(), now });
  return applyReport(run, id, result(run, id), { now });
}
function thrown(code) {
  return error => error.code === code;
}

test('default graph has eleven stages and both publication stages require approval', () => {
  const run = make();
  assert.equal(run.nodes.length, 11);
  assert.equal(validateGraph(DEFAULT_GRAPH).length, 11);
  assert.deepEqual(nextActions(run), [{ nodeId: 'research', phase: 'work', agent: 'codex' }]);
  assert.ok(run.nodes.find(node => node.id === 'internal').requiresApproval);
  assert.ok(run.nodes.find(node => node.id === 'release').requiresApproval);
  assert.deepEqual(run.nodes.find(node => node.id === 'policy').deps, ['test']);
  assert.equal(run.maxConcurrency, 2);
});

test('unknown dependencies, duplicate ids, cycles, and invalid limits are rejected', () => {
  assert.throws(() => validateGraph(graph(['build', ['missing']])), thrown('unknown_dependency'));
  assert.throws(() => validateGraph(graph(['a'], ['a'])), thrown('duplicate_node'));
  assert.throws(() => validateGraph(graph(['a', ['b']], ['b', ['a']])), thrown('cyclic_graph'));
  assert.throws(() => make({ maxConcurrency: 0 }), thrown('invalid_input'));
  assert.throws(() => make({ maxConcurrency: 7 }), thrown('invalid_input'));
  assert.throws(() => make({ maxRepairLoops: -1 }), thrown('invalid_input'));
});

test('claims are immutable, reserve a slot before launch, and retrying the claim is idempotent', () => {
  const initial = make({ nodes: graph(['a'], ['b']) });
  const snapshot = structuredClone(initial);
  let run = claimNode(initial, 'a', { nonce: 'n-1', now: NOW });
  assert.deepEqual(initial, snapshot);
  assert.equal(run.nodes[0].attempts, 1);
  assert.equal(run.nodes[0].active.terminalId, null);
  assert.deepEqual(claimNode(run, 'a', { nonce: 'n-1', now: NOW }), run);
  assert.deepEqual(nextActions(run).map(action => action.nodeId), ['b']);
  assert.throws(() => claimNode(run, 'b', { nonce: 'n-1', now: NOW }), thrown('duplicate_nonce'));
  run.nodes[0].active.receiptPath = '/private/receipts/one.json';
  run = recordLaunch(run, 'a', { nonce: 'n-1', terminalId: 'term-a', now: NOW });
  assert.equal(run.nodes[0].active.receiptPath, '/private/receipts/one.json');
  assert.throws(() => recordLaunch(run, 'a', { nonce: 'n-1', terminalId: 'term-b' }), thrown('duplicate_launch'));
});

test('dependency gates wait for independent review, not a worker completion', () => {
  let run = make({ nodes: graph(['a'], ['b', ['a']]), assignments: { a: { agent: 'cursor', reviewer: 'claude' } } });
  assert.equal(nextActions(run)[0].agent, 'cursor');
  run = claimNode(run, 'a', { nonce: nonce(), now: NOW });
  run = applyReport(run, 'a', result(run, 'a'), { now: NOW });
  assert.deepEqual(nextActions(run), [{ nodeId: 'a', phase: 'review', agent: 'claude' }]);
  assert.throws(() => claimNode(run, 'b', { nonce: nonce() }), thrown('not_ready'));
  run = claimNode(run, 'a', { nonce: nonce(), phase: 'review', now: NOW });
  run = applyReport(run, 'a', result(run, 'a'), { now: NOW });
  assert.equal(nextActions(run)[0].nodeId, 'b');
});

test('parallel read-only stages share the limit while workspace writers serialize', () => {
  let run = make({ nodes: graph(['write-a', [], true], ['write-b', [], true], ['read-a'], ['read-b']), maxConcurrency: 3 });
  assert.deepEqual(nextActions(run).map(item => item.nodeId), ['write-a', 'read-a', 'read-b']);
  run = claimNode(run, 'write-a', { nonce: nonce(), now: NOW });
  run = claimNode(run, 'read-a', { nonce: nonce(), now: NOW });
  run = claimNode(run, 'read-b', { nonce: nonce(), now: NOW });
  assert.deepEqual(nextActions(run), []);
  run = applyReport(run, 'write-a', result(run, 'write-a'), { now: NOW });
  assert.equal(nextActions(run)[0].phase, 'review');
  run = claimNode(run, 'write-a', { nonce: nonce(), phase: 'review', now: NOW });
  assert.deepEqual(nextActions(run), []);
});

test('missing evidence, contradictory command exits, wrong run/nonce/attempt cannot pass', () => {
  let run = make({ nodes: graph(['build']) });
  run = claimNode(run, 'build', { nonce: nonce(), now: NOW });
  const report = result(run, 'build');
  assert.throws(() => applyReport(run, 'build', { ...report, evidence: [] }), thrown('missing_evidence'));
  assert.throws(() => applyReport(run, 'build', { ...report, evidence: [{ kind: 'command', command: 'npm test', exitCode: 1 }] }), thrown('contradictory_evidence'));
  assert.throws(() => applyReport(run, 'build', { ...report, runId: 'other' }), thrown('invalid_report'));
  assert.throws(() => applyReport(run, 'build', { ...report, nonce: 'old' }), thrown('stale_report'));
  assert.throws(() => applyReport(run, 'build', { ...report, attempt: 7 }), thrown('stale_report'));
  const after = applyReport(run, 'build', report, { now: NOW });
  assert.deepEqual(applyReport(after, 'build', report, { now: '2026-11-20' }), after);
});

test('failed review routes feedback into fresh work and exhausts the configured attempt budget', () => {
  let run = make({ nodes: graph(['build']), maxAttempts: 2 });
  for (let attempt = 1; attempt <= 2; attempt++) {
    run = claimNode(run, 'build', { nonce: nonce(), now: NOW });
    run = applyReport(run, 'build', result(run, 'build'), { now: NOW });
    run = claimNode(run, 'build', { phase: 'review', nonce: nonce(), now: NOW });
    run = applyReport(run, 'build', result(run, 'build', 'failed', { summary: '복원 결제 검증이 누락되었습니다.' }), { now: NOW });
    assert.equal(run.nodes[0].attempts, attempt);
  }
  assert.equal(run.nodes[0].status, 'failed');
  assert.equal(run.status, 'blocked');
  assert.equal(nextActions(run).length, 0);
  assert.throws(() => retryNode(run, 'build'), thrown('attempt_limit'));
});

test('test failures invalidate build and downstream evidence, with a bounded repair loop', () => {
  let run = make({ nodes: graph(['build', [], true], ['test', ['build']], ['listing', ['test']]), maxRepairLoops: 1, maxAttempts: 4 });
  run = complete(run, 'build');
  run = claimNode(run, 'test', { nonce: nonce(), now: NOW });
  run = applyReport(run, 'test', result(run, 'test', 'failed', { summary: '로그인 시 크래시가 재현되었습니다.' }), { now: NOW });
  assert.equal(run.repairLoops, 1);
  assert.equal(run.nodes[0].status, 'pending');
  assert.equal(run.nodes[0].feedback.summary, '로그인 시 크래시가 재현되었습니다.');
  assert.equal(run.nodes[1].status, 'pending');
  assert.equal(run.nodes[2].status, 'pending');
  run = complete(run, 'build');
  run = claimNode(run, 'test', { nonce: nonce(), now: NOW });
  run = applyReport(run, 'test', result(run, 'test', 'failed'), { now: NOW });
  assert.equal(run.repairLoops, 1);
  assert.equal(run.nodes[1].status, 'failed');
  assert.equal(nextActions(run).length, 0);
});

test('publication approval applies only when dependencies pass and does not bypass review', () => {
  let run = make({ nodes: graph(['listing'], ['internal', ['listing']], ['release', ['internal']]) });
  assert.throws(() => approveNode(run, 'internal'), thrown('not_ready'));
  run = complete(run, 'listing');
  assert.equal(run.nodes[1].status, 'awaiting-approval');
  assert.deepEqual(nextActions(run), []);
  run = approveNode(run, 'internal', { note: '내부 테스트 트랙 제출 승인', now: NOW });
  assert.equal(nextActions(run)[0].nodeId, 'internal');
  run = complete(run, 'internal');
  assert.equal(run.nodes[2].status, 'awaiting-approval');
  assert.equal(run.status, 'ready');
  run = approveNode(run, 'release', { now: NOW });
  run = complete(run, 'release');
  assert.equal(run.status, 'completed');
});

test('pausing preserves active reservations and reports do not silently resume dispatch', () => {
  let run = make({ nodes: graph(['a'], ['b', ['a']]) });
  run = claimNode(run, 'a', { nonce: nonce(), now: NOW });
  const report = result(run, 'a');
  run = pauseRun(run, { now: NOW });
  assert.equal(run.nodes[0].active.nonce, report.nonce);
  run = applyReport(run, 'a', report, { now: NOW });
  assert.equal(run.status, 'paused');
  assert.deepEqual(nextActions(run), []);
  run = resumeRun(run, { now: NOW });
  assert.equal(nextActions(run)[0].phase, 'review');
});

test('approval and failed reports preserve paused state', () => {
  let run = make({ nodes: graph(['internal']) });
  run = pauseRun(run, { now: NOW });
  run = approveNode(run, 'internal', { now: NOW });
  assert.equal(run.status, 'paused');
  run = resumeRun(run, { now: NOW });
  run = claimNode(run, 'internal', { nonce: nonce(), now: NOW });
  run = pauseRun(run, { now: NOW });
  run = applyReport(run, 'internal', result(run, 'internal', 'failed'), { now: NOW });
  assert.equal(run.status, 'paused');
  assert.equal(run.nodes[0].status, 'awaiting-approval');
});

test('restart keeps proven live tasks and blocks unknown launch receipts without duplicate dispatch', () => {
  let run = make({ nodes: graph(['a'], ['b']), maxConcurrency: 2 });
  run = claimNode(run, 'a', { nonce: nonce(), now: NOW });
  const unknownNonce = nonce();
  run = claimNode(run, 'b', { nonce: unknownNonce, now: NOW });
  run = recordLaunch(run, 'a', { nonce: run.nodes[0].active.nonce, terminalId: 'term-live', now: NOW });
  run = recoverRun(run, ['term-live'], { now: NOW });
  assert.equal(run.nodes[0].active.terminalId, 'term-live');
  assert.equal(run.nodes[1].status, 'blocked');
  assert.equal(run.nodes[1].interrupted.nonce, unknownNonce);
  assert.equal(nextActions(run).length, 0);
  run = retryNode(run, 'b', { now: NOW });
  assert.deepEqual(nextActions(run).map(item => item.nodeId), ['b']);
  assert.throws(() => applyReport(run, 'b', {
    runId: run.id, nodeId: 'b', phase: 'work', nonce: unknownNonce,
    outcome: 'passed', summary: 'old', evidence: [{ kind: 'note', text: 'old terminal output' }],
  }), thrown('stale_report'));
});

test('blocked reviews resume independent review without rerunning accepted work', () => {
  let run = make({ nodes: graph(['a']) });
  run = claimNode(run, 'a', { nonce: nonce(), now: NOW });
  run = applyReport(run, 'a', result(run, 'a'), { now: NOW });
  run = claimNode(run, 'a', { phase: 'review', nonce: nonce(), now: NOW });
  run = blockNode(run, 'a', { reason: '검토 에이전트가 권한을 기다립니다.', now: NOW });
  assert.equal(run.nodes[0].status, 'blocked');
  run = pauseRun(run, { now: NOW });
  run = retryNode(run, 'a', { now: NOW });
  assert.equal(run.status, 'paused');
  assert.equal(run.nodes[0].status, 'review');
  assert.equal(run.nodes[0].attempts, 1);
  run = resumeRun(run, { now: NOW });
  assert.equal(nextActions(run)[0].phase, 'review');
});

test('audit: repeated blocking preserves the review phase and retries review only', () => {
  let run = make({ nodes: graph(['a']) });
  run = claimNode(run, 'a', { nonce: nonce(), now: NOW });
  run = applyReport(run, 'a', result(run, 'a'), { now: NOW });
  run = claimNode(run, 'a', { phase: 'review', nonce: nonce(), now: NOW });
  run = blockNode(run, 'a', { reason: 'Missing review receipt', now: NOW });
  run = blockNode(run, 'a', { reason: 'Still missing review receipt', now: NOW });
  assert.equal(run.nodes[0].blockedPhase, 'review');
  run = retryNode(run, 'a', { now: NOW });
  assert.equal(run.nodes[0].status, 'review');
  assert.equal(run.nodes[0].attempts, 1);
  assert.equal(nextActions(run)[0].phase, 'review');
});

test('cancellation preserves terminal identity for audit and never resumes', () => {
  let run = make({ nodes: graph(['a']) });
  run = claimNode(run, 'a', { nonce: nonce(), now: NOW });
  run = recordLaunch(run, 'a', { nonce: run.nodes[0].active.nonce, terminalId: 'terminal-stop', now: NOW });
  run = cancelRun(run, { now: NOW });
  assert.equal(run.status, 'cancelled');
  assert.equal(run.nodes[0].active, null);
  assert.equal(run.nodes[0].interrupted.terminalId, 'terminal-stop');
  assert.deepEqual(nextActions(run), []);
  assert.throws(() => resumeRun(run), thrown('cancelled'));
});

test('Korea calendar day boundaries and no-yesterday summaries never invent history', () => {
  assert.equal(dateKey('2026-11-18T14:59:59.999Z'), '2026-11-18');
  assert.equal(dateKey('2026-11-18T15:00:00.000Z'), '2026-11-19');
  const old = make({ id: 'older', now: '2026-11-16T16:00:00.000Z', nodes: graph(['a']) });
  const fresh = make({ id: 'today', now: '2026-11-18T16:00:00.000Z', nodes: graph(['b']) });
  const summary = dailySnapshot([old, fresh], { now: '2026-11-18T16:00:00.000Z' });
  assert.equal(summary.date, '2026-11-19');
  assert.equal(summary.yesterdayDate, '2026-11-18');
  assert.equal(summary.hasYesterday, false);
  assert.equal(summary.yesterday.length, 0);
  assert.equal(summary.lastActiveDay, '2026-11-17');
  assert.equal(summary.lastActive[0].runId, 'older');
  assert.equal(summary.today[0].runId, 'today');
  assert.equal(summary.next.length, 2);
  assert.throws(() => dailySnapshot([], { date: '2026-02-30' }), thrown('invalid_date'));
});

test('snapshot exposes last verified step and the actual blocking reason', () => {
  let run = make({ nodes: graph(['a'], ['b', ['a']]) });
  run = complete(run, 'a');
  run = claimNode(run, 'b', { nonce: nonce(), now: NOW });
  run = applyReport(run, 'b', result(run, 'b', 'blocked', {
    summary: '테스트 기기가 연결되어 있지 않습니다.', next: '기기를 연결하고 ADB 확인 후 재시도',
  }), { now: NOW });
  const summary = dailySnapshot([run], { now: NOW });
  assert.equal(summary.next[0].verified.nodeId, 'a');
  assert.match(summary.next[0].why, /기기/);
  assert.match(summary.next[0].next, /ADB/);
  assert.equal(summary.next[0].state, 'blocked');
});

test('releasing an unstarted claim refunds the attempt and returns the stage to its phase', () => {
  let run = make({ nodes: graph(['a']) });
  const claim = nonce();
  run = claimNode(run, 'a', { nonce: claim, now: NOW });
  const released = releaseClaim(run, 'a', { nonce: claim, reason: '지시가 전달되지 않았습니다.', now: NOW });
  const node = released.nodes[0];
  assert.equal(node.status, 'pending');
  assert.equal(node.attempts, 0);
  assert.equal(node.active, null);
  assert.equal(released.events.at(-1).type, 'task.redispatch');
  assert.deepEqual(nextActions(released).map(action => action.nodeId), ['a']);
  assert.equal(run.nodes[0].attempts, 1, 'the input run is not mutated');
});

test('releasing a claim refuses a stale nonce', () => {
  let run = make({ nodes: graph(['a']) });
  run = claimNode(run, 'a', { nonce: nonce(), now: NOW });
  assert.throws(() => releaseClaim(run, 'a', { nonce: 'other', reason: 'x', now: NOW }), thrown('stale_report'));
});

test('ECC is automatic unless an assignment pins an installed-style agent or turns ECC off', () => {
  const run = make({ assignments: { build: { eccAgent: 'ecc:typescript-reviewer' }, assets: { eccAgent: 'none' }, brief: { eccAgent: '' } } });
  const field = id => run.nodes.find(node => node.id === id);
  assert.equal(Object.hasOwn(field('research'), 'eccAgent'), false, 'no field means automatic');
  assert.equal(Object.hasOwn(field('brief'), 'eccAgent'), false);
  assert.equal(field('build').eccAgent, 'ecc:typescript-reviewer');
  assert.ok(ECC_AGENT_PATTERN.test(field('build').eccAgent));
  assert.equal(field('assets').eccAgent, 'none');
  assert.throws(() => make({ assignments: { build: { eccAgent: 'ecc:x"; drop the prompt' } } }), thrown('invalid_input'));
});

test('a note evidence written with a note field instead of text is accepted as its text', () => {
  let run = make({ nodes: graph(['a']) });
  run = claimNode(run, 'a', { nonce: nonce(), now: NOW });
  const report = result(run, 'a', 'passed', { evidence: [{ kind: 'artifact', path: 'artifacts/a.md' }, { kind: 'note', note: 'ECC: ecc:planner로 범위 정리' }] });
  run = applyReport(run, 'a', report, { now: NOW });
  assert.equal(run.nodes[0].report.evidence[1].text, 'ECC: ecc:planner로 범위 정리');
  run = make({ nodes: graph(['b']) });
  run = claimNode(run, 'b', { nonce: nonce(), now: NOW });
  assert.throws(() => applyReport(run, 'b', result(run, 'b', 'passed', { evidence: [{ kind: 'artifact', path: 'x' }, { kind: 'note' }] }), { now: NOW }), thrown('invalid_input'));
});

const passWith = (id, evidence) => {
  let run = make({ nodes: graph([id]) });
  run = claimNode(run, id, { nonce: nonce(), now: NOW });
  return () => applyReport(run, id, result(run, id, 'passed', { evidence }), { now: NOW });
};
const artifact = { kind: 'artifact', path: 'artifacts/x.md' };

test('a failed first try kept as history does not sink a pass that a later successful command supports', () => {
  const run = passWith('a', [
    { kind: 'command', command: "ffmpeg -vf 'drawtext…' (실패, 재실행)", exitCode: 8 },
    { kind: 'command', command: "ffmpeg -vf 'fps=1'", exitCode: 0 }, artifact])();
  const [history, check] = run.nodes[0].report.evidence;
  assert.equal(run.nodes[0].status, 'review');
  assert.deepEqual([history.role, history.exitCode, check.exitCode], ['history', 8, 0]);
});

test('exit codes given as numeric strings are compared as numbers', () => {
  const run = passWith('b', [{ kind: 'command', command: 'a', exitCode: '8', role: 'history' }, { kind: 'command', command: 'b', exitCode: '0' }, artifact])();
  assert.deepEqual(run.nodes[0].report.evidence.slice(0, 2).map(item => item.exitCode), [8, 0]);
  assert.throws(passWith('c', [{ kind: 'command', command: 'x', exitCode: 'zero' }, artifact]), thrown('invalid_evidence'));
  assert.throws(passWith('d', [{ kind: 'command', command: 'x', exitCode: '0', role: 'maybe' }, artifact]), thrown('invalid_evidence'));
});

test('a pass is refused when its only command evidence failed or a command marked as the check failed', () => {
  assert.throws(passWith('e', [{ kind: 'command', command: 'npm test', exitCode: 1 }, artifact]), thrown('contradictory_evidence'));
  assert.throws(passWith('f', [{ kind: 'command', command: 'npm test', exitCode: '1' }, artifact]), thrown('contradictory_evidence'));
  assert.throws(passWith('g', [{ kind: 'command', command: 'npm test', exitCode: 1, role: 'check' }, { kind: 'command', command: 'ls', exitCode: 0 }, artifact]), thrown('contradictory_evidence'));
  // Explicit history with artifact support is fine even without a successful command.
  assert.equal(passWith('h', [{ kind: 'command', command: 'old try', exitCode: 2, role: 'history' }, artifact])().nodes[0].status, 'review');
});

test('a check whose expected result is a non-zero exit passes when it says so (diff, absent files)', () => {
  // The entries that sank A live run's brief attempt 3 twice, now stated with their expected exit code.
  const run = passWith('i', [
    { kind: 'command', command: 'diff 3-work-43040fa1/task-prompt.md task-prompt.md (1은 다름을 뜻하는 정상 결과)', exitCode: 1, expectedExitCode: 1, role: 'check' },
    { kind: 'command', command: 'ls AGENTS.md CLAUDE.md (없음 확인)', exitCode: 2, expectedExitCode: '2', role: 'check' },
    { kind: 'command', command: 'node reachability-check.js', exitCode: 0, role: 'check' }, artifact])();
  assert.equal(run.nodes[0].status, 'review');
  assert.deepEqual(run.nodes[0].report.evidence.slice(0, 2).map(item => item.expectedExitCode), [1, 2]);
  assert.throws(passWith('j', [{ kind: 'command', command: 'diff a b', exitCode: 1, expectedExitCode: 0, role: 'check' }, artifact]), thrown('contradictory_evidence'));
  assert.throws(passWith('k', [{ kind: 'command', command: 'diff a b', exitCode: 1, expectedExitCode: 'one' }, artifact]), thrown('invalid_evidence'));
});

test('a refused check names the entry, its command and how to state an expected non-zero exit', () => {
  try {
    passWith('l', [
      { kind: 'command', command: 'cp -p brief.md task-prompt.md', exitCode: 0 },
      { kind: 'command', command: 'diff 1-work/brief.md 3-work/brief.md (의도한 절만 변경 확인)', exitCode: 1, role: 'check' }, artifact])();
    assert.fail('should refuse');
  } catch (error) {
    assert.equal(error.code, 'contradictory_evidence');
    assert.match(error.message, /evidence\[1\]/);
    assert.match(error.message, /diff 1-work/);
    assert.match(error.message, /expectedExitCode/);
  }
});

test('review follow-ups are kept as a short list of text; any other shape is a form error', () => {
  const run = passWith('m', [{ kind: 'command', command: 'grep', exitCode: 0 }, artifact]);
  let ok = make({ nodes: graph(['n']) });
  ok = claimNode(ok, 'n', { nonce: nonce(), now: NOW });
  const passed = applyReport(ok, 'n', result(ok, 'n', 'passed', { evidence: [artifact], followUps: [' B8 경로는 구현 테스트로 확인 ', 'J3 문구'] }), { now: NOW });
  assert.deepEqual(passed.nodes[0].report.followUps, ['B8 경로는 구현 테스트로 확인', 'J3 문구']);
  assert.equal(run().nodes[0].report.followUps, undefined);
  let bad = make({ nodes: graph(['o']) });
  bad = claimNode(bad, 'o', { nonce: nonce(), now: NOW });
  assert.throws(() => applyReport(bad, 'o', result(bad, 'o', 'passed', { evidence: [artifact], followUps: 'one string' }), { now: NOW }), thrown('invalid_report'));
  assert.throws(() => applyReport(bad, 'o', result(bad, 'o', 'passed', { evidence: [artifact], followUps: Array(13).fill('x') }), { now: NOW }), thrown('invalid_report'));
});

// Flow templates: the new-app graph and the improvement graph for an existing, shipped app.
import { templateGraph, IMPROVE_GRAPH, IMPROVEMENT_AREAS } from '../src/engine.mjs';
const ids = (nodes) => nodes.map(node => node.id);
const depsOf = (nodes, id) => nodes.find(node => node.id === id)?.deps;

test('templates are a validated choice: new-app is the default graph, unknown names and areas are refused', () => {
  assert.deepEqual(templateGraph('new-app'), DEFAULT_GRAPH);
  assert.deepEqual(templateGraph(), DEFAULT_GRAPH);
  assert.throws(() => templateGraph('rewrite'), thrown('invalid_input'));
  assert.throws(() => templateGraph('improve', { areas: [] }), thrown('invalid_input'));
  assert.throws(() => templateGraph('improve', { areas: ['design', 'design'] }), thrown('invalid_input'));
  assert.throws(() => templateGraph('improve', { areas: ['crypto'] }), thrown('invalid_input'));
  assert.deepEqual([...IMPROVEMENT_AREAS], ['design', 'features', 'payments']);
});

test('the improvement graph keeps design and payment stages only for the areas chosen', () => {
  const features = templateGraph('improve', { areas: ['features'] });
  assert.deepEqual(ids(features), ['audit', 'plan', 'build', 'test', 'policy', 'listing', 'internal', 'release']);
  assert.deepEqual(depsOf(features, 'build'), ['plan']);
  assert.deepEqual(depsOf(features, 'test'), ['build']);
  assert.deepEqual(depsOf(features, 'internal'), ['listing']);
  const all = templateGraph('improve', { areas: ['payments', 'design', 'features'] });
  assert.deepEqual(ids(all), ids(IMPROVE_GRAPH));
  assert.deepEqual(depsOf(all, 'build'), ['plan', 'assets']);
  assert.deepEqual(depsOf(all, 'test'), ['build', 'monetization']);
  assert.deepEqual(depsOf(all, 'internal'), ['listing', 'catalog']);
  const payments = templateGraph('improve', { areas: ['payments'] });
  assert.deepEqual(ids(payments), ['audit', 'plan', 'build', 'monetization', 'test', 'policy', 'listing', 'catalog', 'internal', 'release']);
  for (const nodes of [features, all, payments]) {
    const run = make({ nodes });
    assert.equal(run.nodes.length, nodes.length, 'every gated graph is a valid run graph');
  }
});

test('the product catalog stage is an approval only a person can give', () => {
  const run = make({ nodes: templateGraph('improve', { areas: ['payments'] }) });
  const catalog = run.nodes.find(node => node.id === 'catalog');
  assert.equal(catalog.requiresApproval, true);
  assert.equal(catalog.humanApproval, true);
  assert.equal(run.nodes.find(node => node.id === 'internal').humanApproval, undefined);
});

test('a monetization report may carry the proposed Play products; their shape is checked', () => {
  let run = make({ nodes: graph(['monetization']) });
  run = claimNode(run, 'monetization', { nonce: nonce(), now: NOW });
  const ok = applyReport(run, 'monetization', result(run, 'monetization', 'passed', { evidence: [{ kind: 'artifact', path: 'a.md' }],
    products: [{ productId: 'premium_unlock', type: 'inapp', price: '₩3,900', title: '프리미엄' }, { productId: 'pro.monthly', type: 'subs', price: '₩2,900/월', basePlanId: 'monthly' }] }), { now: NOW });
  assert.deepEqual(ok.nodes[0].report.products.map(item => item.productId), ['premium_unlock', 'pro.monthly']);
  for (const products of ['premium', [{ productId: 'Premium', type: 'inapp', price: '1' }], [{ productId: 'a', type: 'consumable', price: '1' }],
    [{ productId: 'a', type: 'inapp' }], [{ productId: 'a', type: 'inapp', price: '1' }, { productId: 'a', type: 'inapp', price: '2' }]]) {
    assert.throws(() => applyReport(run, 'monetization', result(run, 'monetization', 'passed', { evidence: [{ kind: 'artifact', path: 'a.md' }], products }), { now: NOW }),
      thrown('invalid_report'), JSON.stringify(products));
  }
});
