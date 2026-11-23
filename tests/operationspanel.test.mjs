import test from 'node:test';
import assert from 'node:assert/strict';
import { operationsOverview, runOperationsLine, diskBlock, formatBytes, CONDITION_LABELS } from '../panel/operations.mjs';

const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const NOW = Date.parse('2026-11-23T08:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();
const op = (extra = {}) => ({ nodeId: 'build', phase: 'work', agent: 'codex', attempt: 1, terminalId: 't-1', condition: 'working', lastProgressAt: ago(90_000), ...extra });
const runs = () => [
  { id: 'r1', goal: '물주기 앱 개선', status: 'running', operations: [op(), op({ nodeId: 'test', phase: 'review', condition: 'unclear' })], waiting: { design: '선행 단계 대기', listing: '선행 단계 대기' }, cleanup: { pending: 2, closed: 3, gone: 0, failed: [{ terminalId: 't-x', attempts: 1, error: 'x' }], kept: [] } },
  { id: 'r2', goal: '사주 앱', status: 'running', operations: [op({ nodeId: 'internal', condition: 'needs-user', agent: 'claude' }), op({ nodeId: 'policy', condition: 'error' })], waiting: { release: '빌드 작업 완료 대기' }, cleanup: null }
];

test('the overview lists every managed job with its condition, phase and last progress, and the limits', () => {
  // Act
  const html = operationsOverview({ runs: runs(), limits: { active: 2, activeJobs: 2, heavy: 1, heavyJobs: 1 }, resources: { measured: false, reason: '프로세스 ID 없음' }, now: NOW });
  const plain = text(html);
  // Assert
  assert.match(plain, /Neon 관리 작업 4개/);
  for (const label of [CONDITION_LABELS.working, CONDITION_LABELS.unclear, CONDITION_LABELS['needs-user'], CONDITION_LABELS.error]) assert.ok(plain.includes(label), label);
  assert.match(plain, /앱 구현 · 작업/);
  assert.match(plain, /테스트·수정 루프 · 검토/);
  assert.match(html, /<time data-since="2026-11-23T07:58:30\.000Z"[^>]*>1분 30초<\/time>/);
  assert.match(plain, /물주기 앱 개선/);
});

test('error, waiting-for-user and unclear delivery are counted apart', () => {
  const plain = text(operationsOverview({ runs: runs(), limits: null, resources: { measured: false, reason: 'r' }, now: NOW }));
  assert.match(plain, /실행 오류 1/);
  assert.match(plain, /사용자 응답 대기 1/);
  assert.match(plain, /전달 불명확 1/);
});

test('wait reasons are grouped across runs with their stage count', () => {
  const plain = text(operationsOverview({ runs: runs(), limits: null, resources: { measured: false, reason: 'r' }, now: NOW }));
  assert.match(plain, /선행 단계 대기 2/);
  assert.match(plain, /빌드 작업 완료 대기 1/);
});

test('cleanup state shows waiting, closed and failed terminals', () => {
  const plain = text(operationsOverview({ runs: runs(), limits: null, resources: { measured: false, reason: 'r' }, now: NOW }));
  assert.match(plain, /정리 대기 2/);
  assert.match(plain, /닫음 3/);
  assert.match(plain, /종료 확인 실패 1/);
});

test('unmeasured CPU and memory read 미측정 with the reason, never 0', () => {
  const html = operationsOverview({ runs: runs(), limits: null, resources: { measured: false, reason: '프로세스 ID를 주지 않아' }, now: NOW });
  assert.match(text(html), /CPU·메모리 미측정/);
  assert.match(text(html), /프로세스 ID를 주지 않아/);
  assert.doesNotMatch(text(html), /CPU[^·]*\b0\s*%/);
  assert.match(text(operationsOverview({ runs: [], limits: null, resources: undefined, now: NOW })), /CPU·메모리 미측정/);
});

test('with nothing assigned the overview says so instead of an empty list', () => {
  assert.match(text(operationsOverview({ runs: [], limits: null, resources: null, now: NOW })), /지금 Neon이 배정한 작업이 없습니다/);
});

test('the run card line names this run\'s jobs by condition and pending cleanup', () => {
  const plain = text(runOperationsLine(runs()[0], { now: NOW }));
  assert.match(plain, /작업 중 1/);
  assert.match(plain, /전달 불명확 1/);
  assert.match(plain, /터미널 정리 대기 2/);
  assert.equal(runOperationsLine({ id: 'r', operations: [], cleanup: null }, { now: NOW }), '');
  assert.match(text(runOperationsLine({ id: 'r', operations: [op(), op({ lastProgressAt: null })] }, { now: NOW })), /일부 기록 없음/);
});

test('bytes are shown in readable units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(3.25 * 1024 ** 3), '3.3 GB');
  assert.equal(formatBytes(undefined), '미확인');
});

