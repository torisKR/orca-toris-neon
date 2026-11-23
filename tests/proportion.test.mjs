import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GRAPH, createRun } from '../src/engine.mjs';
import {
  STAGE_BUDGETS, DOCUMENT_STAGES, stageBudget, budgetInstruction, reviewInstruction, followUpsFor, followUpsInstruction,
} from '../src/proportion.mjs';
import { MAX_REPORT_FIXES, isReportFormError, formError, reportFixPrompt } from '../src/reportfix.mjs';

const NOW = '2026-11-22T11:00:00.000Z';
const node = (run, id) => run.nodes.find((item) => item.id === id);

test('every default stage has a work and review budget and a definition of enough', () => {
  for (const { id } of DEFAULT_GRAPH) {
    const budget = STAGE_BUDGETS[id];
    assert.ok(budget, id);
    assert.ok(budget.work > 0 && budget.review > 0 && budget.review <= budget.work, id);
    assert.ok(budget.scope.length > 10 && budget.enough.length > 20, id);
  }
  assert.equal(stageBudget('research', 'work'), STAGE_BUDGETS.research.work);
  assert.equal(stageBudget('research', 'review'), STAGE_BUDGETS.research.review);
  assert.equal(stageBudget('custom', 'work'), null);
  assert.ok(STAGE_BUDGETS.research.work <= 15 && STAGE_BUDGETS.brief.work <= 15, 'planning documents take minutes, not hours');
});

test('document stages are the planning, design and store stages; build, assets and test stay strict', () => {
  for (const id of ['research', 'brief', 'architecture', 'design', 'policy', 'listing']) assert.ok(DOCUMENT_STAGES.has(id), id);
  for (const id of ['assets', 'build', 'test', 'internal']) assert.equal(DOCUMENT_STAGES.has(id), false, id);
});

test('a work brief states the time, the scope and what is enough; research collects no bulk data unless asked', () => {
  const research = budgetInstruction({ id: 'research' }, 'work');
  assert.match(research, /15분/);
  assert.match(research, /충분/);
  assert.match(research, /대량/);
  assert.match(budgetInstruction({ id: 'research' }, 'review'), new RegExp(STAGE_BUDGETS.research.review + '분'));
  assert.equal(budgetInstruction({ id: 'custom' }, 'work'), '');
});

test('document reviews fail only blocking defects and record the rest as follow-ups; build and test reviews stay strict', () => {
  const doc = reviewInstruction({ id: 'architecture' });
  assert.match(doc, /차단/);
  assert.match(doc, /followUps/);
  assert.match(doc, /passed/);
  const strict = reviewInstruction({ id: 'build' });
  assert.doesNotMatch(strict, /followUps/);
  assert.match(strict, /failed/);
});

test('follow-ups from passed reviews of a stage\'s dependencies reach its brief, deduplicated and capped', () => {
  const run = createRun({ id: 'r', goal: '게임', now: NOW });
  node(run, 'brief').review = { outcome: 'passed', followUps: ['B8 장애물 연속 경로를 구현 테스트로 확인', 'J3 문구 수정'] };
  node(run, 'brief').report = { outcome: 'passed', followUps: ['J3 문구 수정'] };
  node(run, 'research').review = { outcome: 'passed', followUps: ['brief 단계에는 전달되지 않음'] };
  assert.deepEqual(followUpsFor(run, node(run, 'architecture')), ['B8 장애물 연속 경로를 구현 테스트로 확인', 'J3 문구 수정']);
  assert.match(followUpsInstruction(run, node(run, 'architecture')), /B8/);
  assert.equal(followUpsInstruction(run, node(run, 'test')), '');
  node(run, 'brief').review.followUps = Array.from({ length: 30 }, (_, i) => '항목 ' + i);
  assert.equal(followUpsFor(run, node(run, 'design')).length, 12);
});

test('a report refused for its form is told apart from missing work and from source changes', () => {
  assert.equal(isReportFormError(Object.assign(new Error('x'), { code: 'contradictory_evidence' })), true);
  assert.equal(isReportFormError(Object.assign(new Error('x'), { code: 'invalid_evidence' })), true);
  assert.equal(isReportFormError(formError('artifact 파일이 없습니다')), true);
  assert.equal(isReportFormError(new SyntaxError('Unexpected token')), true, 'malformed JSON');
  assert.equal(isReportFormError(Object.assign(new Error('x'), { code: 'ENOENT', missingReceipt: true })), false);
  assert.equal(isReportFormError(Object.assign(new Error('x'), { code: 'conflict' })), false, 'source changed: the work must be redone');
  assert.equal(isReportFormError(Object.assign(new Error('x'), { code: 'stale_report' })), false);
  assert.equal(MAX_REPORT_FIXES, 2);
});

test('the report fix request is one line, names the path and the reason, and says not to redo the work', () => {
  const text = reportFixPrompt('evidence[3] (diff a b): role check인데 exitCode 1입니다.\n두 번째 줄', '/runs/r/brief/3-work-n/result.json', 1);
  assert.equal(text.includes('\n'), false, 'a newline would submit the line early');
  assert.match(text, /result\.json/);
  assert.match(text, /evidence\[3\]/);
  assert.match(text, /다시 하지/);
  assert.match(text, /expectedExitCode/);
  assert.match(text, /1\/2/);
});

test('update stages have budgets; audit and plan are documents, monetization and the catalog check stay strict', () => {
  for (const id of ['identity', 'plan', 'monetization', 'catalog']) assert.ok(STAGE_BUDGETS[id]?.work > 0 && STAGE_BUDGETS[id].review > 0, id);
  assert.ok(DOCUMENT_STAGES.has('identity') && DOCUMENT_STAGES.has('plan'));
  assert.equal(DOCUMENT_STAGES.has('monetization'), false);
  assert.doesNotMatch(reviewInstruction({ id: 'monetization' }), /followUps/);
});
