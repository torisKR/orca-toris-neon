import test from 'node:test';
import assert from 'node:assert/strict';
import { completionLabel, stageResult, runResult } from '../panel/result.mjs';
import { createRun, templateGraph } from '../src/engine.mjs';

const NOW = '2026-11-23T01:00:00.000Z';
function releaseRun() {
  const run = { ...createRun({ id: 'r1', goal: '알림 수정', now: NOW, nodes: templateGraph('improve', { kind: 'release' }) }), template: 'improve' };
  return run;
}
const pass = (run, id, extra = {}) => Object.assign(run.nodes.find((node) => node.id === id), { status: 'passed', report: { outcome: 'passed', summary: id + ' 완료', evidence: [] } }, extra);
const submission = { accountId: 'acc-1', developerId: '123', packageName: 'com.example.water', track: 'production', versionCode: '43' };
const play = (state, overrides = {}) => ({ accounts: [{ id: 'acc-1', apps: [{ packageName: 'com.example.water',
  tracks: [{ track: 'production', observedAt: NOW, stale: false, releases: [{ versionCodes: [43], state }] }] }], ...overrides }] });

test('the completion label climbs only on evidence: built, verified, ready, submitted, then observed published', () => {
  const bugfix = { ...createRun({ id: 'b', goal: 'x', now: NOW, nodes: templateGraph('improve', { kind: 'bugfix' }) }), template: 'improve' };
  assert.equal(completionLabel(bugfix, null), null);
  pass(bugfix, 'build');
  assert.equal(completionLabel(bugfix, null), '구현 결과 생성');
  pass(bugfix, 'test');
  assert.equal(completionLabel(bugfix, null), '검증 완료');
  const run = releaseRun();
  pass(run, 'test'); pass(run, 'release');
  assert.equal(completionLabel(run, null), '출시 준비 완료');
  pass(run, 'internal', { approval: { submission: { ...submission, track: 'internal' } } });
  assert.equal(completionLabel(run, null), '내부 테스트 제출 확인');
  pass(run, 'release', { approval: { submission } });
  assert.equal(completionLabel(run, null), '내부 테스트 제출 확인', 'an approved production submission alone is not "published"');
  assert.equal(completionLabel(run, play('in_review')), '내부 테스트 제출 확인');
  assert.equal(completionLabel(run, play('published')), '프로덕션 게시 확인');
});

test('"published" needs the same account, package, track and version, freshly observed', () => {
  const run = releaseRun();
  pass(run, 'release', { approval: { submission } });
  assert.equal(completionLabel({ ...run, nodes: run.nodes.map((node) => node.id === 'release' ? node : { ...node, status: node.id === 'test' ? 'passed' : node.status }) }, null), '출시 준비 완료',
    'a production submission not yet seen on Play is not an internal-test submission either');
  const wrong = (mutate) => { const data = play('published'); mutate(data.accounts[0]); return completionLabel(run, data); };
  assert.notEqual(wrong((account) => { account.id = 'acc-2'; }), '프로덕션 게시 확인');
  assert.notEqual(wrong((account) => { account.apps[0].packageName = 'com.other'; }), '프로덕션 게시 확인');
  assert.notEqual(wrong((account) => { account.apps[0].tracks[0].track = 'beta'; }), '프로덕션 게시 확인');
  assert.notEqual(wrong((account) => { account.apps[0].tracks[0].releases[0].versionCodes = [42]; }), '프로덕션 게시 확인');
  assert.notEqual(wrong((account) => { account.apps[0].tracks[0].stale = true; }), '프로덕션 게시 확인');
  assert.notEqual(completionLabel({ ...run, nodes: run.nodes.map((node) => ({ ...node, status: node.id === 'release' ? 'pending' : node.status })) }, play('published')), '프로덕션 게시 확인');
});

const report = {
  outcome: 'passed', summary: '중복 알림 제거',
  changes: ['NotificationScheduler가 같은 알림을 두 번 예약하지 않음'],
  criteria: [{ criterion: '알림이 한 번만 울린다', met: true, evidence: '테스트 통과' }, { criterion: 'Android 9에서 확인', met: false }],
  beforeAfter: [{ label: '예약 수', before: '2', after: '1' }],
  notVerified: ['Android 9 실기기'],
  evidence: [
    { kind: 'command', command: './gradlew test', exitCode: 0 },
    { kind: 'command', command: './gradlew test (첫 시도)', exitCode: 1, role: 'history' },
    { kind: 'artifact', path: '/r/r1/build/after.png', label: 'screenshot' },
    { kind: 'artifact', path: '/r/r1/build/mock.webp', label: 'mockup' },
    { kind: 'artifact', path: '/r/r1/build/build.log' },
  ],
};

