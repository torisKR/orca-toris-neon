import test from 'node:test';
import assert from 'node:assert/strict';
import { conditionMismatches, improvementRate, median, kindResult } from '../panel/kindresult.mjs';
import { runResult } from '../panel/result.mjs';
import { createRun, templateGraph } from '../src/engine.mjs';

const NOW = '2026-11-23T01:00:00.000Z';
const conditions = (overrides = {}) => ({ device: 'Pixel 7', size: '1080x2400', language: 'ko-KR', data: '샘플 3개', ...overrides });
const measurement = (values, overrides = {}) => ({ scenario: '콜드 스타트', environment: 'Pixel 6 · release', samples: values.length,
  metrics: [{ name: '첫 화면', unit: 'ms', better: 'lower', values }], ...overrides });
function improveRun(kind, reports = {}, extra = {}) {
  const run = { ...createRun({ id: 'r1', goal: '개선', now: NOW, nodes: templateGraph('improve', { kind }) }), template: 'improve',
    improvement: { kind, options: {}, projectName: 'water', playLink: null }, jobs: [], ...extra };
  for (const [id, report] of Object.entries(reports)) {
    Object.assign(run.nodes.find((node) => node.id === id), { status: 'passed', report: { outcome: 'passed', summary: id, evidence: [], ...report } });
  }
  return run;
}
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('condition mismatches name each differing key with both values', () => {
  assert.deepEqual(conditionMismatches(conditions(), conditions()), []);
  assert.deepEqual(conditionMismatches(conditions(), conditions({ language: 'en-US', data: '빈 데이터' })),
    [{ key: 'language', label: '언어', before: 'ko-KR', after: 'en-US' }, { key: 'data', label: '데이터', before: '샘플 3개', after: '빈 데이터' }]);
});

test('the design card shows both conditions and flags a mismatch', () => {
  // Arrange
  const matched = improveRun('design', { design: { comparison: { before: conditions() } }, test: { comparison: { after: conditions() } } });
  const mismatched = improveRun('design', { design: { comparison: { before: conditions() } }, test: { comparison: { after: conditions({ language: 'en-US' }) } } });
  // Act
  const ok = text(kindResult(matched));
  const flagged = kindResult(mismatched);
  // Assert
  assert.match(ok, /비교 조건/);
  assert.match(ok, /같은 조건/);
  assert.match(flagged, /class="callout warning"/);
  assert.match(text(flagged), /조건이 다릅니다.*언어 ko-KR → en-US/);
  assert.match(text(flagged), /en-US \(변경 전과 다름\)/, 'the differing cell itself says so');
  assert.match(flagged, /<caption class="sr-only">촬영 조건 비교<\/caption>/);
  assert.match(flagged, /<h4>비교 조건<\/h4>/);
});

test('the design card says the after conditions are missing instead of implying a fair comparison', () => {
  const run = improveRun('design', { design: { comparison: { before: conditions() } } });
  assert.match(text(kindResult(run)), /변경 후 촬영 조건이 아직 없습니다/);
});

test('the median and rate come only from real numbers; a zero baseline gives no rate', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([0.1, 0.2]), 0.15);
  assert.equal(improvementRate(1000, 800, 'lower'), 20);
  assert.equal(improvementRate(50, 60, 'higher'), 20);
  assert.equal(improvementRate(1000, 1100, 'lower'), -10);
  assert.equal(improvementRate(0, 10, 'lower'), null);
});

test('the performance card never shows an improvement rate without both measurements', () => {
  // Arrange
  const baselineOnly = improveRun('performance', { measure: { measurement: measurement([1000, 1000, 1000]) } });
  const both = improveRun('performance', { measure: { measurement: measurement([1000, 1000, 1000]) }, test: { measurement: measurement([800, 800, 800]) } });
  const afterOnly = improveRun('performance', { test: { measurement: measurement([800, 800, 800]) } });
  // Act
  const pending = text(kindResult(baselineOnly)), measured = text(kindResult(both)), orphan = text(kindResult(afterOnly));
  // Assert
  assert.doesNotMatch(pending, /%/);
  assert.match(pending, /수정 후 측정이 없어 개선율을 표시하지 않습니다/);
  assert.match(measured, /20(\.0)?% 개선/);
  assert.match(measured, /n=3/);
  assert.match(measured, /콜드 스타트/);
  assert.doesNotMatch(orphan, /%/);
  assert.match(orphan, /기준 측정이 없어/);
});

test('the performance card shows no rate when the conditions or a metric differ', () => {
  // Arrange
  const run = improveRun('performance', { measure: { measurement: measurement([1000, 1000]) },
    test: { measurement: measurement([800, 800], { environment: 'Pixel 8 · debug' }) } });
  const missingMetric = improveRun('performance', { measure: { measurement: measurement([1000]) },
    test: { measurement: { ...measurement([800]), metrics: [{ name: '메모리', unit: 'MB', better: 'lower', values: [90] }] } } });
  // Act / Assert
  assert.doesNotMatch(text(kindResult(run)), /%/);
  assert.match(text(kindResult(run)), /측정 조건이 달라/);
  assert.doesNotMatch(text(kindResult(missingMetric)), /\d%/);
  const units = improveRun('performance', { measure: { measurement: measurement([1000]) },
    test: { measurement: { ...measurement([1]), metrics: [{ name: '첫 화면', unit: 's', better: 'lower', values: [1] }] } } });
  assert.doesNotMatch(text(kindResult(units)), /\d%/, 'different units never give a rate');
  assert.match(text(kindResult(units)), /비교할 수 있는 지표가 없습니다/);
});

