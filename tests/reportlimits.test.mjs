import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, reportProblems } from '../src/engine.mjs';
import { REPORT_LIMITS, CONDITION_KEYS, reportLimitsText, overCap } from '../src/reportlimits.mjs';
import { buildNodePrompt } from '../src/prompt.mjs';

const NOW = Date.parse('2026-11-28T03:00:00.000Z');
const run = () => createRun({ id: 'r1', goal: '샘플 앱', projectId: 'p', now: NOW });
const artifact = (n) => ({ kind: 'artifact', path: '/example/receipts/r1/design/' + n + '.png', label: 'screenshot' });
// The live design report: the work was done, three form rules were broken at once.
const threeViolations = () => ({
  runId: 'r1', nodeId: 'design', nonce: 'n1', phase: 'work', attempt: 1, outcome: 'passed', summary: '화면 설계를 마쳤습니다.',
  evidence: Array.from({ length: 64 }, (_, n) => artifact(n)),
  changes: Array.from({ length: 25 }, (_, n) => '바뀐 화면 ' + n),
  comparison: { before: { device: 'Pixel 7', size: '1080x2400', language: 'ko' } },
});

test('every violation of a report is listed at once, not one per round', () => {
  // Arrange / Act
  const problems = reportProblems(run(), 'design', threeViolations());
  // Assert
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.match(problems.join('\n'), /evidence[\s\S]*최대 30개[\s\S]*지금 64개/);
  assert.match(problems.join('\n'), /바뀐 것[\s\S]*최대 20개[\s\S]*지금 25개/);
  assert.match(problems.join('\n'), /comparison\.before\.data/);
});

test('an array over its cap says how many to keep and that the rest belongs in a file artifact', () => {
  const message = reportProblems(run(), 'design', { ...threeViolations(), changes: [], comparison: { before: { device: 'a', size: 'b', language: 'c', data: 'd' } } })[0];
  assert.match(message, /가장 중요한 29개만 남기고/);
  assert.match(message, /결과 디렉터리의 파일 하나에 적어 그 파일을 artifact 근거 1개로/);
  assert.match(overCap('바뀐 것(changes)', 25, 20), /가장 중요한 20개만 남기고/);
});

test('a report that keeps every rule has no problems', () => {
  const report = { ...threeViolations(), evidence: [artifact(1)], changes: ['홈 화면'], comparison: { before: { device: 'a', size: 'b', language: 'c', data: 'd' } } };
  assert.deepEqual(reportProblems(run(), 'design', report), []);
});

test('the brief states every cap the validator enforces, from the same constants', () => {
  // Arrange
  const text = reportLimitsText();
  const item = run();
  const job = { runId: 'r1', nodeId: 'design', nonce: 'n1', phase: 'work', attempt: 1, receiptDirectory: '/example/receipts/r1/design/1', receiptPath: '/example/receipts/r1/design/1/result.json' };
  // Act
  const brief = buildNodePrompt(item, item.nodes.find((node) => node.id === 'design'), job);
  // Assert
  for (const [key, value] of Object.entries(REPORT_LIMITS)) assert.ok(text.includes(String(value)), key + ' (' + value + ') is stated');
  for (const key of CONDITION_KEYS) assert.ok(text.includes('"' + key + '"'), key);
  assert.ok(brief.includes(text), 'the brief carries the limits');
});

test('the caps in force are the ones the brief states', () => {
  const over = (field, count, extra = {}) => reportProblems(run(), 'design', { ...threeViolations(), evidence: [artifact(1)], changes: [], comparison: { before: { device: 'a', size: 'b', language: 'c', data: 'd' } }, [field]: Array.from({ length: count }, (_, n) => extra.item ? extra.item(n) : 'x' + n) });
  assert.equal(over('evidence', REPORT_LIMITS.evidence, { item: artifact }).length, 0);
  assert.equal(over('evidence', REPORT_LIMITS.evidence + 1, { item: artifact }).length, 1);
  assert.equal(over('changes', REPORT_LIMITS.changes).length, 0);
  assert.equal(over('changes', REPORT_LIMITS.changes + 1).length, 1);
});
