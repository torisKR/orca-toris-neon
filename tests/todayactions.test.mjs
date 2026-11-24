import test from 'node:test';
import assert from 'node:assert/strict';
import { runAction, runActions, noteAction } from '../panel/todayactions.mjs';

const stage = (id, extra = {}) => ({ id, title: id, status: 'pending', ...extra });
const run = (status, nodes, extra = {}) => ({ id: 'run-1', goal: '물주기 앱', status, nodes, ...extra });
const actionsOf = (html) => [...html.matchAll(/data-action="([^"]+)"/g)].map(([, name]) => name);

test('each Today run gets the one action its state calls for (plan 5.2)', () => {
  // Arrange
  const cases = [
    [run('paused', [stage('build')]), 'resume'],
    [run('completed', [stage('test', { status: 'passed' })]), 'followup'],
    [run('blocked', [stage('internal', { status: 'blocked', failureReason: '업로드 키스토어가 필요합니다.', report: { outcome: 'failed', failureClass: 'external' } })]), 'external'],
    [run('blocked', [stage('test', { status: 'blocked', failureReason: '실기기 연결 필요', blockedPhase: 'review', review: { outcome: 'blocked' } })]), 'external'],
    [run('ready', [stage('release', { status: 'awaiting-approval' })]), 'external'],
    [run('running', [stage('build', { status: 'running', launchUncertain: true })]), 'recover'],
    [run('ready', [stage('build')], { stopFailures: [{ terminalId: 't1' }] }), 'recover'],
    [run('ready', [stage('build')], { workspaceCreation: { state: 'uncertain', name: 'neon-water' } }), 'recover'],
    [run('blocked', [stage('build', { status: 'failed', failureReason: '검토 실행 한도에 도달했습니다.' })]), 'stage'],
    [run('running', [stage('build', { status: 'running' })]), 'open'],
  ];
  for (const [item, expected] of cases) {
    // Act
    const action = runAction(item);
    // Assert
    assert.equal(action.type, expected, item.status + ' ' + item.nodes[0].status);
  }
});

test('a recovery problem outranks the rest, and the outside condition names what is needed and where', () => {
  const uncertain = runAction(run('paused', [stage('build', { status: 'running', launchUncertain: true })]));
  assert.equal(uncertain.type, 'recover', 'an unconfirmed launch is checked before resuming');
  assert.match(uncertain.text, /중복/);
  const external = runAction(run('blocked', [stage('internal', { status: 'blocked', failureReason: '업로드 키스토어가 필요합니다.', report: { failureClass: 'external' } })]));
  assert.match(external.text, /업로드 키스토어가 필요합니다/);
  assert.equal(external.screen, 'play');
  assert.equal(runAction(run('blocked', [stage('test', { status: 'blocked', failureReason: '기기', report: { outcome: 'blocked' } })])).screen, null);
  assert.match(runAction(run('ready', [stage('catalog', { status: 'awaiting-approval', humanApproval: true })])).text, /Play Console/);
});

test('the rendered actions reuse what exists: resume after the live check, the stage, the improve form, never a new run', () => {
  const resume = actionsOf(runActions(run('paused', [stage('build')])));
  assert.ok(resume.includes('resume-run'));
  const followup = runActions(run('completed', [stage('test', { status: 'passed' })]));
  assert.ok(actionsOf(followup).includes('improve-result'));
  assert.match(followup, /data-run="run-1"/);
  const recover = actionsOf(runActions(run('running', [stage('build', { status: 'running', launchUncertain: true })])));
  assert.deepEqual(recover.slice(0, 2), ['refresh-run', 'open-stage']);
  const external = runActions(run('blocked', [stage('internal', { status: 'blocked', failureReason: '<b>키</b>', report: { failureClass: 'external' } })]));
  assert.ok(actionsOf(external).includes('tab'));
  assert.doesNotMatch(external, /<b>키<\/b>/, 'reasons are escaped');
  for (const html of [resume.join(), followup, recover.join(), external]) assert.doesNotMatch(html, /runs\.create|new-run"/);
});

test('a handoff note offers re-verify only when stale, and an uncertain start shows its recovery path instead of a restart', () => {
  const fresh = noteAction({ workspaceId: 'w1', projectName: 'Water', verificationFreshness: 'fresh', launch: null });
  assert.equal(fresh.type, 'continue');
  const stale = noteAction({ workspaceId: 'w1', projectName: 'Water', verificationFreshness: 'stale', launch: { mode: 'next', status: 'started' } });
  assert.equal(stale.type, 'reverify');
  assert.deepEqual(actionsOf(stale.html), ['reverify-note', 'resume-note', 'open-workspace']);
  const uncertain = noteAction({ workspaceId: 'w1', projectName: 'Water', verificationFreshness: 'stale', launch: { mode: 'reverify', status: 'uncertain' } });
  assert.equal(uncertain.type, 'recover');
  assert.match(uncertain.html, /새 인계 메모/);
  assert.deepEqual(actionsOf(uncertain.html), ['open-workspace']);
});

test('an unsaved cancel is a recovery that says the cancel is not saved yet, not that terminals failed to stop', () => {
  // Arrange
  const unsaved = run('cancelled', [stage('build', { status: 'blocked' })], { cancelUnsaved: true, stopFailures: [{ terminalId: null, code: 'unsaved' }] });
  // Act
  const action = runAction(unsaved);
  // Assert
  assert.equal(action.type, 'recover');
  assert.match(action.text, /취소를 아직 저장하지 못했습니다/);
  assert.doesNotMatch(action.text, /종료를 확인하지 못했습니다/);
});
