import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, templateGraph } from '../src/engine.mjs';
import { planRunInput } from '../src/flows.mjs';
import { PROFILES, normalizeProfile, readDefaultProfile, profileAssignments, resolveLaunch, launchPlan, fanoutOf } from '../src/profile.mjs';

const NOW = '2026-11-24T03:00:00.000Z';
const settings = (value) => ({ get: async (key) => key === 'defaultProfile' ? value : undefined });
const deps = (extra = {}) => ({
  runs: [], call: async () => ({ projects: [{ id: 'p1', name: 'App', hostId: 'local', path: '/repo' }] }),
  inspectRepository: async () => ({ hasCommit: true }), readPlayApp: async () => null, ...extra,
});
function runWith(profile, scope = 'release', assignments = {}) {
  const nodes = profileAssignments(templateGraph('new-app'), profile);
  const run = createRun({ id: 'run-p', goal: '게임', now: NOW, nodes, assignments });
  return { ...run, profile, scope };
}
const nodeOf = (run, id) => run.nodes.find((node) => node.id === id);
const launch = (run, id, phase) => {
  const node = nodeOf(run, id);
  return resolveLaunch(run, node, phase, phase === 'review' ? node.reviewer : node.agent);
};
const pick = (settingsValue) => settingsValue && { model: settingsValue.model, effort: settingsValue.effort, source: settingsValue.source };

test('profiles are fast, balanced and saver; the default comes from the plugin setting, else balanced', async () => {
  assert.deepEqual([...PROFILES], ['fast', 'balanced', 'saver']);
  assert.equal(normalizeProfile(undefined), undefined);
  assert.throws(() => normalizeProfile('turbo'), (error) => error.code === 'invalid_params');
  assert.equal(await readDefaultProfile(settings('saver')), 'saver');
  assert.equal(await readDefaultProfile(settings('nonsense')), 'balanced');
  assert.equal(await readDefaultProfile({ get: async () => { throw new Error('denied'); } }), 'balanced');
  assert.equal(await readDefaultProfile(undefined), 'balanced');
});

test('balanced: build and test on opus high, documents on sonnet medium, design and assets on codex gpt-6.2-sol high', () => {
  // Arrange
  const run = runWith('balanced');

  // Act + Assert
  for (const id of ['build', 'test']) assert.deepEqual(pick(launch(run, id, 'work')), { model: 'claude-opus-5-5', effort: 'high', source: 'profile' });
  for (const id of ['research', 'brief', 'policy', 'listing']) assert.deepEqual(pick(launch(run, id, 'work')), { model: 'claude-sonnet-5-5', effort: 'medium', source: 'profile' });
  for (const id of ['design', 'assets']) {
    assert.equal(nodeOf(run, id).agent, 'codex');
    assert.deepEqual(pick(launch(run, id, 'work')), { model: 'gpt-6.2-sol', effort: 'high', source: 'profile' });
  }
});

test('balanced reviews go to the other agent family than the worker, with that family\'s model', () => {
  // Arrange
  const run = runWith('balanced');

  // Act + Assert
  assert.equal(nodeOf(run, 'build').reviewer, 'codex');
  assert.equal(launch(run, 'build', 'review').model, 'gpt-6.2-sol');
  assert.equal(nodeOf(run, 'design').reviewer, 'claude');
  assert.equal(launch(run, 'design', 'review').model, 'claude-sonnet-5-5');
  // codex unusable: the fallback moved the reviewer to claude, which reviews on sonnet
  nodeOf(run, 'build').reviewer = 'claude';
  assert.equal(launch(run, 'build', 'review').model, 'claude-sonnet-5-5');
});

test('saver: build work effort medium, reviews on claude haiku or sonnet for build and test, and no fan-out', () => {
  // Arrange
  const run = runWith('saver');

  // Act + Assert
  assert.deepEqual(pick(launch(run, 'build', 'work')), { model: 'claude-opus-5-5', effort: 'medium', source: 'profile' });
  assert.equal(nodeOf(run, 'build').reviewer, 'claude');
  assert.equal(launch(run, 'build', 'review').model, 'claude-sonnet-5-5');
  assert.equal(launch(run, 'test', 'review').model, 'claude-sonnet-5-5');
  assert.equal(launch(run, 'research', 'review').model, 'claude-haiku-5-5');
  assert.equal(fanoutOf(run), 0);
});

test('fast: top models everywhere and the largest fan-out; balanced fans out to 3', () => {
  // Arrange
  const fast = runWith('fast');

  // Act + Assert
  for (const id of ['research', 'brief', 'build', 'test']) assert.equal(launch(fast, id, 'work').model, 'claude-opus-5-5');
  assert.equal(launch(fast, 'design', 'review').model, 'claude-opus-5-5');
  assert.equal(launch(fast, 'build', 'review').model, 'gpt-6.2-sol');
  assert.equal(fanoutOf(fast), 5);
  assert.equal(fanoutOf(runWith('balanced')), 3);
  assert.equal(fanoutOf({ nodes: [] }), 0, 'a run from before profiles never fans out');
});

