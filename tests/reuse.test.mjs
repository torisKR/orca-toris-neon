import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, templateGraph } from '../src/engine.mjs';
import { verifiedEvidence, markFreshness, reuseInstruction, lastVerifiedCommit, parentEvidenceOf, recheckParentEvidence } from '../src/reuse.mjs';
import { planRunInput } from '../src/flows.mjs';
import { buildNodePrompt } from '../src/prompt.mjs';
import { archiveRun, compactRun } from '../src/store.mjs';

const NOW = '2026-11-23T01:00:00.000Z';
const LATER = '2026-11-23T05:00:00.000Z';
/** A finished run whose `ids` stages passed review on `fingerprint` at commit `commit`. */
function finishedRun(id, { projectId = 'p1', ids = ['identity', 'reproduce', 'build', 'test'], fingerprint = 'fp-a', commit = 'c0ffee0000000000000000000000000000000000', at = NOW, kind = 'bugfix' } = {}) {
  const run = { ...createRun({ id, goal: '중복 알림 수정', projectId, now: NOW, nodes: templateGraph('improve', { kind }) }), template: 'improve',
    improvement: { kind, options: { design: false, payments: false }, projectName: 'water', playLink: null }, jobs: [] };
  for (const node of run.nodes.filter((item) => ids.includes(item.id))) {
    Object.assign(node, { status: 'passed', completedAt: at, report: { outcome: 'passed', summary: node.id + ' 근거', evidence: [] },
      review: { outcome: 'passed', nonce: 'rev-' + id + '-' + node.id, summary: '검토', sourceFingerprint: fingerprint } });
    run.jobs.push({ nodeId: node.id, phase: 'review', nonce: 'rev-' + id + '-' + node.id, sourceCommit: commit });
  }
  return run;
}
const deps = (runs, platform = 'app') => ({
  runs, call: async () => ({ projects: [{ id: 'p1', name: 'water', path: '/Users/me/projects/water' }] }),
  inspectRepository: async () => ({ hasCommit: true }), detectPlatform: async () => platform,
});

test('a parent run\'s passed, reviewed stages are recorded with the fingerprint and commit they were verified on', () => {
  // Arrange
  const parent = finishedRun('parent', { ids: ['identity', 'build'] });
  // Act
  const evidence = verifiedEvidence(parent);
  // Assert
  assert.deepEqual(evidence.map((item) => item.nodeId), ['identity', 'build']);
  assert.equal(evidence[1].fingerprint, 'fp-a');
  assert.equal(evidence[1].commit, 'c0ffee0000000000000000000000000000000000');
  assert.equal(evidence[1].summary, 'build 근거');
});

test('evidence is fresh only when the new workspace has the same source fingerprint; otherwise stale', async () => {
  // Arrange
  const evidence = verifiedEvidence(finishedRun('parent'));
  // Act
  const same = await markFreshness(evidence, async () => 'fp-a');
  const changed = await markFreshness(evidence, async () => 'fp-b');
  const unmeasured = await markFreshness(evidence, async () => { throw new Error('심볼릭 링크'); });
  // Assert
  assert.ok(same.items.every((item) => item.freshness === 'fresh'));
  assert.ok(changed.items.every((item) => item.freshness === 'stale'));
  assert.ok(unmeasured.items.every((item) => item.freshness === 'stale'), 'an unmeasurable source is never treated as matching');
  assert.match(unmeasured.reason, /심볼릭 링크/);
  assert.equal(await markFreshness([], async () => 'fp-a'), null);
});

test('evidence verified on no recorded fingerprint is stale even if the workspace can be measured', async () => {
  const marked = await markFreshness([{ nodeId: 'build', title: '구현', summary: 's', fingerprint: null, commit: null, at: NOW }], async () => 'fp-a');
  assert.equal(marked.items[0].freshness, 'stale');
});

test('only a follow-up run measures its workspace, and the job carries the marked evidence', async () => {
  // Arrange
  let measured = 0;
  const measure = async () => { measured++; return 'fp-a'; };
  const child = { improvement: { parent: { runId: 'parent', evidence: verifiedEvidence(finishedRun('parent')) } } };
  // Act
  const none = await parentEvidenceOf({ improvement: {} }, measure);
  const marked = await parentEvidenceOf(child, measure);
  // Assert
  assert.deepEqual(none, {});
  assert.equal(measured, 1);
  assert.equal(marked.parentEvidence.items.length, 4);
});

test('the prompt reuses fresh parent evidence and tells the agent to re-run the stale checks', async () => {
  // Arrange
  const evidence = verifiedEvidence(finishedRun('parent'));
  const fresh = await markFreshness(evidence.slice(0, 2), async () => 'fp-a');
  const stale = await markFreshness(evidence.slice(2), async () => 'fp-b');
  const job = { runId: 'r2', nodeId: 'build', nonce: 'n', phase: 'work', attempt: 1, agent: 'codex', receiptDirectory: '/r', receiptPath: '/r/result.json',
    parentEvidence: { items: [...fresh.items, ...stale.items] } };
  const run = { ...finishedRun('r2', { ids: [] }), workspacePath: '/w' };
  // Act
  const text = reuseInstruction(job);
  const prompt = buildNodePrompt(run, run.nodes.find((node) => node.id === 'build'), job);
  // Assert
  assert.match(text, /재사용/);
  assert.match(text, /앱 정체성 확인.*identity 근거/s);
  assert.match(text, /오래된 근거/);
  assert.match(text, /다시 실행/);
  assert.ok(prompt.includes(text));
  assert.equal(reuseInstruction({}), '');
});

