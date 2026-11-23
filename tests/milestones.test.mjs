import test from 'node:test';
import assert from 'node:assert/strict';
import { milestones, milestoneText } from '../src/milestones.mjs';

const node = (id, extra = {}) => ({ id, title: id, status: 'pending', write: false, ...extra });
const run = (nodes, extra = {}) => ({ id: 'r', template: 'new-app', status: 'running', nodes, ...extra });
const states = (items) => Object.fromEntries(items.map((item) => [item.label, item.state]));

test('a finished new app run says implementation and verification finished and that nothing was submitted', () => {
  // Arrange
  const finished = run([node('design', { status: 'passed' }), node('build', { write: true, status: 'passed' }), node('test', { status: 'passed' }),
    node('internal', { write: true, status: 'passed', approval: {} }), node('release', { write: true, status: 'passed', approval: {} })], { status: 'completed' });

  // Act
  const items = milestones(finished);

  // Assert
  assert.deepEqual(states(items), { 구현: 'done', 검증: 'done', 제출: 'not_done' });
  assert.equal(milestoneText(finished), '구현 완료 · 검증 완료 · 제출 안 함(사람이 계정과 대상을 지정해 승인해야 함)');
});

test('a submission counts only when the stage passed with an approved Play target, and never claims publication', () => {
  // Arrange
  const submission = { accountId: 'acct-1', developerId: '1234567890123456789', packageName: 'com.example.app', track: 'internal', versionCode: '7' };
  const sent = run([node('build', { write: true, status: 'passed' }), node('test', { status: 'passed' }), node('internal', { write: true, status: 'passed', approval: { submission } })]);

  // Act
  const text = milestoneText(sent);

  // Assert
  assert.equal(states(milestones(sent)).제출, 'approved', 'an approved target, not an observed upload');
  assert.match(text, /제출 승인 완료 \(internal\)/);
  assert.match(text, /Play 게시 여부는 Play Store 탭/);
});

test('unfinished implementation is reported as a count of the stages that passed', () => {
  // Arrange
  const partial = run([node('assets', { write: true, status: 'passed' }), node('build', { write: true, status: 'failed' }), node('test')]);

  // Act
  const items = milestones(partial);

  // Assert
  assert.deepEqual(states(items), { 구현: 'partial', 검증: 'not_done' });
  assert.equal(items[0].detail, '1/2 단계');
  assert.equal(milestoneText(partial), '구현 진행 중(1/2 단계) · 검증 안 됨');
});

test('a stage the graph does not have is left out instead of being called finished', () => {
  // Arrange
  const listing = run([node('identity', { status: 'passed' }), node('listing', { write: true, status: 'passed' })], { template: 'improve' });
  const diagnosis = run([node('identity', { status: 'passed' }), node('diagnose', { status: 'passed' })], { template: 'diagnose' });

  // Act
  const listingItems = milestones(listing);
  const diagnosisText = milestoneText(diagnosis);

  // Assert
  assert.deepEqual(states(listingItems), { 구현: 'done' });
  assert.equal(diagnosisText, '진단 완료');
});
