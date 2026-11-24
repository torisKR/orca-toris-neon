import test from 'node:test';
import assert from 'node:assert/strict';
import { historyRecord, redactText, HISTORY_FORMAT } from '../src/history.mjs';
import { historyPage } from '../src/historypage.mjs';

const AT = '2026-11-24T05:00:00.000Z';
const WS = '/Users/me/projects/water/.worktrees/neon-abc';
const RECEIPTS = '/Users/me/.toris-neon/runs';
const where = { receiptRoot: RECEIPTS, home: '/Users/me', exportedAt: AT };

function finishedRun(extra = {}) {
  return {
    id: 'run-1', goal: '물주기 알림 앱 <script>alert(1)</script>', template: 'improve', improvement: { kind: 'release', playLink: { accountId: 'acc-secret', packageName: 'com.example.water' } },
    status: 'completed', createdAt: '2026-11-23T00:00:00.000Z', updatedAt: '2026-11-23T05:00:00.000Z', workspacePath: WS, projectId: 'p1',
    usage: { frozen: { scope: 'complete', total: 245_000, retry: 0, unattributed: 0, sessionTotal: null, stages: { build: { work: 200_000, review: 45_000, total: 245_000 } }, counts: { sessions: 2, counted: 2 } } },
    nodes: [
      { id: 'build', title: '앱 구현', status: 'passed',
        report: { outcome: 'passed', phase: 'work', nonce: 'n1', attempt: 1, summary: '빌드 성공. 로그: ' + WS + '/build/out.log, 키: storePassword=hunter2',
          changes: ['알림 반복 버그 수정'], criteria: [{ criterion: '알림 한 번', met: true, evidence: '로그 확인' }], notVerified: ['Android 9'],
          evidence: [
            { kind: 'command', command: 'flutter build appbundle --ks-pass pass:hunter2', exitCode: 0 },
            { kind: 'command', command: 'flutter test (첫 시도)', exitCode: 1, role: 'history' },
            { kind: 'artifact', path: 'after.png', label: 'screenshot', sha256: 'a'.repeat(64) },
            { kind: 'artifact', path: WS + '/build/out.log', sha256: 'b'.repeat(64) },
            { kind: 'note', text: 'Authorization: Bearer ya29.secret-token-value' },
          ] },
        review: { outcome: 'passed', phase: 'review', summary: '검토 통과 ghp_abcdefghijklmnopqrstuvwxyz0123456789' } },
      { id: 'internal', title: '내부 테스트 제출', status: 'passed',
        approval: { note: '승인', submission: { accountId: 'acc-secret', developerId: '9999999999', accountName: 'My Store', packageName: 'com.example.water', track: 'internal', versionCode: '43' } },
        report: { outcome: 'passed', phase: 'work', summary: '-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY----- 서비스 계정 neon@proj.iam.gserviceaccount.com "private_key": "abc"',
          releaseLink: { commit: 'a1b2c3d4e5f6', artifact: 'build/app-release.aab', packageName: 'com.example.water', track: 'internal', versionCode: '43',
            binary: { format: 'aab', sha256: 'c'.repeat(64), packageName: 'com.example.water', versionCode: '43', signingCertSha256: 'd'.repeat(64), artifact: 'build/app-release.aab', checkedAt: AT } },
          evidence: [] } },
      { id: 'release', title: '출시 제출', status: 'blocked', report: null, review: null },
    ],
    ...extra,
  };
}
const play = { accounts: [{ id: 'acc-secret', name: 'My Store', developerId: '9999999999', hasCredential: true, apps: [
  { packageName: 'com.example.water', tracks: [{ track: 'internal', observedAt: AT, stale: false, error: null, attemptedAt: AT, releases: [{ name: '43', state: 'in_review', versionCodes: [43] }] }] },
  { packageName: 'com.example.other', tracks: [] }] }] };

test('a finished run becomes a snapshot record: stage verdicts, result card content, checks run, tokens, release and Play observations', () => {
  // Act
  const record = historyRecord(finishedRun(), { ...where, play, thumbnails: { 'build:after.png': 'thumbs/build-1.png' } });
  // Assert
  assert.equal(record.format, HISTORY_FORMAT);
  assert.equal(record.snapshot, true);
  assert.equal(record.exportedAt, AT);
  assert.equal(record.run.status, 'completed');
  const build = record.stages.find((stage) => stage.id === 'build');
  assert.deepEqual([build.work.outcome, build.review.outcome], ['passed', 'passed']);
  assert.deepEqual(build.changes, ['알림 반복 버그 수정']);
  assert.deepEqual(build.notVerified, ['Android 9']);
  assert.equal(build.checks.length, 1, 'history commands are not checks run');
  assert.equal(build.checks[0].exitCode, 0);
  assert.deepEqual(build.files.map((file) => [file.path, file.sha256.slice(0, 4), file.thumbnail ?? null]), [['결과 폴더/after.png', 'aaaa', 'thumbs/build-1.png'], ['build/out.log', 'bbbb', null]]);
  assert.equal(record.tokens.total, 245_000);
  const internal = record.stages.find((stage) => stage.id === 'internal');
  assert.deepEqual(internal.submission, { packageName: 'com.example.water', track: 'internal', versionCode: '43' });
  assert.equal(internal.releaseLink.binary.signingCertSha256, 'd'.repeat(64));
  assert.deepEqual([internal.releaseLink.packageName, internal.releaseLink.track, internal.releaseLink.versionCode], ['com.example.water', 'internal', '43']);
  assert.equal(internal.releaseLink.artifact, 'build/app-release.aab', 'a release link path is workspace-relative, not a result-folder file');
  assert.deepEqual(record.play, [{ packageName: 'com.example.water', tracks: [{ track: 'internal', observedAt: AT, stale: false, releases: [{ state: 'in_review', versionCodes: [43] }] }] }]);
  assert.equal(record.stages.find((stage) => stage.id === 'release').work, null);
});

