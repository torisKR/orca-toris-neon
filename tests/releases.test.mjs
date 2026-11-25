import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWatch, parseDeploys, labelAccounts, nextStep, readReleaseNotes, watchFor } from '../dashboard/releases.mjs';
import { scrub } from '../dashboard/join.mjs';

const WATCH = `# Play 심사 감시 목록

계정 번호: Alpha(alpha_handle) = /u/1, 베타(beta.handle) = /u/0.
- Alpha: https://play.google.com/console/u/1/developers/1234567890123456789/home

## 심사 중 (production 전체 출시로 제출)

| 앱 | package | 계정 | 버전 (versionCode) | 메모 |
|---|---|---|---|---|
| 정원 | com.example.garden | Alpha | 1.1.1 (8) | 제출 직후 빠른 검사 중. 공개되면 AdMob(beta.handle) 스토어 연결. |
| 배구 | com.example.volley | 베타 | 1.0.0 (25) | 11-23 거부 뒤 재제출 |

## 끝난 것

| 앱 | 버전 | 결과 | 확인 |
|---|---|---|---|
| 옛 앱 | 0.9 (3) | 출시 | 2026-11-21 |
| 새 앱 | 1.0 (4) | 출시, 베타 계정 메일 a@b.com 확인 | 2026-11-25 22시 |

## 감시 밖에서 본 것 (주인에게 알림)

- 베타 계정: 정책 문제 1건 (2026-11-21)
`;

test('review-watch.md: in review with next step, finished newest first, outside notes', () => {
  const watch = parseWatch(WATCH);
  assert.deepEqual(watch.errors, []);
  assert.deepEqual(watch.inReview.map((row) => [row.app, row.packageName, row.account, row.version]),
    [['정원', 'com.example.garden', 'Alpha', '1.1.1 (8)'], ['배구', 'com.example.volley', '베타', '1.0.0 (25)']]);
  assert.equal(watch.inReview[0].next, '공개되면 AdMob(beta.handle) 스토어 연결.');
  assert.equal(watch.inReview[1].next, '11-23 거부 뒤 재제출'); // no follow-up sentence: the whole memo
  assert.deepEqual(watch.done.map((row) => [row.app, row.day]), [['새 앱', '2026-11-25'], ['옛 앱', '2026-11-21']]);
  assert.deepEqual(watch.outside, ['베타 계정: 정책 문제 1건 (2026-11-21)']);
  assert.deepEqual(watch.aliases, { Alpha: ['alpha_handle'], 베타: ['beta.handle'] });
});

test('account names and handles become "Play 계정 N" in Neon order, and scrub hides the rest', () => {
  const labelled = labelAccounts(parseWatch(WATCH), new Map([['베타', 'Play 계정 1'], ['Alpha', 'Play 계정 2']]));
  assert.deepEqual(labelled.inReview.map((row) => row.account), ['Play 계정 2', 'Play 계정 1']);
  assert.equal(labelled.inReview[0].next, '공개되면 AdMob(Play 계정 1) 스토어 연결.');
  assert.equal(labelled.outside[0], 'Play 계정 1: 정책 문제 1건 (2026-11-21)');
  const out = JSON.stringify(scrub(labelled, { home: '/Users/x' }));
  for (const secret of ['Alpha', '베타', 'alpha_handle', 'beta.handle', 'a@b.com', '1234567890123456789']) assert.ok(!out.includes(secret), secret);
  // names Neon does not know are still numbered, never shown
  assert.deepEqual(labelAccounts(parseWatch(WATCH)).inReview.map((row) => row.account), ['Play 계정 1', 'Play 계정 2']);
});

test('changed columns or a missing section degrade to an error, never a throw', () => {
  const reordered = WATCH.replace('| 앱 | package | 계정 | 버전 (versionCode) | 메모 |', '| package | 메모 | 앱 | 버전 | 계정 |')
    .replace('| 정원 | com.example.garden | Alpha | 1.1.1 (8) |', '| com.example.garden | 공개되면 확인. | 정원 | 1.1.1 (8) | Alpha |');
  assert.deepEqual(parseWatch(reordered).inReview[0], { app: '정원', packageName: 'com.example.garden', account: 'Alpha', version: '1.1.1 (8)', memo: '공개되면 확인.', next: '공개되면 확인.' });
  const renamed = parseWatch(WATCH.replace('| 앱 | package |', '| 이름표 | pkg |').replace('| 앱 | 버전 | 결과 | 확인 |', '| 무엇 | 언제 |'));
  assert.equal(renamed.done.length, 0);
  assert.match(renamed.errors.join(), /끝난 것.*앱 열/);
  const missing = parseWatch('# 비어 있음\n\n그냥 글');
  assert.deepEqual([missing.inReview, missing.done, missing.outside], [[], [], []]);
  assert.equal(missing.errors.length, 2);
  assert.equal(nextStep(null), null);
});

test('deploys.md: table or one line per deploy, newest first, junk lines skipped', () => {
  const lines = '# 배포\n- 2026-11-24 · 정원 · 1.1.0 (7) · production · abc1234 · 성공\n- 2026-11-25 | 배구 | 1.0.0 (25) | internal | def5678 | 실패\n- 날짜 없는 줄\n';
  assert.deepEqual(parseDeploys(lines), [
    { date: '2026-11-25', app: '배구', version: '1.0.0 (25)', track: 'internal', commit: 'def5678', result: '실패' },
    { date: '2026-11-24', app: '정원', version: '1.1.0 (7)', track: 'production', commit: 'abc1234', result: '성공' },
  ]);
  const table = '| 날짜 | 앱 | 버전 | 트랙 | 커밋 | 결과 |\n|---|---|---|---|---|---|\n| 2026-11-25 10:00 | 정원 | 1.1.1 (8) | production | 9f9f9f9 | 제출 |\n';
  assert.deepEqual(parseDeploys(table), [{ date: '2026-11-25', app: '정원', version: '1.1.1 (8)', track: 'production', commit: '9f9f9f9', result: '제출' }]);
  assert.deepEqual(parseDeploys('엉망 | 표 아님'), []);
});

test('missing files are reported, not thrown; deploys.md is optional', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'release-notes-'));
  try {
    const none = await readReleaseNotes(dir);
    assert.equal(none.watch, null);
    assert.match(none.watchError, /review-watch\.md/);
    assert.equal(none.deploysError, null);
    await fs.writeFile(path.join(dir, 'review-watch.md'), WATCH);
    const read = await readReleaseNotes(dir);
    assert.equal(read.watchError, null);
    assert.equal(read.watch.inReview.length, 2);
    assert.ok(read.watchAt > 0);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('an app finds its watch entry by package id, else a finished one by exact name', () => {
  const watch = labelAccounts(parseWatch(WATCH));
  const app = (name, packageIds) => ({ name, projectName: null, packageIds, play: [] });
  assert.equal(watchFor(app('Garden', ['com.example.garden']), watch).state, 'review');
  assert.deepEqual(watchFor(app('새 앱', []), watch), { state: 'done', version: '1.0 (4)', result: watch.done[0].result, day: '2026-11-25' });
  assert.equal(watchFor(app('다른 앱', ['com.other']), watch), null);
});