test('a stage result card reads in order: changed, criteria, before/after, checks run, not verified, improve', () => {
  const html = stageResult({ id: 'r1' }, { id: 'build', report }, { artifacts: new Map() });
  const order = ['바뀐 것', '완료 기준', '이전 → 이후', '실행한 검증', '검증하지 못한 것', '이 결과 더 개선하기'].map((text) => html.indexOf(text));
  assert.ok(order.every((index) => index >= 0), String(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(html, /충족[\s\S]*알림이 한 번만 울린다/);
  assert.match(html, /미충족[\s\S]*Android 9에서 확인/);
  assert.match(html, /\.\/gradlew test/);
  assert.doesNotMatch(html, /첫 시도/, 'history commands are not "checks run"');
  assert.match(html, /실제 화면/);
  assert.match(html, /시안/);
  assert.doesNotMatch(html, /data:image/, 'nothing is loaded until asked');
  assert.match(html, /data-action="load-artifact"[^>]*data-path="\/r\/r1\/build\/after\.png"/);
  assert.doesNotMatch(html, /PASS|HOLD|BLOCK/);
});

test('a loaded artifact shows inline with alt text; a log shows a bounded excerpt; an error is said', () => {
  const artifacts = new Map([
    ['/r/r1/build/after.png', { kind: 'image', mime: 'image/png', data: 'AAAA' }],
    ['/r/r1/build/build.log', { kind: 'text', text: 'BUILD SUCCESSFUL', truncated: true }],
    ['/r/r1/build/mock.webp', { error: '파일 크기가 너무 큽니다' }],
  ]);
  const html = stageResult({ id: 'r1' }, { id: 'build', report }, { artifacts });
  assert.match(html, /<img[^>]+src="data:image\/png;base64,AAAA"[^>]+alt="실제 화면[^"]*after\.png"/);
  assert.match(html, /BUILD SUCCESSFUL/);
  assert.match(html, /앞부분만/);
  assert.match(html, /파일 크기가 너무 큽니다/);
});

test('a report without result fields shows no empty card', () => {
  assert.equal(stageResult({ id: 'r1' }, { id: 'build', report: { outcome: 'passed', summary: 's', evidence: [] } }, { artifacts: new Map() }), '');
});

test('the run result gives the completion label, totals, the chain and the improve action', () => {
  const run = { ...createRun({ id: 'r2', goal: '알림 설정 정리', now: NOW, nodes: templateGraph('improve', { kind: 'bugfix' }) }), template: 'improve', parentRunId: 'r1' };
  pass(run, 'build', { report });
  const html = runResult(run, { runs: [{ id: 'r1', goal: '알림 수정' }, run, { id: 'r3', goal: '다음 개선', parentRunId: 'r2' }], play: null });
  assert.match(html, /구현 결과 생성/);
  assert.match(html, /완료 기준 1 \/ 2/);
  assert.match(html, /data-action="open-run" data-run="r1"[^>]*>[^<]*알림 수정/);
  assert.match(html, /data-action="open-run" data-run="r3"/);
  assert.match(html, /data-action="improve-result" data-run="r2"/);
  assert.equal(runResult({ ...run, nodes: run.nodes.map((node) => ({ ...node, status: 'pending', report: null })), parentRunId: undefined }, { runs: [], play: null }), '');
});

test('a failed load keeps a retry button; the load button\'s name starts with its visible text; a description becomes the alt', () => {
  const item = { ...report, evidence: [{ kind: 'artifact', path: '/r/r1/build/after.png', label: 'screenshot', description: '알림 설정 화면, 토글 하나' }] };
  const failed = stageResult({ id: 'r1' }, { id: 'build', report: item }, { artifacts: new Map([['/r/r1/build/after.png', { error: '불러오지 못했습니다: 시간 초과' }]]) });
  assert.match(failed, /시간 초과[\s\S]*data-action="load-artifact"/);
  assert.match(failed, /aria-label="보기: 실제 화면 after\.png"/);
  const shown = stageResult({ id: 'r1' }, { id: 'build', report: item }, { artifacts: new Map([['/r/r1/build/after.png', { kind: 'image', mime: 'image/png', data: 'AA' }]]) });
  assert.match(shown, /alt="실제 화면: 알림 설정 화면, 토글 하나"/);
  assert.match(stageResult({ id: 'r1' }, { id: 'build', report: { ...item, evidence: [{ kind: 'artifact', path: '/x/a.png', label: 'constructor' }] } }, { artifacts: new Map() }), /구분 없음/);
});

test('without a fresh Play reading the run result says why "published" is not shown', () => {
  const run = releaseRun();
  pass(run, 'release', { approval: { submission } });
  assert.match(runResult(run, { runs: [run], play: null, playError: '네트워크 오류' }), /Play 상태를 읽지 못해[^<]*네트워크 오류/);
  const stale = play('published'); stale.accounts[0].apps[0].tracks[0].stale = true;
  assert.match(runResult(run, { runs: [run], play: stale }), /오래됐거나 오류/);
  assert.match(runResult(run, { runs: [run], play: { accounts: [] } }), /트랙 상태를 읽지 못했습니다/);
});

test('"published" shows what Play was observed to show: track, version, state and time, and that the rollout share is not checked', () => {
  const run = releaseRun();
  pass(run, 'release', { approval: { submission } });
  const html = runResult(run, { runs: [run], play: play('published') });
  assert.match(html, /프로덕션 게시 확인/);
  assert.match(html, /production · versionCode 43 · 게시됨/);
  assert.match(html, /관측 /);
  assert.match(html, /배포 비율[^<]*확인하지 않/);
});