test('an explicit stage model or effort wins over the profile field by field for its work phase', () => {
  // Arrange
  const run = runWith('balanced');
  Object.assign(nodeOf(run, 'build'), { model: 'claude-sonnet-5-5' });

  // Act
  const work = launch(run, 'build', 'work');

  // Assert
  assert.deepEqual(pick(work), { model: 'claude-sonnet-5-5', effort: 'high', source: 'stage' });
  assert.equal(launch(run, 'build', 'review').source, 'profile');
});

test('an explicit agent assignment wins over the profile and gets that family\'s model', () => {
  // Arrange
  const run = runWith('balanced', 'release', { build: { agent: 'codex' }, test: { reviewer: 'cursor' } });

  // Act + Assert
  assert.equal(nodeOf(run, 'build').agent, 'codex');
  assert.equal(launch(run, 'build', 'work').model, 'gpt-6.2-sol');
  assert.equal(launch(run, 'test', 'review'), null, 'an agent the profile has no model for runs on its own default');
});

test('a run from before profiles keeps its old launch settings: only codex design and assets get the visual default', () => {
  const run = createRun({ id: 'old', goal: 'x', now: NOW, nodes: templateGraph('new-app') });
  assert.equal(launch(run, 'build', 'work'), null);
  assert.equal(launch(run, 'build', 'review'), null);
  assert.deepEqual(pick(launch(run, 'design', 'work')), { model: 'gpt-6.2-sol', effort: 'high', source: 'default' });
});

test('the launch plan shows per stage and phase the agent, model, effort and why', () => {
  // Arrange
  const run = runWith('balanced');
  nodeOf(run, 'build').effort = 'xhigh';

  // Act
  const plan = launchPlan(run);

  // Assert
  assert.deepEqual(plan.build.work, { agent: 'claude', model: 'claude-opus-5-5', effort: 'xhigh', source: 'stage', why: '단계 지정' });
  assert.deepEqual(plan.build.review, { agent: 'codex', model: 'gpt-6.2-sol', effort: 'high', source: 'profile', why: '프로필 균형 · 교차 검토' });
  assert.equal(plan.research.review.why, '프로필 균형 · 교차 검토');
});

test('runs.create plans the profile: explicit, else the setting; template stages get the profile assignments', async () => {
  // Arrange + Act
  const chosen = await planRunInput({ goal: '게임', projectId: 'p1', profile: 'fast' }, deps({ settings: settings('saver') }));
  const fallback = await planRunInput({ goal: '게임', projectId: 'p1' }, deps({ settings: settings('saver') }));
  const improve = await planRunInput({ template: 'improve', kind: 'bugfix', goal: '고치기', projectId: 'p1' }, deps());

  // Assert
  assert.equal(chosen.extra.profile, 'fast');
  assert.equal(fallback.extra.profile, 'saver');
  assert.equal(improve.extra.profile, 'balanced');
  assert.equal(chosen.nodes.find((node) => node.id === 'build').agent, 'claude');
  await assert.rejects(planRunInput({ goal: '게임', projectId: 'p1', profile: 'turbo' }, deps()), /프로필/);
});

test('a stage moved off its agent says so in the launch plan', () => {
  const run = runWith('balanced');
  Object.assign(nodeOf(run, 'design'), { agent: 'claude', original: { agent: 'codex' } });
  assert.equal(launchPlan(run).design.work.why, '프로필 균형 · codex 대신 대체 진행');
  assert.equal(launchPlan(run).design.work.model, 'claude-opus-5-5');
});

test('a default profile setting that cannot be used is said on the run instead of silently becoming balanced', async () => {
  const typo = await planRunInput({ goal: '게임', projectId: 'p1' }, deps({ settings: settings('fastest') }));
  const broken = await planRunInput({ goal: '게임', projectId: 'p1' }, deps({ settings: { get: async () => { throw new Error('denied'); } } }));
  const unset = await planRunInput({ goal: '게임', projectId: 'p1' }, deps({ settings: settings(undefined) }));
  assert.equal(typo.extra.profile, 'balanced');
  assert.match(typo.extra.profileWarning, /"fastest"/);
  assert.match(broken.extra.profileWarning, /denied/);
  assert.equal(unset.extra.profileWarning, undefined);
});

test('a person\'s worker choice keeps the review cross-family, and a moved stage drops its own model id', async () => {
  // Arrange
  const plan = await planRunInput({ goal: '게임', projectId: 'p1', profile: 'balanced', assignments: { build: { agent: 'codex' } } }, deps());
  const run = runWith('balanced');
  Object.assign(nodeOf(run, 'build'), { agent: 'codex', model: 'claude-opus-5-5', effort: 'xhigh', original: { agent: 'claude' } });

  // Act
  const launchSettings = launch(run, 'build', 'work');

  // Assert
  assert.equal(plan.nodes.find((node) => node.id === 'build').reviewer, 'claude');
  assert.deepEqual(pick(launchSettings), { model: 'gpt-6.2-sol', effort: 'xhigh', source: 'stage' });
});
