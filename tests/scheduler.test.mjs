import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, claimNode } from '../src/engine.mjs';
import { GLOBAL_LIMITS, HEAVY_STAGES, isHeavy, globalCounts, launchCandidates, nextLaunch, waitReasons, readLimits } from '../src/scheduler.mjs';

const NOW = '2026-11-23T01:00:00.000Z';
const graph = (...ids) => ids.map((id) => ({ id, title: id, deps: [], write: false }));
function run(id, nodes, extra = {}) {
  return { ...createRun({ id, goal: id, now: NOW, nodes, maxConcurrency: 3 }), started: true, workspaceId: 'w-' + id, workspacePath: '/w/' + id, jobs: [], ...extra };
}
const claim = (r, nodeId) => ({ ...claimNode(r, nodeId, { nonce: r.id + nodeId, now: NOW }), started: true, workspaceId: r.workspaceId, workspacePath: r.workspacePath, jobs: r.jobs });

test('the limits are named: two active assignments in Neon, one heavy', () => {
  assert.deepEqual({ ...GLOBAL_LIMITS }, { activeJobs: 2, heavyJobs: 1 });
  for (const id of ['build', 'test', 'internal', 'monetization', 'reproduce', 'measure']) assert.ok(HEAVY_STAGES.has(id), id);
  assert.equal(isHeavy('research'), false);
});

test('active and heavy assignments are counted across every run', () => {
  const a = claim(run('a', graph('build', 'brief')), 'build');
  const b = claim(run('b', graph('research')), 'research');
  assert.deepEqual(globalCounts([a, b]), { active: 2, heavy: 1 });
});

test('runs take turns: the next launch goes to the run after the one served last', () => {
  const runs = [run('a', graph('a1', 'a2')), run('b', graph('b1', 'b2')), run('c', graph('c1'))];
  const first = nextLaunch(runs, { cursor: 0 });
  assert.deepEqual([first.runId, first.action.nodeId], ['a', 'a1']);
  const second = nextLaunch(runs, { cursor: first.cursor });
  assert.equal(second.runId, 'b', 'not first-run-wins');
  const third = nextLaunch(runs, { cursor: second.cursor });
  assert.equal(third.runId, 'c');
  assert.equal(nextLaunch(runs, { cursor: third.cursor }).runId, 'a', 'wraps around');
});

test('nothing launches past two active assignments or a second heavy one, whatever the per-run cap', () => {
  const busy = [claim(run('a', graph('a1', 'a2')), 'a1'), claim(run('b', graph('b1', 'b2')), 'b1')];
  assert.equal(nextLaunch(busy, { cursor: 0 }), null);
  const heavy = [claim(run('a', graph('build')), 'build'), run('b', graph('test', 'brief'))];
  const pick = nextLaunch(heavy, { cursor: 1 });
  assert.equal(pick.action.nodeId, 'brief', 'the light stage goes; the heavy one waits');
});

test('launch candidates keep the run rules: started, unblocked, writer exclusivity, no shared workspace busy', () => {
  const paused = run('a', graph('x'), { status: 'paused' });
  assert.deepEqual(launchCandidates(paused, [paused]), []);
  const notStarted = run('b', graph('x'), { started: false });
  assert.deepEqual(launchCandidates(notStarted, [notStarted]), []);
  const writers = run('c', [{ id: 'assets', title: 'a', deps: [], write: true }, { id: 'build', title: 'b', deps: [], write: true }]);
  assert.deepEqual(launchCandidates(writers, [writers]).map((action) => action.nodeId), ['assets'], 'one writer at a time');
  const sharing = run('d', graph('x'), { workspaceId: 'w-shared' });
  const other = claim(run('e', graph('y'), { workspaceId: 'w-shared' }), 'y');
  other.jobs = [{ nonce: 'ey', state: 'running' }];
  assert.deepEqual(launchCandidates(sharing, [sharing, other]), []);
});

test('a ready stage that is not assigned says why, truthfully', () => {
  const a = claim(run('a', graph('a1', 'a2')), 'a1');
  const b = claim(run('b', [{ id: 'build', title: 'b', deps: [] }, { id: 'test', title: 't', deps: ['build'] }, { id: 'brief', title: 'r', deps: [] },
    { id: 'internal', title: 'i', deps: [], requiresApproval: true }]), 'build');
  const reasons = waitReasons(b, [a, b]);
  assert.equal(reasons.test, '선행 단계 대기');
  assert.equal(reasons.brief, '전체 작업 2개 실행 중');
  assert.equal(reasons.internal, '승인 대기');
  const heavyWait = run('h', [{ id: 'test', title: 't', deps: [] }]);
  const heavyBusy = claim(run('g', [{ id: 'build', title: 'b', deps: [] }]), 'build');
  assert.equal(waitReasons(heavyWait, [heavyBusy, heavyWait]).test, '빌드 작업 완료 대기');
  const capped = claim(run('k', graph('k1', 'k2'), { maxConcurrency: 1 }), 'k1');
  assert.equal(waitReasons(capped, [capped]).k2, '실행별 한도');
  const solo = run('s', graph('x'));
  assert.equal(waitReasons({ ...solo, status: 'paused' }, [solo]).x, '일시 정지');
});

test('the limits come from the plugin settings, 2 and 1 by default; bad values fall back, heavy never exceeds active', async () => {
  const settings = (values) => ({ get: async (key) => values[key] });
  assert.deepEqual(await readLimits(undefined), { activeJobs: 2, heavyJobs: 1 });
  assert.deepEqual(await readLimits(settings({})), { activeJobs: 2, heavyJobs: 1 });
  assert.deepEqual(await readLimits(settings({ maxActiveJobs: 3, maxHeavyJobs: 2 })), { activeJobs: 3, heavyJobs: 2 });
  assert.deepEqual(await readLimits(settings({ maxActiveJobs: 'lots', maxHeavyJobs: 0 })), { activeJobs: 2, heavyJobs: 1 });
  assert.deepEqual(await readLimits(settings({ maxActiveJobs: 1, maxHeavyJobs: 4 })), { activeJobs: 1, heavyJobs: 1 });
  assert.deepEqual(await readLimits({ get: async () => { throw new Error('no settings'); } }), { activeJobs: 2, heavyJobs: 1 });
});

test('configured limits are what launches and waiting reasons use', () => {
  const limits = { activeJobs: 3, heavyJobs: 1 };
  const busy = [claim(run('a', graph('a1', 'a2')), 'a1'), claim(run('b', graph('b1', 'b2')), 'b1')];
  assert.equal(nextLaunch(busy, { cursor: 0 }), null);
  assert.ok(nextLaunch(busy, { cursor: 0, limits }), 'a third assignment fits under 3');
  const full = [...busy, claim(run('c', graph('c1', 'c2')), 'c1')];
  assert.equal(waitReasons(full[2], full, limits).c2, '전체 작업 3개 실행 중');
});
