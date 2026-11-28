import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, claimNode, applyReport, retryNode, cancelRun, templateGraph } from '../src/engine.mjs';
import { normalizeScope, scopedGraph, skippableStages, skipReleaseStages, RELEASE_STAGES } from '../src/scope.mjs';
import { milestones, milestoneText } from '../src/milestones.mjs';
import { sampleFindings } from './fixtures/research.mjs';
import { sampleTarget } from './fixtures/target.mjs';

const NOW = '2026-11-24T01:00:00.000Z';
let count = 0;
const nonce = () => 'n-' + (++count);
const make = (nodes = templateGraph('new-app')) => createRun({ id: 'run-s', goal: '첫 플레이 가능한 버전', now: NOW, nodes });
const report = (run, id, outcome = 'passed') => {
  const active = run.nodes.find((node) => node.id === id).active;
  return { runId: run.id, nodeId: id, phase: active.phase, nonce: active.nonce, attempt: active.attempt, outcome, summary: id + ' ' + outcome,
    evidence: outcome === 'passed' ? [{ kind: 'artifact', path: 'a/' + id + '.md' }] : [],
    ...(id === 'research' && active.phase === 'work' ? { findings: sampleFindings() } : {}),
    ...(id === 'brief' && active.phase === 'work' ? { target: sampleTarget() } : {}),
    ...(id === 'test' && outcome === 'failed' ? { criteria: [{ criterion: '첫 판을 끝까지 할 수 있다', met: false }] } : {}) };
};
function pass(run, id) {
  run = claimNode(run, id, { nonce: nonce(), now: NOW });
  run = applyReport(run, id, report(run, id), { now: NOW });
  run = claimNode(run, id, { phase: 'review', nonce: nonce(), now: NOW });
  return applyReport(run, id, report(run, id), { now: NOW });
}
const passThrough = (run, ids) => ids.reduce(pass, run);
const BEFORE_RELEASE = ['research', 'brief', 'architecture', 'design', 'assets', 'build', 'test'];
const status = (run, id) => run.nodes.find((node) => node.id === id).status;

test('a playable new app graph ends at test and has no policy, listing, internal or release stage', () => {
  // Arrange
  const full = templateGraph('new-app');

  // Act
  const playable = scopedGraph(full, 'playable');

  // Assert
  assert.deepEqual(playable.map((node) => node.id), BEFORE_RELEASE);
  assert.deepEqual(scopedGraph(full, 'release').map((node) => node.id), full.map((node) => node.id));
  assert.ok(playable.every((node) => node.deps.every((dep) => !RELEASE_STAGES.has(dep))));
});

test('scope defaults to playable and refuses anything but playable or release', () => {
  assert.equal(normalizeScope(undefined), 'playable');
  assert.equal(normalizeScope(''), 'playable');
  assert.equal(normalizeScope('release'), 'release');
  assert.throws(() => normalizeScope('store'), (error) => error.code === 'invalid_params');
});

test('a playable run completes when test passes and its milestones say verified, never shipped', () => {
  // Arrange
  const run = make(scopedGraph(templateGraph('new-app'), 'playable'));

  // Act
  const done = passThrough(run, BEFORE_RELEASE);

  // Assert
  assert.equal(done.status, 'completed');
  assert.equal(milestoneText(done), '구현 완료 · 검증 완료');
  assert.ok(!milestones(done).some((item) => item.id === 'submit'));
});

test('skipping release stages marks only the not-started ones, records it, and completes the run once test passes', () => {
  // Arrange: policy already passed, listing next
  const run = passThrough(make(), [...BEFORE_RELEASE, 'policy']);
  assert.deepEqual(skippableStages(run).map((node) => node.id), ['listing', 'internal', 'release']);

  // Act
  const skipped = skipReleaseStages(run, { now: NOW });

  // Assert
  assert.equal(status(skipped, 'policy'), 'passed');
  for (const id of ['listing', 'internal', 'release']) assert.equal(status(skipped, id), 'skipped');
  assert.equal(skipped.status, 'completed');
  const recorded = skipped.events.find((event) => event.type === 'run.scope-reduced');
  assert.deepEqual(recorded.skipped, ['listing', 'internal', 'release']);
  assert.ok(skipped.events.some((event) => event.type === 'run.completed'));
});

test('skipping before test passes leaves the run open until test passes, and a running stage is left alone', () => {
  // Arrange: build passed, test running
  let run = passThrough(make(), ['research', 'brief', 'architecture', 'design', 'assets', 'build']);
  run = claimNode(run, 'test', { nonce: nonce(), now: NOW });

  // Act
  const skipped = skipReleaseStages(run, { now: NOW });

  // Assert
  assert.equal(status(skipped, 'test'), 'running');
  assert.notEqual(skipped.status, 'completed');
  let finished = applyReport(skipped, 'test', report(skipped, 'test'), { now: NOW });
  finished = claimNode(finished, 'test', { phase: 'review', nonce: nonce(), now: NOW });
  finished = applyReport(finished, 'test', report(finished, 'test'), { now: NOW });
  assert.equal(finished.status, 'completed');
});

test('a skipped stage is never counted as passed and a repair loop or cancel does not revive or block it', () => {
  // Arrange
  let run = passThrough(make(), ['research', 'brief', 'architecture', 'design', 'assets', 'build']);
  run = skipReleaseStages(run, { now: NOW });
  run = claimNode(run, 'test', { nonce: nonce(), now: NOW });

  // Act: test fails → build is reset (repair loop)
  const repaired = applyReport(run, 'test', report(run, 'test', 'failed'), { now: NOW });
  const cancelled = cancelRun(repaired, { now: NOW });

  // Assert
  for (const id of ['policy', 'listing', 'internal', 'release']) {
    assert.equal(status(repaired, id), 'skipped');
    assert.equal(status(cancelled, id), 'skipped');
  }
  assert.equal(milestones(repaired).find((item) => item.id === 'submit').state, 'skipped');
  assert.match(milestoneText(repaired), /제출 단계 건너뜀/);
  assert.throws(() => retryNode(repaired, 'release', { now: NOW }), (error) => error.code === 'not_retryable');
});

test('skipping refuses a run with nothing left to skip', () => {
  const run = make(scopedGraph(templateGraph('new-app'), 'playable'));
  assert.throws(() => skipReleaseStages(run, { now: NOW }), (error) => error.code === 'conflict');
});

test('an improvement run is never offered 여기까지만: its policy or listing stage is the work itself', () => {
  const run = { ...make(templateGraph('improve', { kind: 'listing' })), template: 'improve' };
  assert.deepEqual(skippableStages(run), []);
});
