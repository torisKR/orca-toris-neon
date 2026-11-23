import test from 'node:test';
import assert from 'node:assert/strict';
import { PLAY_ACTIONS, actionRequestId, playActionRequest, internalTestStatus, playLinkHandlers } from '../src/playactions.mjs';
import { templateGraph } from '../src/engine.mjs';
import { requestKey } from '../src/flows.mjs';

const OBSERVED = '2026-11-23T00:30:00.000Z';
const link = { accountId: 'acc-a', developerId: '1234567890123456789', accountName: 'Studio A', packageName: 'com.example.water',
  projectId: 'p-water', projectName: 'water_garden', linkedAt: OBSERVED, problem: null };
const track = (name, versionCodes, { state = 'published', stale = false, observedAt = OBSERVED } = {}) =>
  ({ track: name, releases: versionCodes.length ? [{ name: 'v', versionCodes, state }] : [], observedAt, stale, error: null });
const appView = (status = 'published', tracks = [track('production', [41]), track('internal', [42])]) =>
  ({ packageName: 'com.example.water', name: 'Water', status, tracks });
const code = (expected) => (error) => error.code === expected;

test('each Play action plans an improvement of the linked project with only the account id and package', () => {
  // Arrange
  const kinds = { release: 'release', listing: 'listing', policy: 'policy' };
  for (const [action, kind] of Object.entries(kinds)) {
    // Act
    const input = playActionRequest({ action, link, app: appView(), runs: [], agent: 'codex', reviewer: 'claude' });
    // Assert
    assert.equal(input.template, 'improve');
    assert.equal(input.kind, kind);
    assert.equal(input.projectId, 'p-water');
    assert.deepEqual(input.playLink, { accountId: 'acc-a', packageName: 'com.example.water' });
    assert.deepEqual(Object.keys(input.assignments), templateGraph('improve', { kind }).map((node) => node.id));
    assert.deepEqual(input.assignments.identity, { agent: 'codex', reviewer: 'claude' });
    assert.ok(input.goal.startsWith(PLAY_ACTIONS[action]), action + ' goal names the action');
    assert.doesNotThrow(() => requestKey(input), 'the request id fits runs.create');
  }
});

test('the goal shows account, package, track, versionCode, last observed time and whether the value is old', () => {
  const fresh = playActionRequest({ action: 'release', link, app: appView(), runs: [] }).goal;
  assert.match(fresh, /Studio A \(1234567890123456789\)/);
  assert.match(fresh, /com\.example\.water/);
  assert.match(fresh, /production versionCode 41/);
  assert.match(fresh, /internal versionCode 42/);
  assert.match(fresh, new RegExp(OBSERVED));
  assert.doesNotMatch(fresh, /오래된/);
  const stale = playActionRequest({ action: 'release', link, runs: [],
    app: appView('published', [track('production', [41], { stale: true })]) }).goal;
  assert.match(stale, /오래된 관측값/);
  const never = playActionRequest({ action: 'release', link, runs: [], app: null }).goal;
  assert.match(never, /관측한 적이 없습니다/);
});

test('a rejected app never starts a fix without the actual rejection reason', () => {
  const rejected = appView('rejected');
  for (const action of ['release', 'listing']) {
    assert.throws(() => playActionRequest({ action, link, app: rejected, runs: [] }), code('rejection_reason_required'), action);
    assert.throws(() => playActionRequest({ action, link, app: rejected, runs: [], rejectionReason: '   ' }), code('rejection_reason_required'), action);
  }
  const fix = playActionRequest({ action: 'release', link, app: rejected, runs: [], rejectionReason: 'Policy: background location without disclosure' });
  assert.match(fix.goal, /<rejection-reason>\nPolicy: background location without disclosure\n<\/rejection-reason>/);
  assert.match(fix.goal, /이 사유가 가리키는 문제만/);
  const check = playActionRequest({ action: 'policy', link, app: rejected, runs: [] });
  assert.match(check.goal, /실제 반려 사유는 제공되지 않았습니다/);
  assert.match(check.goal, /추정해 고치지/);
  assert.throws(() => playActionRequest({ action: 'release', link, app: rejected, runs: [], rejectionReason: 'x'.repeat(2001) }), code('invalid_params'));
});

test('a link with a problem, an unknown action or a bad agent starts nothing', () => {
  assert.throws(() => playActionRequest({ action: 'release', link: { ...link, problem: '계정이 바뀌었습니다.' }, app: appView(), runs: [] }), /계정이 바뀌었습니다/);
  assert.throws(() => playActionRequest({ action: 'publish', link, app: appView(), runs: [] }), code('invalid_params'));
  assert.throws(() => playActionRequest({ action: 'release', link, app: appView(), runs: [], agent: 'rm -rf' }), code('invalid_params'));
});

