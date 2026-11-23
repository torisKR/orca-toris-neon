import test from 'node:test';
import assert from 'node:assert/strict';
import { preflightBlock, preflightSummary } from '../panel/preflight.mjs';

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const flutterMissing = { state: 'blocked', text: 'Flutter SDK(flutter)을(를) 찾지 못했습니다.', fix: 'Flutter SDK를 설치하세요.' };
const noAccount = { state: 'check', text: '연결된 Play 제출 계정이 없어 제출 없이 준비만 합니다.', fix: 'Play Store 탭에서 개발자 계정과 패키지를 연결하세요.' };
const result = {
  runId: 'run-1', at: '2026-11-23T05:00:00.000Z', overall: 'blocked', counts: { ready: 2, blocked: 2, check: 1 }, conclusive: true, stack: 'Flutter/Dart',
  stages: [
    { id: 'research', title: '시장·앱 조사', state: 'ready', reasons: [] },
    { id: 'brief', title: '제품 기획', state: 'ready', reasons: [] },
    { id: 'build', title: '앱 구현', state: 'blocked', reasons: [flutterMissing] },
    { id: 'test', title: '테스트·수정 루프', state: 'blocked', reasons: [flutterMissing] },
    { id: 'internal', title: '내부 테스트 제출', state: 'check', reasons: [noAccount] },
  ],
};

test('the card shows the overall verdict, the counts and each problem once with its stages and what to do', () => {
  // Act
  const html = preflightBlock({ value: result }, { runId: 'run-1' });
  const plain = text(html);
  // Assert
  assert.match(plain, /실행 전 점검/);
  assert.match(plain, /해당 단계 불가 2/);
  assert.match(plain, /확인 필요 1/);
  assert.match(plain, /실행 가능 2/);
  assert.equal(plain.match(/Flutter SDK\(flutter\)을\(를\) 찾지 못했습니다/g).length, 1);
  assert.match(plain, /앱 구현, 테스트·수정 루프/);
  assert.match(plain, /할 일: Flutter SDK를 설치하세요/);
  assert.ok(plain.indexOf('Flutter SDK') < plain.indexOf('Play 제출 계정'), 'blocked problems come before checks');
  assert.match(html, /data-action="recheck-preflight" data-run="run-1"/);
});

test('an all-ready run says so in one line without a problem list', () => {
  const ready = { ...result, overall: 'ready', counts: { ready: 5, blocked: 0, check: 0 }, stages: result.stages.map((item) => ({ ...item, state: 'ready', reasons: [] })) };
  const plain = text(preflightBlock({ value: ready }, { runId: 'run-1' }));
  assert.match(plain, /실행 가능 5/);
  assert.doesNotMatch(plain, /할 일/);
});

test('an inconclusive tool lookup is explained so 확인 필요 is not read as missing', () => {
  const plain = text(preflightBlock({ value: { ...result, conclusive: false } }, { runId: 'run-1' }));
  assert.match(plain, /로그인 셸/);
});

test('loading and failure states are shown instead of a made-up verdict', () => {
  assert.match(text(preflightBlock({ loading: true }, { runId: 'run-1' })), /점검하고 있습니다/);
  const failed = preflightBlock({ error: 'timeout <b>' }, { runId: 'run-1' });
  assert.match(text(failed), /하지 못했습니다/);
  assert.ok(failed.includes('timeout &lt;b&gt;'), 'the error text is escaped');
  assert.equal(preflightBlock(null, { runId: 'run-1' }), '');
});

test('the same text in two states stays two problems, so a blocked stage is never shown as 확인 필요', () => {
  const soft = { ...flutterMissing, state: 'check' };
  const mixed = { ...result, stages: [{ id: 'identity', title: '앱 정체성 확인', state: 'check', reasons: [soft] }, { id: 'build', title: '앱 구현', state: 'blocked', reasons: [flutterMissing] }] };
  const html = preflightBlock({ value: mixed }, { runId: 'run-1' });
  assert.equal((html.match(/Flutter SDK\(flutter\)/g) ?? []).length, 2);
  assert.ok(html.indexOf('badge failed') < html.indexOf('badge blocked', html.indexOf('preflight-list')), 'the blocked one is listed first');
});

test('a failed recheck is shown above the previous result instead of passing it off as current', () => {
  const plain = text(preflightBlock({ value: result, error: '시간 초과' }, { runId: 'run-1' }));
  assert.match(plain, /다시 점검하지 못했습니다: 시간 초과/);
  assert.match(plain, /이전 결과/);
});

test('a check that failed outright is listed once, before the stage problems', () => {
  const notice = { state: 'check', text: '설치된 SDK·도구을(를) 확인하지 못했습니다(정해진 시간 안에 답이 없음).', fix: '다시 점검을 누르세요.' };
  const plain = text(preflightBlock({ value: { ...result, notices: [notice] } }, { runId: 'run-1' }));
  assert.ok(plain.indexOf('설치된 SDK·도구') < plain.indexOf('Flutter SDK'));
});

test('while rechecking the button says so and is disabled; the heading names the section', () => {
  const html = preflightBlock({ value: result, loading: true }, { runId: 'run-1' });
  assert.match(html, /data-action="recheck-preflight" data-run="run-1" disabled>점검 중…/);
  assert.match(html, /<section class="preflight" aria-labelledby="preflight-run-1"><div class="preflight-head"><h2 class="preflight-title" id="preflight-run-1">/);
});

test('the announcement after a requested recheck is one sentence with the verdict and counts', () => {
  assert.equal(preflightSummary({ value: result }), '실행 전 점검 완료: 해당 단계 불가. 해당 단계 불가 2, 확인 필요 1, 실행 가능 2');
  assert.equal(preflightSummary({ error: '시간 초과' }), '실행 전 점검을 하지 못했습니다: 시간 초과');
});
