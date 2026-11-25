import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApps, matchProject, projectIdOf, scrub } from '../dashboard/join.mjs';
import { readStorage, parseStorage } from '../dashboard/sources.mjs';

const tracks = (state) => [{ track: 'production', releases: [{ name: '1', versionCodes: [1], state }], observedAt: '2026-11-24T00:00:00Z', stale: false, error: null }];
const projects = [
  { id: 'repo:a', name: 'wax_balls', packageIds: [] },
  { id: 'repo:b', name: 'wakeup', packageIds: ['com.wakemission.wakeproof'] },
  { id: 'repo:c', name: 'mind_gambit', packageIds: [], sourceRepoIds: ['c'], root: '/x/projects/mind_gambit' },
  { id: 'repo:d', name: 'quiz_battle', packageIds: [] },
];
const playApps = [
  { packageName: 'com.toris.waxBalls', name: '왁뿌볼', tracks: tracks('in_review') },
  { packageName: 'com.wakemission.wakeproof', name: '기상미션', tracks: tracks('published') },
  { packageName: 'com.toris.pocket_sort', name: 'Pocket Sort', tracks: tracks('not_approved') },
  { packageName: 'com.knowledgebattle.app', name: '지식배틀', tracks: tracks('published') },
];

test('app list is the union of projects and Play apps, matched by link, package id, then name', () => {
  const links = [{ packageName: 'com.knowledgebattle.app', projectId: 'repo:d', problem: null }];
  const apps = buildApps({ projects, playApps, links, now: Date.parse('2026-11-25T00:00:00Z') });
  const by = (name) => apps.find((app) => app.projectName === name || app.name === name);
  assert.equal(apps.length, 5); // 4 projects + 1 Play app nothing matched
  assert.equal(by('wax_balls').match, 'name');
  assert.deepEqual(by('wax_balls').play[0].production, ['in_review']);
  assert.equal(by('wakeup').match, 'package');
  assert.equal(by('quiz_battle').match, 'link');
  assert.equal(by('mind_gambit').play.length, 0); // a project without Play keeps its row
  const loose = by('Pocket Sort');
  assert.equal(loose.projectId, null); // an unmatched Play app keeps its row too
  assert.equal(loose.play[0].status, 'rejected');
  assert.equal(loose.play[0].stale, false);
});

test('a name shared by two projects matches neither', () => {
  const twins = [{ id: '1', name: 'garden' }, { id: '2', name: 'Garden' }];
  assert.equal(matchProject({ packageName: 'com.toris.garden' }, twins), null);
});

test('a Neon run finds its Orca project by repo id or workspace folder', () => {
  assert.equal(projectIdOf({ projectId: 'c' }, { projects }), 'repo:c');
  assert.equal(projectIdOf({ projectId: 'unknown', workspacePath: '/x/orca/workspaces/mind_gambit/neon-123' }, { projects }), 'repo:c');
  assert.equal(projectIdOf({ projectId: 'unknown', workspacePath: '/elsewhere/thing' }, { projects }), null);
});

const storage = JSON.stringify({
  'toris-neon.runtime.v2': { version: 2, runs: ['r1'], archived: ['r0'] },
  'toris-neon.run.r1': { version: 2, run: { id: 'r1', status: 'running', nodes: [] } },
  'toris-neon.archive.r0': { version: 2, run: { id: 'r0', status: 'completed', nodes: [] } },
  'toris-neon.play.accounts.v1': { version: 1, accounts: [{ id: 'acc', name: 'Private Name', developerId: '1234567890123456789' }] },
  'toris-neon.play.cache.v1.acc': { version: 1, checkedAt: '2026-11-24T00:00:00Z', apps: [{ packageName: 'com.x.y', name: 'Y', tracks: [] }] },
});

test('storage.json is parsed into runs, archived runs and the Play cache without developer ids', () => {
  const state = parseStorage(storage);
  assert.deepEqual(state.runs.map((run) => run.id), ['r1']);
  assert.deepEqual(state.archivedRuns.map((run) => run.id), ['r0']);
  assert.deepEqual(state.play.accounts, [{ id: 'acc', name: 'Private Name', checkedAt: '2026-11-24T00:00:00Z', apps: [{ packageName: 'com.x.y', name: 'Y', tracks: [] }] }]);
});

test('a half-written storage.json is retried, and reported after the last try', async () => {
  const reads = [storage.slice(0, 50), storage];
  const recovered = await readStorage({ read: async () => reads.shift(), wait: async () => {} });
  assert.equal(recovered.runs[0].id, 'r1');
  let calls = 0;
  await assert.rejects(readStorage({ read: async () => { calls++; return '{"broken'; }, tries: 3, wait: async () => {} }), /3회 시도/);
  assert.equal(calls, 3);
});

test('scrub shortens home paths and hides emails and Play developer ids', () => {
  const out = scrub({ path: '/Users/toris/projects/a', note: 'mail me@example.com', id: 'dev 1234567890123456789', developerId: 'x', n: 3 }, { home: '/Users/toris' });
  assert.deepEqual(out, { path: '~/projects/a', note: 'mail (이메일 숨김)', id: 'dev (ID 숨김)', n: 3 });
});
