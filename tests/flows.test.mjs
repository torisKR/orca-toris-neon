import test from 'node:test';
import assert from 'node:assert/strict';
import { createRun, templateGraph } from '../src/engine.mjs';
import { planRunInput, requestKey } from '../src/flows.mjs';

const NOW = '2026-11-23T01:00:00.000Z';
const deps = (runs = []) => ({
  runs,
  call: async () => ({ projects: [{ id: 'p1', name: 'water_garden', hostId: 'local', path: '/repo' }] }),
  inspectRepository: async () => ({ hasCommit: true }),
  readPlayApp: async () => null,
});
const candidate = { kind: 'bugfix', title: '알림이 두 번 울림', problem: '같은 알림이 두 번 표시됨', evidence: 'logcat 2회', impact: '사용자 혼란', scope: 'NotificationScheduler', verify: '알림 1회 확인' };
function diagnosisRun(status = 'passed') {
  const run = createRun({ id: 'diag-1', goal: '진단', projectId: 'p1', now: NOW, nodes: templateGraph('diagnose') });
  run.template = 'diagnose';
  run.improvement = { kind: null, projectName: 'water_garden', playLink: null };
  const diagnose = run.nodes.find((node) => node.id === 'diagnose');
  diagnose.status = status;
  diagnose.report = { outcome: 'passed', summary: '후보 2개', candidates: [candidate, { ...candidate, kind: 'performance', title: '느린 시작' }] };
  return run;
}

test('each flow type plans its graph from the template: new app, an improvement kind, diagnose-only', async () => {
  const fresh = await planRunInput({ goal: '새 앱', projectId: 'p1' }, deps());
  assert.equal(fresh.nodes.length, 7); // playable by default: ends at test
  assert.equal(fresh.extra.scope, 'playable');
  const shipping = await planRunInput({ goal: '새 앱', projectId: 'p1', scope: 'release' }, deps());
  assert.equal(shipping.nodes.length, 11);
  await assert.rejects(planRunInput({ goal: '새 앱', projectId: 'p1', scope: 'store' }, deps()), /범위/);
  const fix = await planRunInput({ template: 'improve', kind: 'bugfix', goal: '알림 중복 수정', projectId: 'p1' }, deps());
  assert.deepEqual(fix.nodes.map((node) => node.id), ['identity', 'reproduce', 'build', 'test']);
  assert.equal(fix.extra.template, 'improve');
  assert.equal(fix.extra.improvement.kind, 'bugfix');
  const diag = await planRunInput({ template: 'diagnose', projectId: 'p1' }, deps());
  assert.deepEqual(diag.nodes.map((node) => node.id), ['identity', 'diagnose']);
  assert.match(diag.goal, /개선 후보/);
  await assert.rejects(planRunInput({ template: 'improve', kind: 'bugfix', projectId: 'p1' }, deps()), /목표/);
  await assert.rejects(planRunInput({ template: 'improve', goal: 'x', projectId: 'p1', nodes: [{ id: 'a', title: 'a', deps: [] }] }, deps()), /템플릿/);
});

test('picking a diagnosis candidate plans an improvement of its kind, with the candidate as the goal, linked to the diagnosis', async () => {
  const plan = await planRunInput({ fromDiagnosis: { runId: 'diag-1', index: 1 } }, deps([diagnosisRun()]));
  assert.deepEqual(plan.nodes.map((node) => node.id), ['identity', 'measure', 'build', 'test']);
  assert.equal(plan.projectId, 'p1');
  assert.match(plan.goal, /느린 시작/);
  assert.match(plan.goal, /검증 방법: 알림 1회 확인/);
  assert.equal(plan.extra.parentRunId, 'diag-1');
  assert.deepEqual(plan.extra.improvement.diagnosis, { runId: 'diag-1', index: 1, title: '느린 시작' });
  await assert.rejects(planRunInput({ fromDiagnosis: { runId: 'diag-1', index: 7 } }, deps([diagnosisRun()])), /후보/);
  await assert.rejects(planRunInput({ fromDiagnosis: { runId: 'diag-1', index: 0 } }, deps([diagnosisRun('review')])), /진단/);
});

