import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, claimNode, applyReport } from '../src/engine.mjs';
import { planAutonomy } from '../src/autonomy.mjs';
import { reviewInstruction, followUpsInstruction } from '../src/proportion.mjs';
import { buildNodePrompt, STAGE_BRIEFS } from '../src/prompt.mjs';

const NOW = '2026-11-24T02:00:00.000Z';
let count = 0;
const nonce = () => 'f-' + (++count);
const graph = [{ id: 'build', title: '앱 구현', deps: [], write: true }, { id: 'test', title: '테스트', deps: ['build'] }];
const make = (extra = {}) => createRun({ id: 'run-f', goal: '카드 게임', now: NOW, nodes: graph, ...extra });
const reportFor = (run, id, outcome, extra = {}) => {
  const active = run.nodes.find((node) => node.id === id).active;
  return { runId: run.id, nodeId: id, phase: active.phase, nonce: active.nonce, attempt: active.attempt, outcome, summary: id + ' ' + outcome,
    evidence: [{ kind: 'artifact', path: 'a/' + id + '.md' }], ...extra };
};
function toReview(run, id = 'build') {
  run = claimNode(run, id, { nonce: nonce(), now: NOW });
  run = applyReport(run, id, reportFor(run, id, 'passed'), { now: NOW });
  return claimNode(run, id, { phase: 'review', nonce: nonce(), now: NOW });
}
const node = (run, id) => run.nodes.find((item) => item.id === id);
const thrown = (code) => (error) => error.code === code;
const LATER = { text: '설정 화면 문구를 다듬기', class: 'later' };
const DEFECT = { text: '덱이 비면 게임이 멈춤', class: 'defect', criterion: '한 판을 끝까지 진행할 수 있다' };

test('a passed review whose follow-ups are all "later" passes and passes them on as plain text', () => {
  // Arrange
  const run = toReview(make());

  // Act
  const passed = applyReport(run, 'build', reportFor(run, 'build', 'passed', { followUps: [LATER] }), { now: NOW });

  // Assert
  assert.equal(node(passed, 'build').status, 'passed');
  assert.deepEqual(node(passed, 'build').review.followUps, ['설정 화면 문구를 다듬기']);
  assert.equal(node(passed, 'build').review.followUpDefects, undefined);
});

test('a follow-up that breaks a completion criterion fails the review now as a code defect and repairs this stage', () => {
  // Arrange
  const run = toReview(make());

  // Act
  const failed = applyReport(run, 'build', reportFor(run, 'build', 'passed', { followUps: [LATER, DEFECT] }), { now: NOW });

  // Assert
  const build = node(failed, 'build');
  const review = build.history.at(-1);
  assert.equal(review.outcome, 'failed');
  assert.equal(review.failureClass, 'code');
  assert.deepEqual(review.followUpDefects, [{ text: DEFECT.text, criterion: DEFECT.criterion }]);
  assert.deepEqual(review.followUps, [LATER.text]);
  assert.match(review.summary, /한 판을 끝까지/);
  assert.equal(build.feedback.failureClass, 'code', 'the repair brief carries the defect');
  assert.equal(build.status, 'pending', 'the same stage is redone, not the next one');
  assert.equal(node(failed, 'test').status, 'pending');
  assert.equal(node(failed, 'test').attempts, 0, 'test never ran on the defective build');
});

test('review follow-ups must be classified, and a defect must name the criterion it breaks', () => {
  for (const followUps of [['그냥 문자열'], [{ text: 'x', class: 'maybe' }], [{ text: 'x', class: 'defect' }], [{ class: 'later' }]]) {
    const run = toReview(make());
    assert.throws(() => applyReport(run, 'build', reportFor(run, 'build', 'passed', { followUps }), { now: NOW }), thrown('invalid_report'), JSON.stringify(followUps));
  }
});