const disk = {
  runId: 'r1', at: '2026-11-23T08:00:00.000Z',
  receipts: { path: '/Users/me/.toris-neon/runs/r1', exists: true, bytes: 2048, files: 4, truncated: false, jobs: [
    { nodeId: 'build', path: '/Users/me/.toris-neon/runs/r1/build/1-work-a', kind: 'referenced', bytes: 1024, files: 2, truncated: false },
    { nodeId: 'build', path: '/Users/me/.toris-neon/runs/r1/build/2-work-b', kind: 'candidate', bytes: 512, files: 1, truncated: false }
  ] },
  builds: [
    { relative: 'build', path: '/Users/me/ws/build', kind: 'candidate', bytes: 3 * 1024 * 1024, files: 10, truncated: true },
    { relative: '.dart_tool', path: '/Users/me/ws/.dart_tool', kind: 'protected', reason: 'signing', bytes: 10, files: 1, truncated: false }
  ],
  buildsNote: null, candidates: { count: 2, bytes: 3 * 1024 * 1024 + 512 }
};

test('the disk block asks first, then shows location, size, each folder\'s kind and a preview-only candidate total', () => {
  // Act
  const idle = diskBlock(undefined, { runId: 'r1' });
  const shown = diskBlock({ value: disk }, { runId: 'r1' });
  const plain = text(shown);
  // Assert
  assert.match(idle, /data-action="check-disk" data-run="r1"/);
  assert.match(plain, /\/Users\/me\/\.toris-neon\/runs\/r1/);
  assert.match(plain, /2\.0 KB/);
  assert.match(plain, /검증 근거로 참조/);
  assert.match(plain, /서명 자료 포함/);
  assert.match(plain, /정리 후보 2개/);
  assert.match(plain, /최소 3\.0 MB/, 'a partial count is a lower bound');
  assert.match(plain, /미리보기/);
  assert.match(text(diskBlock({ value: { ...disk, receipts: { ...disk.receipts, truncated: true, unclassifiedBytes: 4096 } } }, { runId: 'r1' })), /파일 최소 4개.*분류하지 못한 자료 4\.0 KB/);
  assert.doesNotMatch(shown, /data-action="(delete|remove|clean)/, 'no deletion control');
});

test('loading and failure states are shown instead of a made-up size', () => {
  assert.match(text(diskBlock({ loading: true }, { runId: 'r1' })), /확인하고 있습니다/);
  assert.match(text(diskBlock({ error: 'EACCES <b>' }, { runId: 'r1' })), /확인하지 못했습니다: EACCES/);
  assert.doesNotMatch(diskBlock({ error: '<b>' }, { runId: 'r1' }), /<b>/);
});

test('a workspace Neon did not create says why build outputs are not counted', () => {
  const plain = text(diskBlock({ value: { ...disk, builds: [], buildsNote: 'Neon이 만든 작업 공간이 아니라 빌드 출력을 세지 않습니다.' } }, { runId: 'r1' }));
  assert.match(plain, /빌드 출력을 세지 않습니다/);
});
