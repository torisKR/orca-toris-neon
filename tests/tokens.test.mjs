import test from 'node:test';
import assert from 'node:assert/strict';
import { compactTokens, exactTokens, runTokens, stageTokens, memberTokens, SCOPE_LABELS } from '../panel/tokens.mjs';

const NOW = Date.parse('2026-11-23T05:10:00.000Z');
const usage = (extra = {}) => ({
  scope: 'complete', total: 1_300_000, retry: 180_000, unattributed: 0, sessionTotal: null,
  stages: { build: { work: 900_000, review: 400_000, retry: 180_000, total: 1_300_000, uncounted: 0, uncertain: 0, agents: { work: ['codex'], review: ['claude'] } } },
  counts: { sessions: 3, counted: 3, waiting: 0, sessionOnly: 0, missing: 0, truncated: 0, lower: 0, corrected: 0, unmapped: 0 },
  checkedAt: '2026-11-23T05:09:00.000Z', failedAt: null, error: null, ...extra,
});
const text = (html) => html.replace(/<[^>]+>/g, '');

test('compact numbers: K, M and B with at most one decimal and no trailing .0', () => {
  assert.equal(compactTokens(950), '950');
  assert.equal(compactTokens(1_000), '1K');
  assert.equal(compactTokens(1_050), '1.1K');
  assert.equal(compactTokens(245_000), '245K');
  assert.equal(compactTokens(1_250_000), '1.3M');
  assert.equal(compactTokens(1_300_000), '1.3M');
  assert.equal(compactTokens(2_000_000_000), '2B');
  assert.equal(compactTokens(0), '0');
});

test('rounding across a unit boundary moves up a unit: never 1000K or 1000M', () => {
  assert.equal(compactTokens(999_949), '999.9K');
  assert.equal(compactTokens(999_950), '1M');
  assert.equal(compactTokens(999_999), '1M');
  assert.equal(compactTokens(999_950_000), '1B');
});

test('no number is made up for a missing or invalid value', () => {
  for (const value of [null, undefined, NaN, -1, Infinity]) assert.equal(compactTokens(value), null);
});

test('the exact integer is written out in full', () => {
  assert.equal(exactTokens(1_300_000), '1,300,000 토큰');
});

test('the run card shows the compact total and opens to the exact integer by click or keyboard', () => {
  const html = runTokens(usage(), { id: 'r1', now: NOW, live: true });
  assert.match(html, /^<details class="token-usage" data-disclosure="tokens:r1">/, 'a native disclosure: click, Enter and Space open it');
  assert.match(text(html), /토큰 1\.3M/);
  assert.match(text(html), /1,300,000 토큰/);
  assert.match(text(html), /그중 재시도 180K/);
  assert.match(html, /<summary id="tok-r1-run">/, 'a stable id keeps keyboard focus across re-renders');
  assert.match(text(html), /마지막 확인/);
  assert.doesNotMatch(text(html), /일부 집계|집계 대기/);
});

test('every scope label is shown where it applies, and no 0 stands in for an unknown', () => {
  assert.deepEqual(SCOPE_LABELS, { partial: '일부 집계', pending: '집계 대기', unavailable: '집계 불가', session: '세션 누계' });
  assert.match(text(runTokens(usage({ scope: 'partial', counts: { ...usage().counts, missing: 1 } }), { id: 'r', now: NOW })), /토큰 1\.3M · 일부 집계.*목록에서 찾지 못한 세션 1개/);
  const pending = text(runTokens(usage({ scope: 'pending', total: null }), { id: 'r', now: NOW }));
  assert.match(pending, /토큰 집계 대기/);
  assert.doesNotMatch(pending, /\b0\b/);
  assert.match(text(runTokens(usage({ scope: 'unavailable', total: null, error: '현재 Orca가 agent.listSessions를 제공하지 않습니다.' }), { id: 'r', now: NOW })), /토큰 집계 불가.*제공하지 않습니다/);
  assert.match(text(runTokens(usage({ scope: 'session', total: null, sessionTotal: 1_300_000, counts: { ...usage().counts, sessionOnly: 1 } }), { id: 'r', now: NOW })), /세션 누계 1\.3M/);
  assert.match(text(runTokens(usage({ unattributed: 120_000 }), { id: 'r', now: NOW })), /단계 미분류 120K/);
});

test('a stale check shows its time on the card itself while the run is live', () => {
  const stale = usage({ checkedAt: '2026-11-23T04:50:00.000Z' });
  assert.match(text(runTokens(stale, { id: 'r', now: NOW, live: true }).split('</summary>')[0]), /마지막 확인/);
  assert.doesNotMatch(text(runTokens(usage(), { id: 'r', now: NOW, live: true }).split('</summary>')[0]), /마지막 확인/);
});

test('the stage detail splits work and review and names the retry part as included', () => {
  const html = stageTokens(usage(), { id: 'build', attempts: 2, reviewAttempts: 1 }, 'r1');
  assert.match(text(html), /작업 900K \/ 검토 400K · 그중 재시도 180K/);
  assert.match(text(html), /900,000 토큰/);
  assert.match(text(html), /400,000 토큰/);
  assert.equal(stageTokens(usage(), { id: 'test', attempts: 0, reviewAttempts: 0 }, 'r1'), '', 'a stage that never ran shows nothing');
  assert.match(text(stageTokens(usage(), { id: 'test', attempts: 1 }, 'r1')), /토큰 집계 대기/);
  assert.match(text(stageTokens(usage({ scope: 'unavailable', total: null }), { id: 'test', attempts: 1 }, 'r1')), /토큰 집계 불가/);
  assert.match(text(stageTokens(usage({ stages: { build: { ...usage().stages.build, uncertain: 1 } } }), { id: 'build', attempts: 1 }, 'r1')), /일부 집계/);
  assert.doesNotMatch(text(stageTokens(usage({ scope: 'partial' }), { id: 'build', attempts: 1 }, 'r1')), /일부 집계/, 'another stage\'s gap does not mark this one');
});

test('a phase that has not run is left out of the stage line, not shown as waiting', () => {
  const working = usage({ stages: { build: { ...usage().stages.build, review: null, total: 900_000, uncertain: 1 } } });
  const line = text(stageTokens(working, { id: 'build', attempts: 1, reviewAttempts: 0 }, 'r1'));
  assert.match(line, /^토큰 작업 900K · 그중 재시도 180K · 일부 집계/);
  assert.doesNotMatch(line.split('작업 900,000')[0], /검토/);
  assert.match(line, /확인 중인 이 단계 세션·배정 1개/);
  assert.match(text(stageTokens(working, { id: 'build', attempts: 1, reviewAttempts: 1 }, 'r1')), /작업 900K \/ 검토 집계 대기/);
});

test('an agent card shows its own phase compactly with the exact integer for assistive tech', () => {
  assert.match(memberTokens(usage(), 'build', 'work'), /900K/);
  assert.match(memberTokens(usage(), 'build', 'work'), /class="sr-only">토큰 900,000</);
  assert.match(memberTokens(usage(), 'build', 'review'), /400K/);
  assert.equal(memberTokens(usage(), 'test', 'work'), '');
});