test('a work report may still list follow-ups as plain text', () => {
  // Arrange
  let run = claimNode(make(), 'build', { nonce: nonce(), now: NOW });

  // Act
  run = applyReport(run, 'build', reportFor(run, 'build', 'passed', { followUps: ['다음 버전: 사운드'] }), { now: NOW });

  // Assert
  assert.deepEqual(node(run, 'build').report.followUps, ['다음 버전: 사운드']);
});

test('a failed test names the completion criterion it breaks, or the report is refused', () => {
  // Arrange
  let run = toReview(make());
  run = applyReport(run, 'build', reportFor(run, 'build', 'passed'), { now: NOW });
  run = claimNode(run, 'test', { nonce: nonce(), now: NOW });

  // Act + Assert
  assert.throws(() => applyReport(run, 'test', reportFor(run, 'test', 'failed'), { now: NOW }), thrown('invalid_report'));
  const repaired = applyReport(run, 'test', reportFor(run, 'test', 'failed', { criteria: [{ criterion: '한 판을 끝까지 진행할 수 있다', met: false, evidence: 'flutter test: deck_test 실패' }] }), { now: NOW });
  assert.equal(repaired.repairLoops, 1);
  const external = applyReport(run, 'test', reportFor(run, 'test', 'blocked'), { now: NOW });
  assert.equal(node(external, 'test').status, 'blocked', 'a blocked test needs no broken criterion');
});

test('autonomy redoes the stage work, not its review, after a review failed on a classified defect at the attempt limit', () => {
  // Arrange: a review fails on a defect at the last attempt
  let run = make({ maxAttempts: 1 });
  run.autonomous = true;
  run = toReview(run);
  run = applyReport(run, 'build', reportFor(run, 'build', 'passed', { followUps: [DEFECT] }), { now: NOW });
  run.autonomous = true;

  // Act
  const [action] = planAutonomy(run);

  // Assert
  assert.equal(node(run, 'build').status, 'failed');
  assert.deepEqual([action.type, action.nodeId, action.field], ['retry', 'build', 'agent']);
  assert.match(action.reason, /한 판을 끝까지/);
});

test('the review brief explains the classification and the test brief cites criteria and ignores later follow-ups', () => {
  // Arrange
  const run = make();
  node(run, 'build').status = 'passed';
  node(run, 'build').review = { outcome: 'passed', followUps: [LATER.text] };

  // Act
  const strict = reviewInstruction({ id: 'build' });
  const doc = reviewInstruction({ id: 'brief' });
  const carried = followUpsInstruction(run, node(run, 'test'));

  // Assert
  for (const text of [strict, doc]) {
    assert.match(text, /"class": "defect"/);
    assert.match(text, /"criterion"/);
    assert.match(text, /"later"/);
  }
  assert.match(carried, /완료 조건이 아닙니다/);
  assert.match(STAGE_BRIEFS.test, /criteria/);
  assert.match(STAGE_BRIEFS.test, /완료 조건/);
  const job = { runId: run.id, nodeId: 'build', nonce: 'n', attempt: 1, phase: 'review', agent: 'claude', receiptDirectory: '/r', receiptPath: '/r/result.json', sourceFingerprint: 'fp' };
  assert.match(buildNodePrompt({ ...run, workspacePath: '/w' }, node(run, 'build'), job), /followUps/);
});

test('an agent-written followUpDefects is ignored, and a failed review may keep plain follow-up text', () => {
  // Arrange
  const forged = toReview(make());
  const failing = toReview(make());

  // Act
  const passed = applyReport(forged, 'build', reportFor(forged, 'build', 'passed', { followUpDefects: 'oops' }), { now: NOW });
  const failed = applyReport(failing, 'build', reportFor(failing, 'build', 'failed', { failureClass: 'code', followUps: ['버튼 위치'] }), { now: NOW });

  // Assert
  assert.equal(node(passed, 'build').status, 'passed');
  assert.equal(node(passed, 'build').review.followUpDefects, undefined);
  assert.deepEqual(node(failed, 'build').history.at(-1).followUps, ['버튼 위치']);
});