test('the last verified commit is the newest passed test of the same project', () => {
  // Arrange
  const runs = [finishedRun('old', { at: NOW, commit: 'a'.repeat(40) }), finishedRun('new', { at: LATER, commit: 'b'.repeat(40) }),
    finishedRun('other', { projectId: 'p2', at: '2026-11-24T00:00:00.000Z', commit: 'c'.repeat(40) }), finishedRun('untested', { ids: ['identity'], at: '2026-11-24T00:00:00.000Z' })];
  // Act
  const last = lastVerifiedCommit(runs, 'p1');
  // Assert
  assert.deepEqual(last, { runId: 'new', commit: 'b'.repeat(40), at: LATER });
  assert.equal(lastVerifiedCommit(runs, 'p9'), null);
});

test('the reviewed source remains available when compaction removes the finished job', () => {
  const parent = finishedRun('parent', { commit: 'a'.repeat(40) });
  parent.jobs.forEach((job) => { job.state = 'complete'; });

  for (const stored of [archiveRun(parent, LATER), compactRun(parent, 2)]) {
    assert.equal(stored.jobs.length, 0);
    assert.deepEqual(lastVerifiedCommit([stored], 'p1'), { runId: 'parent', commit: 'a'.repeat(40), at: NOW });
    assert.equal(verifiedEvidence(stored).find((item) => item.nodeId === 'test').fingerprint, 'fp-a');
  }
});

test('a follow-up plan records the parent evidence; a release plan records the last verified commit', async () => {
  // Arrange
  const parent = finishedRun('parent');
  // Act
  const followUp = await planRunInput({ template: 'improve', kind: 'bugfix', projectId: 'p1', goal: '글자를 키워 주세요', parentRunId: 'parent' }, deps([parent]));
  const release = await planRunInput({ template: 'improve', kind: 'release', projectId: 'p1', goal: '업데이트 출시' }, deps([parent]));
  // Assert
  assert.equal(followUp.extra.improvement.parent.evidence.length, 4);
  assert.equal(followUp.extra.improvement.lastVerified, undefined);
  assert.equal(release.extra.improvement.lastVerified.commit, 'c0ffee0000000000000000000000000000000000');
});

test('a web project\'s release update plan has no Play stages and refuses Play billing', async () => {
  // Arrange / Act
  const plan = await planRunInput({ template: 'improve', kind: 'release', projectId: 'p1', goal: '업데이트' }, deps([], 'web'));
  // Assert
  assert.deepEqual(plan.nodes.map((node) => node.id), ['identity', 'test']);
  assert.equal(plan.extra.improvement.platform, 'web');
  await assert.rejects(planRunInput({ template: 'improve', kind: 'feature', options: { payments: true }, projectId: 'p1', goal: '결제' }, deps([], 'web')), /웹/);
  await assert.rejects(planRunInput({ template: 'improve', kind: 'bugfix', projectId: 'p1', goal: '오류', playLink: { accountId: 'a', packageName: 'com.example.web' } },
    { ...deps([], 'web'), readPlayApp: async () => ({}) }), /웹/);
});

test('a release candidate from a web project\'s diagnosis gets the web graph', async () => {
  // Arrange
  const diagnosis = { ...createRun({ id: 'd1', goal: '진단', projectId: 'p1', now: NOW, nodes: templateGraph('diagnose') }), template: 'diagnose',
    improvement: { kind: null, options: {}, projectName: 'site', playLink: null, platform: 'web' } };
  Object.assign(diagnosis.nodes[1], { status: 'passed', report: { candidates: [{ kind: 'release', title: '배포', problem: 'p', evidence: 'e', impact: 'i', scope: 's', verify: 'v' }] } });
  // Act
  const plan = await planRunInput({ fromDiagnosis: { runId: 'd1', index: 0 } }, deps([diagnosis]));
  // Assert
  assert.deepEqual(plan.nodes.map((node) => node.id), ['identity', 'test']);
  assert.equal(plan.extra.improvement.parent.runId, 'd1', 'a run started from a diagnosis reuses its evidence too');
});

test('right before delivery, fresh evidence is measured again: a changed source makes it stale with the reason; unchanged stays fresh', async () => {
  // Arrange
  const fresh = await markFreshness(verifiedEvidence(finishedRun('parent', { ids: ['identity'] })), async () => 'fp-a');
  let measured = 0;
  // Act
  const same = await recheckParentEvidence({ parentEvidence: fresh }, async () => { measured++; return 'fp-a'; });
  const moved = await recheckParentEvidence({ parentEvidence: fresh }, async () => 'fp-b');
  const unreadable = await recheckParentEvidence({ parentEvidence: fresh }, async () => { throw new Error('git 실패'); });
  const allStale = await recheckParentEvidence({ parentEvidence: { items: fresh.items.map((item) => ({ ...item, freshness: 'stale' })) } }, async () => { measured++; return 'fp-a'; });
  // Assert
  assert.equal(same.items[0].freshness, 'fresh');
  assert.equal(moved.items[0].freshness, 'stale');
  assert.match(moved.reason, /지시를 전달하기 직전/);
  assert.equal(unreadable.items[0].freshness, 'stale');
  assert.match(unreadable.reason, /git 실패/);
  assert.equal(allStale.items[0].freshness, 'stale');
  assert.equal(measured, 1, 'nothing fresh is not measured again');
  assert.equal(await recheckParentEvidence({}, async () => 'fp-a'), undefined);
  assert.doesNotMatch(reuseInstruction({ parentEvidence: moved }), /재사용 가능/);
});
