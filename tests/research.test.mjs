import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, claimNode, applyReport, templateGraph } from '../src/engine.mjs';
import { STAGE_BRIEFS, buildNodePrompt } from '../src/prompt.mjs';
import { STAGE_BUDGETS, budgetInstruction } from '../src/proportion.mjs';
import { isReportFormError } from '../src/reportfix.mjs';
import { competitor, sampleFindings } from './fixtures/research.mjs';
import { sampleTarget } from './fixtures/target.mjs';
import { findingsOf, findingsContract, researchInstruction, RESEARCH_QUESTIONS, FINDINGS_EXAMPLE } from '../src/research.mjs';

const NOW = Date.parse('2026-11-28T09:00:00Z');
/** A new-app run whose research stage is claimed for `phase`; returns a thunk that applies the report. */
function researchReport(extra, { phase = 'work', outcome = 'passed' } = {}) {
  const base = createRun({ id: 'run-r', goal: '습관 앱', projectId: 'p1', now: NOW, nodes: templateGraph('new-app') });
  const nodes = base.nodes.map((node) => node.id === 'research' && phase === 'review'
    ? { ...node, status: 'review', attempts: 1, report: { outcome: 'passed', summary: '조사', findings: sampleFindings() } } : node);
  const run = claimNode({ ...base, nodes }, 'research', { phase, nonce: 'n-1', now: NOW });
  const report = { runId: run.id, nodeId: 'research', nonce: 'n-1', attempt: 1, phase, outcome, summary: '조사를 마쳤다',
    evidence: [{ kind: 'artifact', path: 'research.md' }], ...(phase === 'review' ? { sourceFingerprint: 'x' } : {}), ...extra };
  return () => applyReport(run, 'research', report, { now: NOW + 1 });
}
const saved = (run) => run.nodes.find((node) => node.id === 'research').report.findings;
const refusal = (thunk) => { try { thunk(); } catch (error) { return error; } return null; };

test('a passed research report with valid findings is stored normalized', () => {
  const findings = saved(researchReport({ findings: sampleFindings() })());
  assert.deepEqual(findings, sampleFindings());
});

test('a passed research report without findings is refused as a report-form error with an example', () => {
  const error = refusal(researchReport({}));
  assert.ok(error, 'refused');
  assert.equal(error.code, 'invalid_report');
  assert.equal(isReportFormError(error), true, 'the same agent fixes result.json');
  assert.match(error.message, /"findings"/);
  assert.match(error.message, /"decision"/);
  assert.match(error.message, /예:/);
  assert.ok(error.message.length < 1400, 'fits the report-fix request');
});

test('malformed findings are refused, each with a message naming the broken field', () => {
  const bad = (patch) => researchReport({ findings: { ...sampleFindings(), ...patch } });
  const cases = [
    [{ decision: '' }, /findings\.decision/], [{ decision: 'x'.repeat(601) }, /findings\.decision/],
    [{ targetUser: undefined }, /findings\.targetUser/], [{ problem: 42 }, /findings\.problem/],
    [{ competitors: [competitor('A'), competitor('B')] }, /findings\.competitors는 3~5개/],
    [{ competitors: Array.from({ length: 6 }, (_, index) => competitor('앱 ' + index)) }, /findings\.competitors는 3~5개/],
    [{ competitors: [competitor('A'), competitor('B'), { ...competitor('C'), checked: 'yes' }] }, /competitors\[2\]\.checked/],
    [{ competitors: [competitor('A'), competitor('B'), { ...competitor('C'), url: 'javascript:alert(1)' }] }, /competitors\[2\]\.url는 http/],
    [{ competitors: [competitor('A'), competitor('B'), { ...competitor('C'), url: 'not a url' }] }, /competitors\[2\]\.url는 http/],
    [{ competitors: [competitor('A'), competitor('B'), null] }, /competitors\[2\]는 객체/],
    [{ competitors: [competitor('A'), competitor('A'), competitor('C')] }, /같은 url/],
    [{ sources: { opened: 6, searchOnly: 0 } }, /checked=false인 경쟁 앱 수\(1\)/],
    [{ decision: 'x'.repeat(700) }, /700자로 너무 깁니다/],
    [{ differentiators: [] }, /differentiators는 1~5개/], [{ differentiators: Array(6).fill('차별점') }, /differentiators는 1~5개/],
    [{ monetization: { hypothesis: '구독' } }, /monetization\.basis/], [{ monetization: '구독' }, /monetization는 객체/],
    [{ openQuestions: Array(6).fill('질문') }, /openQuestions는 0~5개/],
    [{ sources: { opened: -1, searchOnly: 0 } }, /sources\.opened/], [{ sources: { opened: 1.5, searchOnly: 0 } }, /sources\.opened/],
    [{ sources: null }, /sources는 객체/],
    [{ sources: { opened: 1, searchOnly: 0 } }, /checked=true인 경쟁 앱 수\(2\)/], // fewer opened sources than competitors marked checked
  ];
  for (const [patch, message] of cases) assert.throws(bad(patch), { code: 'invalid_report', message }, JSON.stringify(patch).slice(0, 80));
  assert.throws(researchReport({ findings: [] }), { code: 'invalid_report', message: /findings\.\(findings\)는 객체/ });
  assert.throws(researchReport({ findings: null }), { code: 'invalid_report', message: /^findings\.\(findings\)는 객체/ }, 'one refusal, not a second "no findings" one');
});

