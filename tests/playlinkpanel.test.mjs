import test from 'node:test';
import assert from 'node:assert/strict';
import { playLinkBlock, internalResult, linkKey } from '../panel/playlinks.mjs';

const OBSERVED = '2026-11-23T00:30:00.000Z';
const account = { id: 'acc-a', name: 'Studio A', developerId: '1234567890123456789', packages: ['com.example.water'] };
const app = (status = 'published', stale = false) => ({ packageName: 'com.example.water', name: 'Water', status,
  tracks: [{ track: 'internal', releases: [{ versionCodes: [42], state: 'published' }], observedAt: OBSERVED, stale }] });
const projects = [{ id: 'p-water', name: 'water_garden', hostId: 'local', path: '/Users/me/projects/water_garden' }, { id: 'p-remote', name: 'remote', hostId: 'ssh-1', path: '/srv' }];
const link = { accountId: 'acc-a', developerId: account.developerId, accountName: 'Studio A', packageName: 'com.example.water', projectId: 'p-water', projectName: 'water_garden', problem: null };
const actionsOf = (html) => [...html.matchAll(/data-action="([^"]+)"(?: [^>]*data-kind="([^"]+)")?/g)].map(([, name, kind]) => kind ? name + ':' + kind : name);

test('an unlinked app offers an explicit link to a local project, named by account and package, never guessed', () => {
  // Act
  const html = playLinkBlock({ account, app: app(), links: [], projects });
  // Assert
  assert.match(html, /data-form="play-link"/);
  assert.match(html, /data-account="acc-a"/);
  assert.match(html, /data-package="com\.example\.water"/);
  assert.match(html, /<option value="p-water"/);
  assert.doesNotMatch(html, /p-remote/, 'remote projects cannot be linked');
  assert.doesNotMatch(html, /selected/, 'no project is preselected from the app name');
  assert.match(html, /1234567890123456789/);
});

test('an account without a developer id or a package outside its list explains why it cannot be linked', () => {
  assert.match(playLinkBlock({ account: { ...account, developerId: null }, app: app(), links: [], projects }), /19자리/);
  assert.match(playLinkBlock({ account: { ...account, packages: [] }, app: app(), links: [], projects }), /패키지 목록/);
  assert.doesNotMatch(playLinkBlock({ account: { ...account, packages: [] }, app: app(), links: [], projects }), /data-form="play-link"/);
});

test('a linked app shows account, package, versionCode, observation time and age, and its four actions', () => {
  const html = playLinkBlock({ account, app: app(), links: [link], projects });
  assert.match(html, /water_garden/);
  assert.match(html.replace(/<[^>]+>/g, ""), /Studio A · 1234567890123456789/);
  assert.match(html, /com\.example\.water/);
  assert.match(html, /internal · versionCode 42/);
  assert.match(html, /최신 관측/);
  assert.deepEqual(actionsOf(html), ['play-action:release', 'play-action:listing', 'play-action:policy', 'play-internal', 'play-unlink']);
  assert.match(playLinkBlock({ account, app: app('published', true), links: [link], projects }), /오래된 관측값/);
  const unobserved = { ...app(), tracks: [...app().tracks, { track: 'production', releases: [], observedAt: null, stale: true }] };
  const partial = playLinkBlock({ account, app: unobserved, links: [link], projects });
  assert.match(partial, /production · 관측 없음/);
  assert.match(partial, /오래된 관측값/);
  assert.match(html, /aria-label="다음 버전 준비 · com\.example\.water"/, 'repeated per-app buttons name their app');
});

test('a rejected app asks for the actual Play Console reason before any fix, and a broken link starts nothing', () => {
  const rejected = playLinkBlock({ account, app: app('rejected'), links: [link], projects });
  assert.match(rejected, /data-play-reason="acc-a\|com\.example\.water"/);
  assert.match(rejected, /반려 사유/);
  assert.match(rejected, /id="play-reason-acc-a-com-example-water" aria-describedby="play-reason-acc-a-com-example-water-help"/);
  const broken = playLinkBlock({ account, app: app(), links: [{ ...link, problem: '개발자 계정 ID가 다릅니다.' }], projects });
  assert.match(broken, /개발자 계정 ID가 다릅니다/);
  assert.deepEqual(actionsOf(broken), ['play-unlink']);
});

test('the internal test result says what was confirmed, against what, and when', () => {
  const html = internalResult({ state: 'confirmed', text: 'internal 트랙에서 versionCode 42 관측', versionCode: 42, observed: [42], observedAt: OBSERVED, stale: false });
  assert.match(html, /versionCode 42 관측/);
  assert.match(html, /role="status"/);
  assert.match(internalResult({ state: 'stale', text: '오래됨', observed: [], observedAt: OBSERVED, stale: true }), /오래된 관측값/);
  assert.equal(linkKey('acc-a', 'com.example.water'), 'acc-a|com.example.water');
  assert.match(playLinkBlock({ account, app: app(), links: [link], projects, internal: { state: 'not_seen', text: '<i>아직</i>', observed: [], stale: false } }), /&lt;i&gt;아직/);
});
