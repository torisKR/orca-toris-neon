import test from 'node:test';
import assert from 'node:assert/strict';
import { stageResult } from '../panel/result.mjs';
import { researchFindings } from '../panel/research.mjs';
import { createRun, templateGraph } from '../src/engine.mjs';
import { sampleFindings } from './fixtures/research.mjs';

const runWith = (report) => {
  const run = createRun({ id: 'r1', goal: '습관 앱', now: '2026-11-28T01:00:00.000Z', nodes: templateGraph('new-app') });
  Object.assign(run.nodes.find((node) => node.id === 'research'), { status: 'passed', report });
  return run;
};
const card = (report) => { const run = runWith(report); return stageResult(run, run.nodes.find((node) => node.id === 'research'), { artifacts: new Map() }); };

test('a passed research card leads with the decision, then who, problem, competitors, differentiators, money, questions and sources', () => {
  const findings = sampleFindings();
  const html = card({ outcome: 'passed', summary: '조사', evidence: [], findings });
  const order = ['결론', '대상 사용자', '문제', '경쟁 앱', '차별점', '수익화 가설', '남은 질문', '출처 6곳 열어 봄 · 4곳 검색 결과만'].map((text) => html.indexOf(text));
  assert.ok(order.every((index) => index >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'shown in reading order');
  assert.ok(html.indexOf('결론') < html.indexOf('바뀐 것') || !html.includes('바뀐 것'));
  assert.match(html, /class="research-decision"/);
  assert.equal((html.match(/확인함/g) ?? []).length, 2);
  assert.equal((html.match(/검색 결과만<\/span>/g) ?? []).length, 1);
  assert.match(html, /data-action="external" data-url="https:\/\/example\.com\//, 'opens through the existing external-link action');
  assert.ok(html.includes(findings.monetization.basis));
});

test('values are escaped and a non-HTTPS competitor address is plain text, not a link', () => {
  const findings = sampleFindings();
  findings.competitors[0] = { ...findings.competitors[0], name: '<img src=x>', url: 'http://example.com/a' };
  const html = researchFindings({ findings });
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.equal((html.match(/data-action="external"/g) ?? []).length, 2);
});

test('an old research report without findings keeps the card as it was', () => {
  assert.equal(card({ outcome: 'passed', summary: '조사', evidence: [] }), '');
  const withChanges = card({ outcome: 'passed', summary: '조사', evidence: [], changes: ['research.md 작성'] });
  assert.match(withChanges, /바뀐 것/);
  assert.doesNotMatch(withChanges, /research-findings/);
  assert.equal(researchFindings(null), '');
});

test('malformed stored findings render what is well-formed instead of breaking the run view', () => {
  for (const findings of [
    { decision: '결론', competitors: 'abc', differentiators: 'x', openQuestions: 'x', monetization: '구독', sources: 3 },
    { decision: '결론', competitors: [null, 5, { name: '샘플', url: 42, takeaway: '배울 점', checked: true }] },
  ]) {
    const html = researchFindings({ findings });
    assert.match(html, /결론/);
    assert.doesNotMatch(html, /undefined/);
  }
  assert.match(researchFindings({ findings: { decision: '결론', competitors: [null, { name: '샘플', url: 42, takeaway: 't', checked: true }] } }), /샘플<\/th>/, 'no link without an https address');
  assert.equal(researchFindings({ findings: { decision: 42 } }), '');
  assert.equal(researchFindings({ findings: '결론' }), '');
});
