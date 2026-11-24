import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, claimNode, applyReport, templateGraph, IMPROVE_KINDS } from '../src/engine.mjs';
import { IMPROVE_BRIEFS } from '../src/improve.mjs';
import { isReportFormError } from '../src/reportfix.mjs';

const NOW = Date.parse('2026-11-24T09:00:00Z');
const candidate = (title, kind = 'bugfix') => ({ kind, title, problem: '같은 알람이 두 번 예약된다', evidence: 'AlarmScheduler.kt:88, repro.log',
  impact: '같은 알람을 두 번 받는다', scope: '알람 예약 경로', verify: '예약 수가 1인지 보는 단위 테스트' });
const three = [candidate('알림 중복'), candidate('느린 시작', 'performance'), candidate('출시 테스트 없음', 'release')];

/** A diagnose run whose diagnose stage is claimed for `phase`; returns a thunk that applies the report. */
function diagnosisReport(extra, { template = 'diagnose', phase = 'work', outcome = 'passed' } = {}) {
  const base = createRun({ id: 'run-d', goal: '진단', projectId: 'p1', now: NOW, nodes: templateGraph('diagnose') });
  const nodes = base.nodes.map((node) => node.id === 'identity' ? { ...node, status: 'passed' }
    : phase === 'review' ? { ...node, status: 'review', attempts: 1, report: { outcome: 'passed', summary: '후보', candidates: three } } : node);
  const run = claimNode({ ...base, template, nodes }, 'diagnose', { phase, nonce: 'n-1', now: NOW });
  const report = { runId: run.id, nodeId: 'diagnose', nonce: 'n-1', attempt: 1, phase, outcome, summary: '후보를 찾았다',
    evidence: [{ kind: 'artifact', path: 'verification.md' }], ...extra };
  return () => applyReport(run, 'diagnose', report, { now: NOW + 1 });
}
const savedCandidates = (run) => run.nodes.find((node) => node.id === 'diagnose').report.candidates;

test('the diagnose brief states the exact candidates schema, every improvement kind and an example', () => {
  const brief = IMPROVE_BRIEFS.diagnose;
  assert.match(brief, /"candidates"/);
  assert.match(brief, /3~5/);
  for (const field of ['kind', 'title', 'problem', 'evidence', 'impact', 'scope', 'verify']) assert.match(brief, new RegExp('"' + field + '"'), field);
  for (const kind of Object.keys(IMPROVE_KINDS)) assert.match(brief, new RegExp(kind), kind);
  assert.match(brief, /예:/, 'an example object');
  assert.match(brief, /verification\.md에만/, 'says the markdown alone is not enough');
});

test('a passed diagnosis with 3 to 5 valid candidates is accepted as written', () => {
  const saved = savedCandidates(diagnosisReport({ candidates: three })());
  assert.equal(saved.length, 3);
  assert.deepEqual(saved[1], candidate('느린 시작', 'performance'));
});

test('a passed diagnosis without candidates is refused as a report-form error the same agent can fix', () => {
  let caught = null;
  try { diagnosisReport({})(); } catch (error) { caught = error; }
  assert.ok(caught, 'refused');
  assert.equal(caught.code, 'invalid_report');
  assert.equal(isReportFormError(caught), true, 'goes to the report-fix path, not a new attempt');
  assert.match(caught.message, /"candidates"/);
  assert.match(caught.message, /"verify"/, 'the refusal repeats the shape so the fix needs no brief');
});

test('a passed diagnosis with fewer than 3 or more than 5 candidates is refused', () => {
  assert.throws(diagnosisReport({ candidates: three.slice(0, 2) }), { code: 'invalid_report' });
  assert.throws(diagnosisReport({ candidates: [...three, ...three] }), { code: 'invalid_report' });
  assert.throws(diagnosisReport({ candidates: [] }), { code: 'invalid_report' });
  assert.throws(diagnosisReport({ candidates: null }), { code: 'invalid_report' }, 'null is not "no field"');
  assert.throws(diagnosisReport({ candidates: {} }), { code: 'invalid_report' });
});

test('a candidate with an unknown kind or an empty field is refused', () => {
  assert.throws(diagnosisReport({ candidates: [...three.slice(0, 2), { ...three[2], kind: 'rewrite' }] }), { code: 'invalid_report' });
  assert.throws(diagnosisReport({ candidates: [...three.slice(0, 2), { ...three[2], scope: '  ' }] }), { code: 'invalid_report' });
});

test('userImpact and verification are read as impact and verify', () => {
  const { impact, verify, ...rest } = candidate('알림 중복');
  const [saved] = savedCandidates(diagnosisReport({ candidates: [{ ...rest, userImpact: impact, verification: verify }, three[1], three[2]] })());
  assert.equal(saved.impact, impact);
  assert.equal(saved.verify, verify);
  assert.equal('userImpact' in saved, false);
});

test('a failed or blocked diagnosis that lists only one or two candidates is recorded as it is, without them', () => {
  const run = diagnosisReport({ candidates: three.slice(0, 1) }, { outcome: 'blocked' })();
  const node = run.nodes.find((item) => item.id === 'diagnose');
  assert.equal(node.status, 'blocked', 'the block is recorded, not sent back as a form error');
  assert.equal(node.report.outcome, 'blocked');
  assert.equal(JSON.parse(JSON.stringify(node.report)).candidates, undefined, 'not startable, so not stored');
});

test('a failed or blocked diagnosis, its review, and other templates need no candidates', () => {
  assert.doesNotThrow(diagnosisReport({}, { outcome: 'failed' }));
  assert.doesNotThrow(diagnosisReport({}, { outcome: 'blocked' }));
  assert.doesNotThrow(diagnosisReport({ sourceFingerprint: 'x' }, { phase: 'review' }));
  assert.doesNotThrow(diagnosisReport({}, { template: 'improve' }));
});
