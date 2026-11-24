import test from 'node:test';
import assert from 'node:assert/strict';
import { refundAttempts, planManualRefund } from '../src/refund.mjs';

const AT = '2026-11-24T10:30:00.000Z';
// The live run's design stage: three codex attempts stuck on the hook-review modal, attempts 3/3.
function stuckRun(jobs = {}) {
  const base = (nonce, attempt, state) => ({ nodeId: 'design', nonce, phase: 'work', attempt, agent: 'codex', state, receiptPath: '/runs/r/design/' + nonce + '/result.json' });
  return {
    maxAttempts: 3,
    nodes: [{ id: 'design', title: '화면 설계', status: 'blocked', blockedPhase: 'work', attempts: 3, reviewAttempts: 0, report: null }],
    jobs: [
      { ...base('n1', 1, 'superseded'), promptSeen: true, ...jobs.n1 },
      { ...base('n2', 2, 'superseded'), promptSeen: true, ...jobs.n2 },
      { ...base('n3', 3, 'uncertain'), ...jobs.n3 },
      { nodeId: 'brief', nonce: 'b1', phase: 'work', attempt: 1, state: 'complete', sessionId: 's-b1' },
    ],
  };
}
const noWork = async () => null;

test('refundAttempts gives back one attempt per job of the right phase and marks each job, without touching the input', () => {
  // Arrange
  const run = stuckRun();
  // Act
  const { run: next, count } = refundAttempts(run, 'design', ['n1', 'n3'], { at: AT, reason: '시작 안 함' });
  // Assert
  assert.equal(count, 2);
  assert.equal(next.nodes[0].attempts, 1);
  assert.deepEqual(next.jobs[0].refunded, { at: AT, reason: '시작 안 함' });
  assert.equal(run.nodes[0].attempts, 3, 'the input run is not mutated');
  assert.equal(refundAttempts(next, 'design', ['n1'], { at: AT, reason: 'again' }).count, 0, 'a job is refunded once');
});

test('a review job refunds a review attempt', () => {
  const run = stuckRun({ n3: { phase: 'review' } });
  run.nodes[0].reviewAttempts = 2;
  assert.equal(refundAttempts(run, 'design', ['n3'], { at: AT, reason: 'x' }).run.nodes[0].reviewAttempts, 1);
});

test('a stage at its limit whose attempts show no work gets all of them back, once', async () => {
  // Act
  const plan = await planManualRefund(stuckRun(), 'design', { evidenceOf: noWork });
  // Assert: promptSeen alone is not work (Orca's prompt-submit hook sets it inside the Codex modal).
  assert.deepEqual(plan.nonces, ['n1', 'n2', 'n3']);
  const refunded = refundAttempts(stuckRun(), 'design', plan.nonces, { at: AT, reason: 'r', manual: true }).run;
  assert.ok(refunded.nodes[0].attemptRefund);
  // Three more attempts after the refund fail the same way: the second refund is refused.
  const again = { ...refunded, nodes: [{ ...refunded.nodes[0], attempts: 3 }], jobs: [...refunded.jobs, { nodeId: 'design', nonce: 'n4', phase: 'work', state: 'superseded' }] };
  assert.match((await planManualRefund(again, 'design', { evidenceOf: noWork })).refused, /한 번/);
});

test('any attempt with evidence of work keeps the limit and names the evidence', async () => {
  const evidenceOf = async (job) => job.nonce === 'n2' ? 'sessionId s-2' : null;
  const plan = await planManualRefund(stuckRun(), 'design', { evidenceOf });
  assert.equal(plan.nonces, undefined);
  assert.match(plan.refused, /n2.*sessionId s-2/);
});

test('a stage below its limit, finished attempts, or attempts already refunded need no manual refund', async () => {
  const below = stuckRun();
  below.nodes[0].attempts = 2;
  assert.equal(await planManualRefund(below, 'design', { evidenceOf: noWork }), null);
  const done = stuckRun({ n1: { state: 'complete' }, n2: { state: 'undelivered' }, n3: { refunded: { at: AT } } });
  assert.equal(await planManualRefund(done, 'design', { evidenceOf: noWork }), null);
});

test('an unreadable result folder counts as possible work', async () => {
  const evidenceOf = async () => { throw new Error('EACCES'); };
  assert.match((await planManualRefund(stuckRun(), 'design', { evidenceOf })).refused, /EACCES/);
});

test('resultFiles lists the result folder, treats a missing folder as empty and throws other errors', async () => {
  const { resultFiles } = await import('../src/receipts.mjs');
  const job = { receiptPath: '/runs/r/design/n1/result.json' };
  assert.deepEqual(await resultFiles(job, async (dir) => { assert.equal(dir, '/runs/r/design/n1'); return ['brief.md']; }), ['brief.md']);
  assert.deepEqual(await resultFiles(job, async () => { throw Object.assign(new Error('gone'), { code: 'ENOENT' }); }), []);
  await assert.rejects(resultFiles(job, async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }), /denied/);
});