test('a request key makes creation idempotent: an explicit requestId, or one diagnosis candidate', () => {
  assert.equal(requestKey({ requestId: 'bot-42' }), 'req:bot-42');
  assert.notEqual(requestKey({ requestId: 'diagnosis:diag-1:2' }), requestKey({ fromDiagnosis: { runId: 'diag-1', index: 2 } }), 'a caller key never collides with a candidate key');
  assert.equal(requestKey({ fromDiagnosis: { runId: 'diag-1', index: 2 } }), 'diagnosis:diag-1:2');
  assert.equal(requestKey({}), null);
  assert.throws(() => requestKey({ requestId: 'has spaces' }), /requestId/);
});

test('"improve this result" plans a new run linked to the previous one, carrying its result summary, never touching it', async () => {
  const parent = createRun({ id: 'run-prev', goal: '알림 수정', projectId: 'p1', now: NOW, nodes: templateGraph('improve', { kind: 'bugfix' }) });
  parent.template = 'improve';
  parent.status = 'completed';
  const build = parent.nodes.find((node) => node.id === 'build');
  build.status = 'passed';
  build.report = { outcome: 'passed', summary: '중복 예약 제거', changes: ['NotificationScheduler 중복 예약 제거'], notVerified: ['Android 9 기기'] };
  const before = JSON.stringify(parent);
  const plan = await planRunInput({ template: 'improve', kind: 'maintenance', goal: '알림 설정 화면도 정리', projectId: 'p1', parentRunId: 'run-prev' }, deps([parent]));
  assert.equal(plan.extra.parentRunId, 'run-prev');
  assert.match(plan.extra.improvement.parent.summary, /중복 예약 제거/);
  assert.match(plan.extra.improvement.parent.summary, /Android 9 기기/);
  assert.equal(JSON.stringify(parent), before, 'the finished run is not changed');
  await assert.rejects(planRunInput({ template: 'improve', kind: 'maintenance', goal: 'x', projectId: 'p1', parentRunId: 'missing' }, deps([parent])), /이전 실행/);
  const elsewhere = { ...parent, id: 'run-other', projectId: 'p-other' };
  await assert.rejects(planRunInput({ template: 'improve', kind: 'maintenance', goal: 'x', projectId: 'p1', parentRunId: 'run-other' }, deps([elsewhere])), /같은 프로젝트/);
  await assert.rejects(planRunInput({ template: 'new-app', goal: 'x', projectId: 'p1', parentRunId: 'run-prev' }, deps([parent])), /개선 흐름/);
  await assert.rejects(planRunInput({ template: 'diagnose', goal: 42, projectId: 'p1' }, deps([parent])), (error) => error.code === 'invalid_params');
});

test('a passed diagnosis that recorded no candidates can still start an improvement from pasted text, linked to it', async () => {
  // Arrange: the live defect: candidates only in verification.md, the summary names them.
  const diagnosis = diagnosisRun();
  diagnosis.nodes.find((node) => node.id === 'diagnose').report = { outcome: 'passed', summary: '후보: 1) 출시 안전망 복구 2) 현장 오류 관측', changes: [], notVerified: [] };
  // Act
  const plan = await planRunInput({ template: 'improve', kind: 'release', goal: '후보 1. 출시 안전망 복구', projectId: 'p1', parentRunId: 'diag-1' }, deps([diagnosis]));
  // Assert
  assert.equal(plan.extra.template, 'improve');
  assert.equal(plan.extra.parentRunId, 'diag-1');
  assert.match(plan.extra.improvement.parent.summary, /출시 안전망 복구/, 'the diagnosis result travels with the new run');
  await assert.rejects(planRunInput({ fromDiagnosis: { runId: 'diag-1', index: 0 } }, deps([diagnosis])), /기록하지 않았습니다/, 'picking needs recorded candidates, and says so');
});