test('pressing an action again returns its open run; only after that run completes does a new one get a new id', () => {
  const first = actionRequestId('release', link, []);
  assert.equal(actionRequestId('release', link, []), first, 'two clicks before the run exists share one id');
  const open = [{ id: 'r1', status: 'running', requestId: 'req:' + first }];
  assert.equal(actionRequestId('release', link, open), first);
  assert.notEqual(actionRequestId('listing', link, open), first, 'another action is another run');
  assert.notEqual(actionRequestId('release', { ...link, accountId: 'acc-b' }, open), first, 'the same package in another account is another app');
  const done = [{ id: 'r1', status: 'completed', requestId: 'req:' + first }];
  const second = actionRequestId('release', link, done);
  assert.notEqual(second, first);
  const archivedGap = [{ id: 'r2', status: 'completed', requestId: 'req:' + second }];
  assert.notEqual(actionRequestId('release', link, archivedGap), second, 'an older run trimmed from the archive never reopens a finished id');
  assert.ok(first.length <= 100 && /^[\w.:-]+$/.test(first));
});

test('the internal test check confirms only the version a run built for this package and track, and says when the value is old', () => {
  const built = (versionCode, packageName = 'com.example.water', at = '2026-11-22T10:00:00.000Z') => ({
    id: 'run-' + versionCode, projectId: 'p-water', status: 'completed',
    nodes: [{ id: 'internal', status: 'passed', completedAt: at, report: { releaseLink: { commit: 'abc1234', artifact: 'app.aab', packageName, track: 'internal', versionCode } } }],
  });
  const confirmed = internalTestStatus({ link, app: appView(), runs: [built(40, 'com.example.water', '2026-11-20T00:00:00.000Z'), built(42)] });
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.versionCode, 42);
  assert.equal(confirmed.runId, 'run-42');
  assert.equal(confirmed.observedAt, OBSERVED);
  assert.match(confirmed.text, /Play Console/, 'tester feedback stays in Play Console');
  assert.equal(internalTestStatus({ link, app: appView(), runs: [built(43)] }).state, 'not_seen');
  assert.equal(internalTestStatus({ link, app: appView('published', [track('internal', [42], { stale: true })]), runs: [built(42)] }).state, 'stale');
  assert.equal(internalTestStatus({ link, app: appView(), runs: [built(42, 'com.example.other')] }).state, 'no_build', 'another package is not this app');
  assert.equal(internalTestStatus({ link, app: appView('published', [track('production', [41])]), runs: [built(42)] }).state, 'untracked');
  assert.equal(internalTestStatus({ link, app: null, runs: [built(42)] }).state, 'untracked');
  const draft = appView('published', [track('internal', [42], { state: 'draft' })]);
  assert.equal(internalTestStatus({ link, app: draft, runs: [built(42)] }).state, 'not_seen', 'a draft is not a submission');
  const failed = built(42);
  failed.nodes[0].status = 'failed';
  assert.equal(internalTestStatus({ link, app: appView(), runs: [failed] }).state, 'no_build', 'a build from a stage that did not pass is not recorded');
  assert.doesNotMatch(confirmed.text, /계정·패키지/, 'the account is not part of what the build record proves');
});

test('never-observed tracks count as old, and an unknown approval state tells the run to stop on a rejection', () => {
  const missing = playActionRequest({ action: 'release', link, runs: [],
    app: appView('published', [track('production', [41]), { track: 'internal', releases: [], observedAt: null, stale: true, error: null }]) }).goal;
  assert.match(missing, /internal 관측 없음/);
  assert.match(missing, /오래된 관측값은/);
  for (const app of [null, appView('unknown')]) {
    const goal = playActionRequest({ action: 'listing', link, app, runs: [] }).goal;
    assert.match(goal, /승인 상태를 확인하지 못했습니다/);
  }
  assert.doesNotMatch(playActionRequest({ action: 'listing', link, app: appView(), runs: [] }).goal, /승인 상태를 확인하지 못했습니다/);
});

test('the handlers resolve the link first, plan the run through runs.create and never pass Play keys to it', async () => {
  // Arrange
  const created = [], checks = [];
  const secret = { private_key: '-----BEGIN PRIVATE KEY-----', client_email: 'reader@example.iam.gserviceaccount.com' };
  const account = { id: 'acc-a', name: 'Studio A', developerId: link.developerId, packages: ['com.example.water'], apps: [appView()], ...secret };
  const handlers = playLinkHandlers({
    play: { list: async () => ({ accounts: [account] }), check: async (input) => { checks.push(input); return account; } },
    links: { list: async () => [link], resolve: async (input) => { assert.deepEqual(input, { accountId: 'acc-a', packageName: 'com.example.water' }); return link; } },
    getRuns: () => [],
    createRun: async (input) => { created.push(input); return { id: 'planned', status: 'ready' }; },
  });
  // Act
  const listed = await handlers['play.list']();
  const run = await handlers['play.action.start']({ action: 'release', accountId: 'acc-a', packageName: 'com.example.water', agent: 'codex', reviewer: 'claude' });
  const internal = await handlers['play.internalCheck']({ accountId: 'acc-a', packageName: 'com.example.water' });
  // Assert
  assert.deepEqual(listed.links, [link]);
  assert.equal(run.id, 'planned');
  assert.equal(created.length, 1);
  assert.doesNotMatch(JSON.stringify(created), /PRIVATE KEY|gserviceaccount/);
  assert.deepEqual(checks, [{ accountId: 'acc-a', force: true }]);
  assert.equal(internal.state, 'no_build');
});