test('no absolute path, secret, token, key, service account or Play account identity leaves the machine', () => {
  // Act
  const json = JSON.stringify(historyRecord(finishedRun(), { ...where, play }));
  // Assert
  for (const leaked of ['/Users/me', 'hunter2', 'ya29.secret', 'ghp_abcdefghijklmnopqrstuvwxyz', 'BEGIN PRIVATE KEY', 'MIIEv', 'iam.gserviceaccount.com', '"private_key"', 'acc-secret', '9999999999', 'My Store', '.toris-neon']) {
    assert.ok(!json.includes(leaked), 'leaked ' + leaked);
  }
  assert.match(json, /build\/out\.log/);
});

test('free text is redacted the same way wherever it appears', () => {
  const context = { workspacePath: WS, receiptRoot: RECEIPTS, runId: 'run-1', home: '/Users/me' };
  assert.equal(redactText('see ' + WS + '/lib/main.dart', context), 'see lib/main.dart');
  assert.equal(redactText('copied to /Users/someone/Desktop/a.png', context), 'copied to ~/Desktop/a.png');
  assert.equal(redactText('token: abc123 and api_key=xyz', context), 'token: [제거됨] and api_key=[제거됨]');
  assert.equal(redactText('preview/run/identity/example.md and /example/notes', { ...context, home: '/example' }), 'preview/run/identity/example.md and ~/notes', 'a home path inside a relative path is left alone');
  for (const secret of ['storePassword "hunter two"', "password='abc'", 'password = "abc"', 'client_secret = "a b"', 'KEYSTORE_PASSWORD=abc', 'MY_SECRET_TOKEN=abc',
    'postgres://user:pw123@db.example.com/app', 'Authorization: Basic dXNlcjpwYXNz', 'npm_abcdefghijklmnopqrstuvwxyz0123456789', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlX3ZhbHVl']) {
    const out = redactText('x ' + secret + ' y', context);
    for (const value of ['hunter', 'abc', 'a b', 'pw123', 'dXNlcjpwYXNz', 'npm_abcdef', 'eyJzdWIiOiIxIn0']) assert.ok(!out.includes(value) || !secret.includes(value), secret + ' → ' + out);
  }
  assert.ok(!redactText('-----BEGIN PRIVATE KEY-----\n' + 'A'.repeat(5000), context).includes('AAAA'), 'a key cut off before its END marker is still removed');
  assert.equal(redactText('AKIAABCDEFGHIJKLMNOP sk-abcdefghijklmnopqrstu', context), '[제거됨] [제거됨]');
});

test('the static page marks the snapshot and its export time, escapes every value and runs no script', () => {
  // Act
  const html = historyPage(historyRecord(finishedRun(), { ...where, play, thumbnails: { 'build:after.png': 'thumbs/build-1.png' } }));
  // Assert
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /내보낸 시점의 스냅샷/);
  assert.match(html, /<time datetime="2026-11-24T05:00:00.000Z">/);
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /<img src="thumbs\/build-1\.png" alt="[^"]+"/);
  assert.match(html, /245K/);
  assert.match(html, /prefers-color-scheme: dark/);
});

test('the record keeps minutes worked, waiting and tokens per stage, and a skipped release stage is never shown as passed', () => {
  // Arrange
  const run = finishedRun({ jobs: [
    { nodeId: 'build', phase: 'work', startedAt: '2026-11-23T00:00:00.000Z', completedAt: '2026-11-23T00:40:00.000Z', promptSeen: true, outcome: 'passed', state: 'complete' },
    { nodeId: 'build', phase: 'review', startedAt: '2026-11-23T00:45:00.000Z', completedAt: '2026-11-23T00:55:00.000Z', promptSeen: true, outcome: 'passed', state: 'complete' }] });
  run.nodes.push({ id: 'listing', title: '스토어 자료', status: 'skipped', deps: ['build'] });

  // Act
  const record = historyRecord(run, where);
  const page = historyPage(record);

  // Assert
  assert.deepEqual(record.costs.stages.build, { work: { minutes: 40, tokens: 200_000 }, review: { minutes: 10, tokens: 45_000 }, waitingMinutes: 5, unknown: 0 });
  assert.equal(record.costs.total.workedMinutes, 50);
  assert.match(page, /단계별 시간·토큰/);
  assert.match(page, /작업 50분 · 대기 5분 · 토큰 245K/);
  assert.match(page, /스토어 자료 <span class="muted">· 건너뜀/);
  assert.equal(record.stages.find((item) => item.id === 'listing').status, 'skipped');
  assert.equal(record.stages.find((item) => item.id === 'listing').work, null, 'no verdict for a stage that never ran');
});