test('the release card links commit, artifact, account, package, track and versionCode and flags what differs from the approval', () => {
  // Arrange
  const link = { commit: 'a1b2c3d4e5f6', artifact: 'app-release.aab', sha256: 'f'.repeat(64), packageName: 'com.example.water', track: 'internal', versionCode: '43' };
  const run = improveRun('release', { internal: { releaseLink: link } }, { improvement: { kind: 'release', options: {}, projectName: 'water', playLink: null,
    lastVerified: { runId: 'old', commit: 'b'.repeat(40), at: NOW } } });
  const internal = run.nodes.find((node) => node.id === 'internal');
  internal.approval = { submission: { accountId: 'acc-1', developerId: '123', packageName: 'com.example.water', track: 'internal', versionCode: '44' } };
  internal.review = { outcome: 'passed', nonce: 'rev-internal' };
  run.jobs.push({ nodeId: 'internal', phase: 'review', nonce: 'rev-internal', sourceCommit: 'a1b2c3d4e5f6' + '0'.repeat(28) });
  // Act
  const html = kindResult(run), plain = text(html);
  // Assert
  for (const label of ['소스 커밋', '빌드 아티팩트', '계정', '패키지', '트랙', 'versionCode']) assert.match(plain, new RegExp(label));
  assert.match(plain, /a1b2c3d4e5f6/);
  assert.match(plain, /acc-1/);
  assert.match(plain, /승인한 versionCode 44.*보고서 43/);
  assert.match(plain, /재검증 기준: 마지막 검증 커밋 bbbbbbbbbbbb 이후 변경분만 재검증하도록 지시했습니다/);
  assert.doesNotMatch(plain, /검토한 커밋과 다릅니다/, 'the reviewed commit matches the linked one');
});

test('the release card shows the file Neon read itself, or says the file was never checked', () => {
  // Arrange
  const link = { commit: 'a1b2c3d4e5f6', artifact: 'app-release.aab', packageName: 'com.example.water', track: 'internal', versionCode: '43' };
  const checked = improveRun('release', { internal: { releaseLink: { ...link, binary: { format: 'aab', sha256: 'd'.repeat(64), packageName: 'com.example.water', versionCode: '43', signingCertSha256: 'e'.repeat(64), artifact: 'app-release.aab', checkedAt: NOW } } } });
  const unchecked = improveRun('release', { internal: { releaseLink: link } });
  // Act
  const seen = text(kindResult(checked)), unseen = text(kindResult(unchecked));
  // Assert
  assert.match(seen, /Neon이 읽은 파일 AAB · sha256 dddddddddddd · com\.example\.water · versionCode 43 · 서명 인증서 eeeeeeeeeeee/);
  assert.match(unseen, /Neon이 읽은 파일 확인 기록 없음/);
});

test('the release card says when no link was reported or no verified commit existed', () => {
  const run = improveRun('release', { test: {} });
  const plain = text(kindResult(run));
  assert.match(plain, /이전 검증 기록이 없어 전체를 다시 검증하도록 지시했습니다/);
  assert.doesNotMatch(plain, /소스 커밋/);
});

test('reused parent evidence is counted fresh and stale on the run card', () => {
  // Arrange
  const run = improveRun('bugfix', { build: { changes: ['x'] } }, { parentRunId: 'p0' });
  run.jobs.push({ nodeId: 'build', phase: 'work', nonce: 'w1', parentEvidence: { items: [
    { nodeId: 'identity', title: '앱 정체성 확인', freshness: 'fresh' }, { nodeId: 'test', title: '검증', freshness: 'stale' }] } });
  const parent = improveRun('bugfix', {}, { id: 'p0' });
  // Act
  const plain = text(runResult(run, { runs: [parent, run], play: null }));
  // Assert
  assert.match(plain, /이전 결과 근거.*재사용 1.*오래됨 1/);
  assert.match(plain, /오래됨: 검증 — 소스가 바뀌어/);
  run.jobs.push({ nodeId: 'test', phase: 'work', nonce: 'w2', parentEvidence: { reason: 'symlink 포함', items: [{ nodeId: 'test', title: '검증', freshness: 'stale' }] } });
  assert.match(text(runResult(run, { runs: [parent, run], play: null })), /잴 수 없어.*symlink 포함/, 'an unmeasurable source is not reported as a changed one');
});

test('other kinds and new-app runs get no kind block', () => {
  assert.equal(kindResult(improveRun('bugfix', { build: {} })), '');
  assert.equal(kindResult({ ...improveRun('design'), template: 'new-app' }), '');
});

test('evidence that went stale just before delivery says the source moved, not that it could not be measured', () => {
  // Arrange
  const run = improveRun('bugfix', { build: { changes: ['x'] } }, { parentRunId: 'p0' });
  run.jobs.push({ nodeId: 'build', phase: 'work', nonce: 'w1', parentEvidence: { changedBeforeDelivery: true, reason: '작업 지시를 전달하기 직전에 다시 재 보니 소스가 바뀌었습니다',
    items: [{ nodeId: 'identity', title: '앱 정체성 확인', freshness: 'stale' }] } });
  // Act
  const plain = text(kindResult(run));
  // Assert
  assert.match(plain, /재사용 0개 · 오래됨 1개/);
  assert.match(plain, /작업 지시를 전달하기 직전에 소스가 바뀌어 재사용하지 않았습니다/);
  assert.doesNotMatch(plain, /잴 수 없어/);
});