test('every findings problem is named in one refusal, so one report-fix round is enough', () => {
  const findings = { ...sampleFindings(), decision: '', monetization: { hypothesis: '구독' }, sources: { opened: 0, searchOnly: 4 },
    competitors: [competitor('A'), competitor('B'), { ...competitor('C'), url: 'ftp://example.com' }] };
  const error = refusal(researchReport({ findings }));
  assert.match(error.message, /고칠 곳 4개/);
  for (const part of [/findings\.decision/, /monetization\.basis/, /competitors\[2\]\.url/, /sources\.opened\(0\)/]) assert.match(error.message, part);
});

test('the example in the contract is valid JSON that the contract accepts as written', () => {
  assert.doesNotThrow(() => findingsOf(JSON.parse(FINDINGS_EXAMPLE)));
  assert.ok(findingsContract().includes(FINDINGS_EXAMPLE));
});

test('a value padded with spaces is measured after trimming', () => {
  const findings = saved(researchReport({ findings: { ...sampleFindings(), decision: '  ' + 'x'.repeat(600) + '  ' } })());
  assert.equal(findings.decision.length, 600);
});

test('findings sent by a review or another stage are not checked against the research contract nor kept', () => {
  const review = researchReport({ findings: ['링크 A 확인'] }, { phase: 'review' })();
  assert.equal(JSON.parse(JSON.stringify(review.nodes[0].review ?? {})).findings, undefined);
  const base = createRun({ id: 'run-r', goal: '습관 앱', projectId: 'p1', now: NOW, nodes: templateGraph('new-app') });
  const nodes = base.nodes.map((node) => node.id === 'research' ? { ...node, status: 'passed' } : node);
  const run = claimNode({ ...base, nodes }, 'brief', { phase: 'work', nonce: 'n-2', now: NOW });
  const after = applyReport(run, 'brief', { runId: run.id, nodeId: 'brief', nonce: 'n-2', attempt: 1, phase: 'work', outcome: 'passed', summary: '기획',
    evidence: [{ kind: 'artifact', path: 'brief.md' }], target: sampleTarget(), findings: { decision: '다른 단계의 값' } }, { now: NOW + 1 });
  assert.equal(JSON.parse(JSON.stringify(after.nodes.find((node) => node.id === 'brief').report)).findings, undefined);
});

test('openQuestions may be missing; text is trimmed', () => {
  const { openQuestions, ...rest } = sampleFindings();
  const findings = saved(researchReport({ findings: { ...rest, decision: '  ' + rest.decision + '  ' } })());
  assert.deepEqual(findings.openQuestions, []);
  assert.equal(findings.decision, rest.decision);
});

test('a failed or blocked research, its review, and other stages need no findings', () => {
  assert.doesNotThrow(researchReport({}, { outcome: 'failed' }));
  const blocked = researchReport({ findings: { decision: '' } }, { outcome: 'blocked' })();
  assert.equal(JSON.parse(JSON.stringify(blocked.nodes[0].report)).findings, undefined, 'a non-pass keeps no findings');
  assert.doesNotThrow(researchReport({}, { phase: 'review' }));
});

test('the research brief and budget ask exactly the six questions and stop there', () => {
  assert.equal(RESEARCH_QUESTIONS.length, 6);
  const brief = STAGE_BRIEFS.research;
  for (const word of ['목표 사용자', '문제', '경쟁 앱 3~5개', '차별점', '수익화', '남은 질문']) assert.match(brief, new RegExp(word), word);
  assert.match(brief, /checked/);
  assert.match(brief, /추정/);
  assert.match(brief, /리뷰 수집/);
  assert.match(brief, /영상/);
  const budget = budgetInstruction({ id: 'research' }, 'work');
  assert.match(budget, /10~15곳/);
  assert.match(budget, /대량/);
  assert.ok(STAGE_BUDGETS.research.work <= 15);
});

