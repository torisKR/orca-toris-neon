import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayLinks, LINKS_KEY } from '../src/playlinks.mjs';

const DEV_A = '1234567890123456789', DEV_B = '9876543210987654321';
const accountsSample = () => [
  { id: 'acc-a', name: 'Studio A', developerId: DEV_A, packages: ['com.example.water', 'com.example.moon'], tracks: ['internal', 'production'], apps: [] },
  { id: 'acc-b', name: 'Studio B', developerId: DEV_B, packages: ['com.example.water'], tracks: ['internal'], apps: [] },
  { id: 'acc-c', name: 'No id yet', developerId: null, packages: ['com.example.sun'], tracks: ['internal'], apps: [] },
];
const projectsSample = () => [
  { id: 'p-water', name: 'water_garden', hostId: 'local', path: '/Users/me/projects/water_garden' },
  { id: 'p-site', name: 'site', hostId: 'local', path: '/Users/me/projects/site' },
  { id: 'p-remote', name: 'remote', hostId: 'ssh-1', path: '/srv/remote' },
];
function setup({ accounts = accountsSample(), projects = projectsSample(), stored } = {}) {
  const data = new Map(stored === undefined ? [] : [[LINKS_KEY, structuredClone(stored)]]);
  const state = { accounts, projects };
  const links = createPlayLinks({
    storage: { get: async (key) => structuredClone(data.get(key) ?? null), set: async (key, value) => { data.set(key, structuredClone(value)); } },
    listAccounts: async () => ({ accounts: structuredClone(state.accounts) }),
    call: async (method) => { assert.equal(method, 'project.list'); return { projects: structuredClone(state.projects) }; },
    detectPlatform: async (root) => (root.endsWith('/site') ? 'web' : 'app'),
    now: () => Date.parse('2026-11-23T01:00:00.000Z'),
  });
  return { links, data, state };
}
const code = (expected) => (error) => error.code === expected;

test('a link names the developer account, a package registered in it and a local project', async () => {
  // Arrange
  const { links, data } = setup();
  // Act
  const link = await links.save({ accountId: 'acc-a', packageName: 'com.example.water', projectId: 'p-water' });
  // Assert
  assert.deepEqual(link, { accountId: 'acc-a', developerId: DEV_A, accountName: 'Studio A', packageName: 'com.example.water',
    projectId: 'p-water', projectName: 'water_garden', linkedAt: '2026-11-23T01:00:00.000Z', problem: null });
  assert.equal(data.get(LINKS_KEY).version, 1);
  assert.equal(data.get(LINKS_KEY).links.length, 1);
});

test('the same package in two accounts is two separate links, never merged by name', async () => {
  const { links } = setup();
  await links.save({ accountId: 'acc-a', packageName: 'com.example.water', projectId: 'p-water' });
  await links.save({ accountId: 'acc-b', packageName: 'com.example.water', projectId: 'p-water' });
  const listed = await links.list();
  assert.deepEqual(listed.map((link) => link.accountId), ['acc-a', 'acc-b']);
  await links.remove({ accountId: 'acc-b', packageName: 'com.example.water' });
  assert.deepEqual((await links.list()).map((link) => link.accountId), ['acc-a']);
});

test('linking refuses a package the account does not list, an account without a developer id, and unknown, remote or web projects', async () => {
  const { links } = setup();
  await assert.rejects(links.save({ accountId: 'acc-a', packageName: 'com.example.sun', projectId: 'p-water' }), code('invalid_params'));
  await assert.rejects(links.save({ accountId: 'acc-a', packageName: 'Water Garden', projectId: 'p-water' }), code('invalid_params'), 'an app name is not a package');
  await assert.rejects(links.save({ accountId: 'acc-c', packageName: 'com.example.sun', projectId: 'p-water' }), /19자리/);
  await assert.rejects(links.save({ accountId: 'missing', packageName: 'com.example.water', projectId: 'p-water' }), code('invalid_params'));
  await assert.rejects(links.save({ accountId: 'acc-a', packageName: 'com.example.water', projectId: 'nope' }), code('invalid_params'));
  await assert.rejects(links.save({ accountId: 'acc-a', packageName: 'com.example.water', projectId: 'p-remote' }), /로컬/);
  await assert.rejects(links.save({ accountId: 'acc-a', packageName: 'com.example.water', projectId: 'p-site' }), /웹/);
});

test('relinking the same account and package to another project replaces only that link', async () => {
  const { links, state } = setup();
  state.projects.push({ id: 'p-water2', name: 'water_v2', hostId: 'local', path: '/Users/me/projects/water_v2' });
  await links.save({ accountId: 'acc-a', packageName: 'com.example.water', projectId: 'p-water' });
  await links.save({ accountId: 'acc-a', packageName: 'com.example.moon', projectId: 'p-water' });
  await links.save({ accountId: 'acc-a', packageName: 'com.example.water', projectId: 'p-water2' });
  const listed = await links.list();
  assert.equal(listed.length, 2);
  assert.equal(listed.find((link) => link.packageName === 'com.example.water').projectId, 'p-water2');
});

test('a link whose account id changed, lost its package or lost its project shows the problem and does not resolve', async () => {
  const { links, state } = setup();
  await links.save({ accountId: 'acc-a', packageName: 'com.example.water', projectId: 'p-water' });
  state.accounts[0].developerId = '1111111111111111111';
  assert.match((await links.list())[0].problem, /개발자 계정 ID/);
  await assert.rejects(links.resolve({ accountId: 'acc-a', packageName: 'com.example.water' }), /개발자 계정 ID/);
  state.accounts[0].developerId = DEV_A;
  state.accounts[0].packages = ['com.example.moon'];
  assert.match((await links.list())[0].problem, /패키지/);
  state.accounts[0].packages = ['com.example.water'];
  state.projects = [];
  assert.match((await links.list())[0].problem, /프로젝트/);
  state.projects = projectsSample();
  assert.equal((await links.resolve({ accountId: 'acc-a', packageName: 'com.example.water' })).projectId, 'p-water');
});

test('an unlinked app does not resolve, and a corrupt link record is never overwritten', async () => {
  const { links } = setup();
  await assert.rejects(links.resolve({ accountId: 'acc-a', packageName: 'com.example.water' }), /연결/);
  const corrupt = setup({ stored: { version: 9, rows: [] } });
  await assert.rejects(corrupt.links.list(), code('state_corrupt'));
  await assert.rejects(corrupt.links.save({ accountId: 'acc-a', packageName: 'com.example.water', projectId: 'p-water' }), code('state_corrupt'));
  assert.deepEqual(corrupt.data.get(LINKS_KEY), { version: 9, rows: [] });
});

test('a link is never shown healthy when its project or account list could not be read', async () => {
  const { links, state } = setup();
  await links.save({ accountId: 'acc-a', packageName: 'com.example.water', projectId: 'p-water' });
  const failing = createPlayLinks({ storage: { get: async () => ({ version: 1, links: [{ accountId: 'acc-a', developerId: DEV_A, packageName: 'com.example.water', projectId: 'p-water' }] }), set: async () => {} },
    listAccounts: async () => ({ accounts: state.accounts }), call: async () => { throw new Error('host down'); } });
  assert.match((await failing.list())[0].problem, /확인하지 못했습니다/);
  const noAccounts = createPlayLinks({ storage: { get: async () => null, set: async () => {} }, listAccounts: async () => ({}), call: async () => ({ projects: [] }) });
  await assert.rejects(noAccounts.save({ accountId: 'acc-a', packageName: 'com.example.water', projectId: 'p-water' }), /계정 목록/);
});
