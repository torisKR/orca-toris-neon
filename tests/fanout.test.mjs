import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, claimNode, applyReport } from '../src/engine.mjs';
import { fanoutInstruction, parallelFieldsOf } from '../src/fanout.mjs';
import { buildNodePrompt } from '../src/prompt.mjs';

const NOW = '2026-11-24T04:00:00.000Z';
const make = (profile, agent = 'claude') => ({ ...createRun({ id: 'run-x', goal: '보드게임', now: NOW, nodes: [{ id: 'build', title: '앱 구현', deps: [], write: true, agent }] }), profile, workspacePath: '/w' });
const job = (agent = 'claude', phase = 'work') => ({ runId: 'run-x', nodeId: 'build', nonce: 'n1', attempt: 1, phase, agent, receiptDirectory: '/r', receiptPath: '/r/result.json' });
const build = (run) => run.nodes[0];
const PARALLEL = { modules: [{ name: '규칙 엔진', by: 'subagent', model: 'claude-sonnet-5-5' }, { name: '화면', by: 'subagent' }, { name: '통합', by: 'main' }], ranInParallel: ['규칙 엔진', '화면'], note: '엔진과 화면은 파일이 겹치지 않음' };
function reported(run, extra) {
  const claimed = claimNode(run, 'build', { nonce: 'n1', now: NOW });
  return applyReport(claimed, 'build', { runId: run.id, nodeId: 'build', phase: 'work', nonce: 'n1', attempt: 1, outcome: 'passed', summary: '구현',
    evidence: [{ kind: 'artifact', path: 'a/build.md' }], ...extra }, { now: NOW });
}

test('a claude build in a balanced run is told to split independent modules across up to 3 subagents and own integration', () => {
  // Arrange
  const run = make('balanced');

  // Act
  const brief = fanoutInstruction(run, build(run), job());

  // Assert
  assert.match(brief, /최대 3개/);
  assert.match(brief, /통합/);
  assert.match(brief, /커밋/);
  assert.match(brief, /claude-sonnet-5-5|claude-haiku-5-5/);
  assert.match(brief, /"parallel"/);
  assert.match(fanoutInstruction(make('fast'), build(make('fast')), job()), /최대 5개/);
});

test('no fan-out for saver, a non-claude worker, a review, another stage, or a run from before profiles', () => {
  assert.equal(fanoutInstruction(make('saver'), build(make('saver')), job()), '');
  assert.equal(fanoutInstruction(make('balanced'), build(make('balanced')), job('codex')), '');
  assert.equal(fanoutInstruction(make('balanced'), build(make('balanced')), job('claude', 'review')), '');
  assert.equal(fanoutInstruction(make('balanced'), { ...build(make('balanced')), id: 'test' }, job()), '');
  assert.equal(fanoutInstruction(make(undefined), build(make(undefined)), job()), '');
});

test('a repair attempt fans out only when its failures are independent', () => {
  // Arrange
  const run = make('balanced');
  build(run).feedback = { summary: '두 가지 실패' };

  // Act
  const brief = fanoutInstruction(run, build(run), job());

  // Assert
  assert.match(brief, /서로 독립/);
  assert.match(brief, /직접 순서대로/);
});

test('a passed claude build that could fan out must state its module split; the field is kept for the result card', () => {
  // Arrange
  const run = make('balanced');

  // Act + Assert
  assert.throws(() => reported(run, {}), (error) => error.code === 'invalid_report' && /parallel/.test(error.message));
  const passed = reported(run, { parallel: PARALLEL });
  assert.deepEqual(build(passed).report.parallel, PARALLEL);
  assert.equal(build(reported(make('saver'), {})).status, 'review', 'saver never asks for a split');
});

test('the parallel field is validated: module names, who ran them, and only listed modules ran in parallel', () => {
  for (const bad of [{ modules: [] }, { modules: [{ name: 'x', by: 'robot' }] }, { modules: [{ name: 'x', by: 'main' }], ranInParallel: ['y'] }, 'text']) {
    assert.throws(() => parallelFieldsOf({ parallel: bad }), (error) => error.code === 'invalid_report', JSON.stringify(bad));
  }
  assert.deepEqual(parallelFieldsOf({}), {});
});

test('the build brief carries the fan-out section', () => {
  const run = make('balanced');
  assert.match(buildNodePrompt(run, build(run), job()), /서브에이전트/);
});