const job = (phase, nodeId = 'research') => ({ runId: 'run-r', nodeId, nonce: 'n', phase, attempt: 1, agent: 'codex', receiptDirectory: '/r', receiptPath: '/r/result.json', sourceFingerprint: 'f' });
const promptFor = (nodeId, phase, run = createRun({ id: 'run-r', goal: '습관 앱', projectId: 'p1', now: NOW, nodes: templateGraph('new-app') })) =>
  buildNodePrompt(run, run.nodes.find((node) => node.id === nodeId), job(phase, nodeId));

test('the research work prompt carries the findings contract and asks criteria for the six questions', () => {
  const prompt = promptFor('research', 'work');
  assert.ok(prompt.includes(findingsContract()));
  for (const field of ['decision', 'targetUser', 'problem', 'competitors', 'differentiators', 'monetization', 'openQuestions', 'sources']) assert.match(prompt, new RegExp('"' + field + '"'), field);
  assert.match(prompt, /"criteria"[^\n]*여섯 질문/);
  assert.match(prompt, /example\.com/, 'the example uses sample addresses only');
});

test('a custom research instruction still gets the findings contract', () => {
  const run = createRun({ id: 'run-r', goal: '습관 앱', projectId: 'p1', now: NOW, nodes: [{ id: 'research', title: '조사', deps: [], write: false, instructions: '경쟁 앱만 보세요' }] });
  assert.ok(promptFor('research', 'work', run).includes(findingsContract()));
});

test('the research review checks the six questions, spot-checks two opened links and names the blocking defects', () => {
  const prompt = promptFor('research', 'review');
  assert.match(prompt, /여섯 질문/);
  assert.match(prompt, /checked[^\n]*2개/);
  assert.match(prompt, /"defect"/);
  assert.match(prompt, /decision/);
  assert.match(prompt, /later/);
  assert.match(prompt, /문서 단계 검토/, 'the document-stage rule is kept');
  assert.doesNotMatch(promptFor('brief', 'review'), /checked=true인 경쟁 앱/);
});

test('the brief prompt quotes the passed research decision, differentiators, monetization and open questions', () => {
  const base = createRun({ id: 'run-r', goal: '습관 앱', projectId: 'p1', now: NOW, nodes: templateGraph('new-app') });
  const findings = sampleFindings();
  const run = { ...base, nodes: base.nodes.map((node) => node.id === 'research' ? { ...node, status: 'passed', report: { outcome: 'passed', summary: '조사', findings } } : node) };
  const prompt = promptFor('brief', 'work', run);
  assert.match(prompt, /조사 결론/);
  for (const text of [findings.decision, ...findings.differentiators, findings.monetization.hypothesis, findings.monetization.basis, ...findings.openQuestions]) {
    assert.ok(prompt.includes(text), text);
  }
  assert.match(prompt, /선행 단계 결과/, 'the dependency evidence stays');
  assert.equal(researchInstruction(base, base.nodes.find((node) => node.id === 'brief'), job('work', 'brief')), '', 'no research findings, no quote');
  assert.equal(researchInstruction(run, run.nodes.find((node) => node.id === 'architecture'), job('work', 'architecture')), '');
});

test('a malformed stored research conclusion is not quoted and does not stop the brief from launching', () => {
  const base = createRun({ id: 'run-r', goal: '습관 앱', projectId: 'p1', now: NOW, nodes: templateGraph('new-app') });
  const run = { ...base, nodes: base.nodes.map((node) => node.id === 'research' ? { ...node, status: 'passed', report: { outcome: 'passed', summary: '조사', findings: { decision: '결론만 있음' } } } : node) };
  const prompt = promptFor('brief', 'work', run);
  assert.doesNotMatch(prompt, /조사 결론\(/);
  assert.match(prompt, /구조화된 결론\(findings\)이 없거나/, 'the brief agent is told the conclusion is missing');
  assert.match(prompt, /선행 단계 결과/, 'the stored report still reaches the brief through the dependency evidence');
});

test('findingsOf keeps only the contract fields', () => {
  const value = findingsOf({ ...sampleFindings(), extra: '버림', competitors: sampleFindings().competitors.map((item) => ({ ...item, rating: 4.5 })) });
  assert.equal('extra' in value, false);
  assert.equal('rating' in value.competitors[0], false);
});
