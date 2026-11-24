import test from 'node:test';
import assert from 'node:assert/strict';
import { stageCosts } from '../src/costs.mjs';

const T0 = Date.parse('2026-11-24T00:00:00.000Z');
const at = (minutes) => new Date(T0 + minutes * 60_000).toISOString();
const ms = (minutes) => T0 + minutes * 60_000;
const job = (nodeId, phase, start, end, extra = {}) => ({ nodeId, phase, startedAt: at(start), state: 'complete', completedAt: at(end), promptSeen: true, outcome: 'passed', ...extra });
const node = (id, extra = {}) => ({ id, title: id, deps: [], status: 'passed', ...extra });
const usage = (stages) => ({ frozen: { scope: 'complete', total: Object.values(stages).reduce((sum, item) => sum + (item.work ?? 0) + (item.review ?? 0), 0), stages, counts: { sessions: 2 } } });

test('each stage shows minutes worked and tokens per phase, and the run total adds them up', () => {
  // Arrange
  const run = { status: 'completed', nodes: [node('build', { completedAt: at(70) })], usage: usage({ build: { work: 900_000, review: 120_000 } }),
    jobs: [job('build', 'work', 0, 50), job('build', 'review', 55, 70)] };

  // Act
  const costs = stageCosts(run, { now: ms(100) });

  // Assert
  assert.deepEqual(costs.stages.build, { work: { minutes: 50, tokens: 900_000 }, review: { minutes: 15, tokens: 120_000 }, waitingMinutes: 5, unknown: 0 });
  assert.deepEqual(costs.total, { workedMinutes: 65, waitingMinutes: 5, tokens: 1_020_000, tokenScope: 'complete', unknown: 0 });
});

test('time stuck on an agent screen before work started, and the gap until the retry, count as waiting', () => {
  // Arrange: design blocked 50 minutes on a hook screen (never started), then retried on claude
  const run = { status: 'running', nodes: [node('design', { status: 'review' })], usage: null, jobs: [
    job('design', 'work', 0, 0, { state: 'awaiting-report', completedAt: undefined, promptSeen: false, lastAgentEventAt: ms(2) }),
    job('design', 'work', 50, 75),
  ] };

  // Act
  const costs = stageCosts(run, { now: ms(80) });

  // Assert
  assert.equal(costs.stages.design.work.minutes, 25);
  assert.equal(costs.stages.design.waitingMinutes, 55, '50 minutes before the retry, plus 5 queued for review');
  assert.equal(costs.stages.design.work.tokens, null, 'no usage data: tokens are unknown, never 0');
  assert.equal(costs.total.tokens, null);
});

test('a running job counts up to now, and a stage reset by a later repair loop is not counted as waiting meanwhile', () => {
  // Arrange: build passed (0-40, review 40-50), test ran and failed, build redone from 90
  const run = { status: 'running', nodes: [node('build', { status: 'running', active: { phase: 'work' } })], usage: null, jobs: [
    job('build', 'work', 0, 40), job('build', 'review', 40, 50), job('build', 'work', 90, 0, { state: 'running', completedAt: undefined }),
  ] };

  // Act
  const costs = stageCosts(run, { now: ms(100) });

  // Assert
  assert.equal(costs.stages.build.work.minutes, 50);
  assert.equal(costs.stages.build.review.minutes, 10);
  assert.equal(costs.stages.build.waitingMinutes, 0);
});

test('queued time before the first job counts from when every dependency passed', () => {
  // Arrange
  const run = { status: 'completed', nodes: [node('brief', { completedAt: at(20) }), node('design', { deps: ['brief'], completedAt: at(60) })], usage: null,
    jobs: [job('brief', 'work', 0, 15), job('brief', 'review', 15, 20), job('design', 'work', 32, 50), job('design', 'review', 50, 60)] };

  // Act
  const costs = stageCosts(run, { now: ms(100) });

  // Assert
  assert.equal(costs.stages.design.waitingMinutes, 12);
  assert.equal(costs.total.workedMinutes, 48);
});

test('a job whose end is unknown is counted as unknown instead of guessed', () => {
  // Arrange: an old job kept no end; the stage is blocked now
  const run = { status: 'blocked', nodes: [node('test', { status: 'blocked' })], usage: null, jobs: [
    job('test', 'work', 0, 0, { state: 'awaiting-report', completedAt: undefined, promptSeen: true }),
  ] };

  // Act
  const costs = stageCosts(run, { now: ms(30) });

  // Assert
  assert.equal(costs.stages.test.unknown, 1);
  assert.equal(costs.stages.test.work.minutes, 0);
  assert.equal(costs.total.unknown, 1);
});

test('stages without jobs or tokens are left out, and skipped stages never appear', () => {
  const run = { status: 'completed', nodes: [node('release', { status: 'skipped' }), node('build')], usage: null, jobs: [] };
  assert.deepEqual(stageCosts(run, { now: ms(1) }).stages, {});
});

test('a job without a readable start is unknown, not zero', () => {
  const run = { status: 'completed', nodes: [node('build')], usage: null, jobs: [job('build', 'work', 0, 10, { startedAt: 'not a time' })] };
  assert.equal(stageCosts(run, { now: ms(20) }).stages.build.unknown, 1);
});

test('a job left in a running state that its stage no longer holds does not keep growing', () => {
  const run = { status: 'cancelled', nodes: [node('build', { status: 'blocked' })], usage: null,
    jobs: [job('build', 'work', 0, 0, { state: 'running', completedAt: undefined, lastAgentEventAt: ms(10), nonce: 'old' })] };
  assert.equal(stageCosts(run, { now: ms(500) }).stages.build.work.minutes, 10);
});
