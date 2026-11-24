import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { recordReleaseBinary, recheckBeforeSubmission, readReleaseFile } from '../src/releaselink.mjs';
import { releaseFile, fakeCertificate } from './fixtures/release.mjs';

const AT = '2026-11-24T01:00:00.000Z';
const identity = (overrides = {}) => ({ format: 'aab', sha256: 'a'.repeat(64), size: 10, packageName: 'com.example.water', versionCode: '43', signingCertSha256: 'c'.repeat(64), ...overrides });
const link = (overrides = {}) => ({ commit: 'a1b2c3d4e5f6', artifact: 'build/app-release.aab', packageName: 'com.example.water', track: 'internal', versionCode: '43', ...overrides });
const submission = { accountId: 'play-test', developerId: '1', packageName: 'com.example.water', track: 'internal', versionCode: '43' };
const run = (nodes = []) => ({ id: 'r1', workspacePath: '/Users/me/ws', nodes: [{ id: 'test', status: 'passed', report: { outcome: 'passed' } }, ...nodes] });
const reader = (value) => async () => value;

test('a passed report\'s release link records what Neon read from the file itself', async () => {
  // Arrange
  const node = { id: 'internal', approval: { submission } };
  // Act
  const binary = await recordReleaseBinary(run([node]), node, { outcome: 'passed', phase: 'work', releaseLink: link() }, { read: reader(identity()), at: AT });
  // Assert
  assert.deepEqual(binary, { ...identity(), artifact: 'build/app-release.aab', checkedAt: AT });
});

test('a file whose package, versionCode or hash differs from the link or the approval blocks with what differs', async () => {
  const node = { id: 'internal', approval: { submission } };
  const record = (file, reported = link()) => recordReleaseBinary(run([node]), node, { outcome: 'passed', phase: 'work', releaseLink: reported }, { read: reader(file), at: AT });
  await assert.rejects(record(identity({ versionCode: '42' })), (error) => error.code === 'conflict' && /versionCode/.test(error.message) && /42/.test(error.message));
  await assert.rejects(record(identity({ packageName: 'com.example.other' })), /패키지/);
  await assert.rejects(record(identity(), link({ sha256: 'b'.repeat(64) })), /sha256/);
  await assert.rejects(record(identity({ versionCode: '44' }), link({ versionCode: '44' })), /승인한 versionCode가 43/);
});

test('no release link, a failed report or an unreadable file: nothing is recorded or the stage blocks', async () => {
  const node = { id: 'internal' };
  assert.equal(await recordReleaseBinary(run([node]), node, { outcome: 'passed', phase: 'work' }, { read: reader(identity()), at: AT }), null);
  assert.equal(await recordReleaseBinary(run([node]), node, { outcome: 'failed', phase: 'work', releaseLink: link() }, { read: reader(identity()), at: AT }), null);
  const broken = async () => { throw new Error('zip 형식(AAB/APK)이 아닙니다.'); };
  await assert.rejects(recordReleaseBinary(run([node]), node, { outcome: 'passed', phase: 'work', releaseLink: link() }, { read: broken, at: AT }), /AAB\/APK로 읽지 못했습니다.*zip/);
});

test('the uploaded file must be the same build as an earlier link with the same versionCode, signed by the same key', async () => {
  // Arrange
  const internal = { id: 'internal', title: '내부 테스트 제출', status: 'passed', report: { outcome: 'passed', releaseLink: { ...link(), binary: { ...identity(), artifact: 'build/app-release.aab', checkedAt: AT } } } };
  const release = { id: 'release', approval: { submission: { ...submission, track: 'production' } } };
  const report = { outcome: 'passed', phase: 'work', releaseLink: link({ track: 'production' }) };
  // Act / Assert
  await assert.rejects(recordReleaseBinary(run([internal, release]), release, report, { read: reader(identity({ sha256: 'd'.repeat(64) })), at: AT }), /내부 테스트 제출.*같은 versionCode 43/);
  await assert.rejects(recordReleaseBinary(run([internal, release]), release, report, { read: reader(identity({ signingCertSha256: 'e'.repeat(64) })), at: AT }), /서명 인증서/);
  assert.ok(await recordReleaseBinary(run([internal, release]), release, report, { read: reader(identity()), at: AT }));
});

test('before a submission is typed, a recorded file for the approved versionCode is read again and must be unchanged', async () => {
  // Arrange
  const internal = { id: 'internal', title: '내부 테스트 제출', status: 'passed', report: { outcome: 'passed', releaseLink: { ...link(), binary: { ...identity(), artifact: 'build/app-release.aab', checkedAt: AT } } } };
  const release = { id: 'release', approval: { submission: { ...submission, track: 'production' } } };
  // Act / Assert
  await recheckBeforeSubmission(run([internal, release]), release, { read: reader(identity()) });
  await assert.rejects(recheckBeforeSubmission(run([internal, release]), release, { read: reader(identity({ sha256: 'f'.repeat(64) })) }), (error) => error.code === 'conflict' && /기록 이후 바뀌었습니다/.test(error.message));
  await assert.rejects(recheckBeforeSubmission(run([internal, release]), release, { read: async () => { throw new Error('ENOENT'); } }), /다시 읽지 못했습니다/);
  await recheckBeforeSubmission(run([internal, { ...release, approval: { submission: { ...submission, versionCode: '44' } } }]), { ...release, approval: { submission: { ...submission, versionCode: '44' } } }, { read: async () => { throw new Error('not read'); } });
  await recheckBeforeSubmission(run([internal]), { id: 'release', approval: null }, { read: async () => { throw new Error('not read'); } });
});

test('a link path is read relative to the workspace and never outside the workspace or the result folder', async (t) => {
  // Arrange
  const root = await fs.mkdtemp(path.join(tmpdir(), 'neon-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const ws = path.join(root, 'ws'), outside = path.join(root, 'outside');
  await fs.mkdir(path.join(ws, 'build'), { recursive: true });
  await fs.mkdir(outside);
  const { cert, sha256 } = fakeCertificate();
  await fs.writeFile(path.join(ws, 'build', 'app.aab'), releaseFile({ cert }));
  await fs.writeFile(path.join(outside, 'app.aab'), releaseFile({ cert }));
  await fs.symlink(path.join(outside, 'app.aab'), path.join(ws, 'build', 'link.aab'));
  // Act
  const read = await readReleaseFile('build/app.aab', { workspacePath: ws });
  // Assert
  assert.equal(read.signingCertSha256, sha256);
  assert.equal(read.versionCode, '43');
  await assert.rejects(readReleaseFile('../outside/app.aab', { workspacePath: ws }), /밖/);
  await assert.rejects(readReleaseFile('build/link.aab', { workspacePath: ws }), /밖/);
  await assert.rejects(readReleaseFile('build/missing.aab', { workspacePath: ws }), /찾을 수 없습니다/);
});
