import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseState, parseBacklog, backlogSummary, backlogFor, readBacklog } from '../dashboard/backlog.mjs';
import { scrub } from '../dashboard/join.mjs';

const BACKLOG = `# 자동 개발 백로그

상태: ready → running(item N) → pr(링크) → done / blocked(이유).

| 우선 | 앱(Orca 프로젝트) | 종류 | 목표 | 상태 | 메모 |
|---|---|---|---|---|---|
| 3 | wakeup | feature | 개선 후보 1개 구현 | ready | 근거 /Users/someone/.toris-neon/runs/x |
| 1 | Pocket Sort (프로젝트 이름은 Play 패키지로 확인) | fix | 거부 원인 수정 | pr(https://github.com/o/r/pull/12) | 재제출은 주인 확인 |
| 2 | mind_gambit | design | 디자인 끝내기 | running(item 2, https://github.com/o/r/pull/9) | a \\| b |
| 4 | crown-rush | fix | 빌드 고치기 | blocked(서명 키 없음) | |
| 5 | Static Harvest | feature | 끝난 일 | done(https://github.com/o/r/pull/3) | |
| | memecatch | feature | 우선 없음 | ready | |
| 6 | toiletnow | fix | 이상한 상태 | waiting for owner | |
`;

test('state cell: word, detail without the link, and the link', () => {
  assert.deepEqual(parseState('ready'), { state: 'ready', detail: null, link: null });
  assert.deepEqual(parseState('running(item 4)'), { state: 'running', detail: 'item 4', link: null });
  assert.deepEqual(parseState('running(item 2, https://github.com/o/r/pull/9)'), { state: 'running', detail: 'item 2', link: 'https://github.com/o/r/pull/9' });
  assert.deepEqual(parseState('pr(https://github.com/o/r/pull/12)'), { state: 'pr', detail: null, link: 'https://github.com/o/r/pull/12' });
  assert.equal(parseState('pr([#12](https://github.com/o/r/pull/12))').link, 'https://github.com/o/r/pull/12');
  assert.deepEqual(parseState('Blocked(서명 키 없음)'), { state: 'blocked', detail: '서명 키 없음', link: null });
  assert.deepEqual(parseState('`done`'), { state: 'done', detail: null, link: null });
  assert.deepEqual(parseState('waiting for owner'), { state: 'unknown', detail: 'waiting for owner', link: null });
  assert.deepEqual(parseState(), { state: 'unknown', detail: null, link: null });
  assert.equal(parseState('pr(javascript:alert(1))').link, null); // only http(s) becomes a link
});

test('backlog.md: rows in priority order, unnumbered last, escaped pipes kept', () => {
  const { items, errors } = parseBacklog(BACKLOG);
  assert.deepEqual(errors, []);
  assert.deepEqual(items.map((item) => [item.priority, item.state]),
    [[1, 'pr'], [2, 'running'], [3, 'ready'], [4, 'blocked'], [5, 'done'], [6, 'unknown'], [null, 'ready']]);
  assert.equal(items[1].memo, 'a | b');
  assert.equal(items[0].goal, '거부 원인 수정');
  assert.equal(items[0].kind, 'fix');
});

test('backlog.md without a table, or without app/goal columns, is an error', () => {
  assert.deepEqual(parseBacklog('# 비어 있음\n\n아직 없음'), { items: [], errors: ['백로그 표를 찾지 못했습니다'] });
  assert.match(parseBacklog('| x | y |\n|---|---|\n| 1 | 2 |').errors[0], /앱·목표 열/);
});

test('summary: jobs in flight, next ready by priority, counts per state', () => {
  const summary = backlogSummary(parseBacklog(BACKLOG).items);
  assert.deepEqual(summary.active.map((item) => item.app), ['Pocket Sort (프로젝트 이름은 Play 패키지로 확인)', 'mind_gambit']);
  assert.equal(summary.next.app, 'wakeup');
  assert.deepEqual(summary.counts, { running: 1, pr: 1, blocked: 1, ready: 2, done: 1, unknown: 1 });
  assert.equal(summary.total, 7);
  assert.equal(backlogSummary([]).next, null);
});

test('an app finds its rows by project, app or Play name, ignoring case, separators and a (…) note', () => {
  const { items } = parseBacklog(BACKLOG);
  const app = (name, projectName, play = []) => ({ name, projectName, play: play.map((playName) => ({ name: playName })) });
  assert.deepEqual(backlogFor(app('Pocket Sort', null, ['Pocket Sort']), items).map((item) => item.state), ['pr']);
  assert.deepEqual(backlogFor(app('mind_gambit', 'mind_gambit'), items).map((item) => item.state), ['running']);
  assert.deepEqual(backlogFor(app('기상미션', 'wakeup'), items).map((item) => item.state), ['ready']);
  assert.deepEqual(backlogFor(app('crown_rush', 'crown_rush'), items).map((item) => item.state), ['blocked']);
  assert.deepEqual(backlogFor(app('바로화장실', 'ToiletNow'), items).map((item) => item.state), ['unknown']);
  assert.deepEqual(backlogFor(app('Other', 'other'), items), []);
  const twice = [...items, { ...items[2], state: 'done' }];
  assert.deepEqual(backlogFor(app('기상미션', 'wakeup'), twice).map((item) => item.state), ['ready', 'done']); // most urgent first
});

test('readBacklog: missing file is a message, a real file is parsed with its mtime, paths scrubbed', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'backlog-'));
  try {
    const none = await readBacklog(dir);
    assert.deepEqual([none.items, none.error], [[], 'backlog.md가 없습니다']);
    await fs.writeFile(path.join(dir, 'backlog.md'), BACKLOG);
    const read = await readBacklog(dir);
    assert.equal(read.error, null);
    assert.equal(read.items.length, 7);
    assert.ok(read.at > 0);
    assert.equal(scrub(read, { home: '/Users/someone' }).items.find((item) => item.app === 'wakeup').memo, '근거 ~/.toris-neon/runs/x');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
