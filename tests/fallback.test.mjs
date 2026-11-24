import test from 'node:test';
import assert from 'node:assert/strict';
import { moveAway, restoreAgent, usableAgain, visualFallbacks } from '../src/fallback.mjs';
import { planAutonomy, createSupervisor } from '../src/autonomy.mjs';

const AT = '2026-11-24T05:00:00.000Z';
const LATER = '2026-11-24T05:30:00.000Z';
const node = (id, extra = {}) => ({ id, title: id, deps: [], status: 'pending', attempts: 0, reviewAttempts: 0, active: null, agent: 'codex', reviewer: 'claude', ...extra });
const run = (nodes, extra = {}) => ({ id: 'r', status: 'running', autonomous: true, started: true, nodes, events: [], jobs: [], ...extra });
const REASON = 'codex가 시작 화면의 "Hooks need review"에서 멈췄습니다.';

test('moving away from the image agent records it on each design or assets stage and on the run, and remembers the original', () => {
  // Arrange
  const subject = run([node('design', { status: 'blocked', attempts: 1 }), node('assets'), node('build', { agent: 'claude', reviewer: 'codex' }), node('research', { status: 'passed' })]);

  // Act
  const moved = moveAway(subject, 'codex', 'claude', { at: AT, reason: REASON });

  // Assert
  assert.deepEqual(moved, ['design', 'assets', 'build 검토']);
  assert.deepEqual(subject.nodes.map((item) => [item.agent, item.reviewer]), [['claude', 'claude'], ['claude', 'claude'], ['claude', 'claude'], ['codex', 'claude']]);
  assert.deepEqual(subject.nodes[0].original, { agent: 'codex' });
  assert.deepEqual(subject.nodes[2].original, { reviewer: 'codex' });
  assert.deepEqual(subject.nodes[0].fallback, { from: 'codex', to: 'claude', at: AT, reason: REASON });
  assert.equal(subject.nodes[2].fallback, undefined, 'only image stages lose a capability');
  assert.equal(subject.avoided.codex.at, AT);
  assert.deepEqual(subject.fallbacks.at(-1), { agent: 'codex', to: 'claude', at: AT, reason: REASON, stages: ['design', 'assets', 'build 검토'] });
});

test('when the agent is usable again, only stages not yet started go back to their original assignment', () => {
  // Arrange: design already ran on the fallback; assets has not started; build's review is running
  const subject = run([node('design'), node('assets'), node('build', { agent: 'claude', reviewer: 'codex', status: 'review' })]);
  moveAway(subject, 'codex', 'claude', { at: AT, reason: REASON });
  subject.nodes[0].status = 'passed';
  subject.nodes[2].active = { phase: 'review', nonce: 'live' };

  // Act
  const restored = restoreAgent(subject, 'codex', { at: LATER, why: '다른 실행에서 codex가 작업을 시작함' });

  // Assert
  assert.deepEqual(restored, ['assets']);
  assert.deepEqual(subject.nodes.map((item) => item.agent), ['claude', 'codex', 'claude']);
  assert.equal(subject.nodes[2].reviewer, 'claude', 'a running review stays on its agent');
  assert.equal(subject.nodes[1].fallback, undefined, 'assets will run on the image agent after all');
  assert.ok(subject.nodes[0].fallback, 'design was made on the fallback and stays marked');
  assert.equal(subject.avoided?.codex, undefined);
  assert.equal(subject.fallbacks.at(-1).restored, true);
  assert.deepEqual(visualFallbacks(subject).map((item) => item.id), ['design']);
});

test('usable again means a job on that agent started work after it was avoided, in any run', () => {
  // Arrange
  const subject = run([node('design')], { avoided: { codex: { at: AT } } });
  const before = { agent: 'codex', promptSeen: true, startedAt: '2026-11-24T04:00:00.000Z' };
  const unstarted = { agent: 'codex', startedAt: LATER };
  const worked = { agent: 'codex', promptSeen: true, startedAt: LATER };

  // Act + Assert
  assert.equal(usableAgain(subject, 'codex', [before, unstarted]), false);
  assert.equal(usableAgain(subject, 'codex', [worked]), true);
  assert.equal(usableAgain(run([node('design')]), 'codex', [worked]), false, 'nothing avoided, nothing to restore');
});

test('autonomy plans a restore when another run shows the avoided agent working again, and the supervisor applies it with an event', async () => {
  // Arrange
  const subject = run([node('design'), node('assets')]);
  moveAway(subject, 'codex', 'claude', { at: AT, reason: REASON });
  const jobs = [{ agent: 'codex', promptSeen: true, startedAt: LATER }];
  let stored = subject;
  const events = [];
  const supervisor = createSupervisor({ getRun: () => structuredClone(stored), replaceRun: (next) => { stored = next; }, retryStage: async (next) => next,
    appendEvent: (_run, text) => events.push(text), notify: () => {}, now: () => Date.parse(LATER), allJobs: () => jobs });

  // Act
  const actions = planAutonomy(subject, { jobs });
  await supervisor.supervise('r');

  // Assert
  assert.deepEqual(actions.map((action) => action.type), ['restore']);
  assert.deepEqual(stored.nodes.map((item) => item.agent), ['codex', 'codex']);
  assert.match(events.join('\n'), /codex를 다시 씁니다/);
  assert.match(events.join('\n'), /design, assets/);
});

test('autonomy\'s switch away from a stuck image agent keeps going and records the fallback', async () => {
  // Arrange: design stuck on codex's hook review screen
  const design = node('design', { status: 'blocked', attempts: 1, pendingReceipt: { nonce: 'j1' }, failureReason: REASON });
  let stored = run([design, node('assets')], { jobs: [{ nonce: 'j1', phase: 'work', agent: 'codex', blocker: { kind: 'hook-review', agent: 'codex' } }], maxAttempts: 3 });
  const supervisor = createSupervisor({ getRun: () => structuredClone(stored), replaceRun: (next) => { stored = next; },
    retryStage: async (next, nodeId) => { const item = next.nodes.find((entry) => entry.id === nodeId); item.status = 'pending'; delete item.pendingReceipt; return next; },
    appendEvent: () => {}, notify: () => {}, now: () => Date.parse(AT), allJobs: () => [] });

  // Act
  await supervisor.supervise('r');

  // Assert
  assert.deepEqual(stored.nodes.map((item) => item.agent), ['claude', 'claude']);
  assert.equal(stored.nodes[0].fallback.from, 'codex');
  assert.equal(stored.nodes[1].fallback.from, 'codex');
  assert.equal(stored.fallbacks.length, 1);
  assert.equal(stored.autonomy.stopped, undefined, 'the run keeps going');
});

test('a stage whose work is done and waiting for review keeps its maker and is not marked as a fallback', () => {
  const subject = run([node('design', { status: 'review', attempts: 1 }), node('assets')]);
  const moved = moveAway(subject, 'codex', 'claude', { at: AT, reason: REASON });
  assert.deepEqual(moved, ['assets']);
  assert.equal(subject.nodes[0].agent, 'codex');
  assert.equal(subject.nodes[0].fallback, undefined);
});
