import test from 'node:test';
import assert from 'node:assert/strict';
import { stageResult } from '../panel/result.mjs';
import { targetBlock } from '../panel/target.mjs';
import { createRun, templateGraph } from '../src/engine.mjs';
import { sampleTarget, inferredTarget } from './fixtures/target.mjs';

const cardFor = (template, id, report) => {
  const run = createRun({ id: 'r1', goal: '습관 앱', now: '2026-11-28T01:00:00.000Z', nodes: template });
  const node = run.nodes.find((item) => item.id === id);
  Object.assign(node, { status: 'passed', report });
  return stageResult(run, node, { artifacts: new Map() });
};

test('a passed brief card shows the target: who first, then promise, not for, voice, look, avoid and signals', () => {
  const target = sampleTarget();
  const html = cardFor(templateGraph('new-app'), 'brief', { outcome: 'passed', summary: '기획', evidence: [], target });
  const order = [target.primaryUser, target.promise, target.notFor[0], target.voice.examples[0], target.look.direction, target.avoid[0], target.signals[0]].map((text) => html.indexOf(text));
  assert.ok(order.every((index) => index >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'shown in reading order');
  assert.match(html, /class="research-findings target-findings"/, 'reuses the research block styles');
  assert.match(html, /<h5[^>]*>타겟/);
  assert.equal((html.match(/<li>/g) ?? []).length >= target.avoid.length + target.signals.length, true);
});

test('an identity card shows the inferred current target and says it was read from the existing app', () => {
  const graph = templateGraph('improve', { kind: 'design' });
  const html = cardFor(graph, 'identity', { outcome: 'passed', summary: '정체성', evidence: [], identity: { stack: 'Flutter', target: inferredTarget() } });
  assert.match(html, /현재 타겟/);
  assert.ok(html.includes(inferredTarget().promise));
  assert.match(html, /\(추정\)/);
});

test('values are escaped; old runs and malformed stored targets keep the card working', () => {
  const html = targetBlock({ target: { ...sampleTarget(), primaryUser: '<img src=x> 이른 아침 출근하는 사람' } });
  assert.doesNotMatch(html, /<img src=x>/);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.equal(targetBlock({ outcome: 'passed' }), '');
  assert.equal(targetBlock(null), '');
  assert.match(targetBlock({ target: { primaryUser: 42 } }), /읽을 수 없습니다/, 'present but unusable is said, not hidden');
  const partial = targetBlock({ target: { primaryUser: '아침 출근길의 직장인', voice: 'x', look: null, avoid: 'x', signals: [1, '첫 기록 10초'] } });
  assert.match(partial, /아침 출근길의 직장인/);
  assert.match(partial, /첫 기록 10초/);
  assert.doesNotMatch(partial, /undefined|null/);
  const empty = targetBlock({ target: { primaryUser: '아침 출근길의 직장인', voice: { tone: '' }, look: { direction: '', why: '이유만' } } });
  assert.doesNotMatch(empty, /말투|시각 방향|<p><\/p>/, 'an empty string is not a heading with nothing under it');
  assert.equal(cardFor(templateGraph('new-app'), 'brief', { outcome: 'passed', summary: '기획', evidence: [] }), '', 'an old brief without result fields has no card');
});
