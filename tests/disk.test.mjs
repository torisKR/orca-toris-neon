import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { measureTree, runDisk, diskHandlers, BUILD_OUTPUTS } from '../src/disk.mjs';

async function scratch() { return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neon-disk-'))); }
async function gitWorkspace() { const dir = await scratch(); execFileSync('git', ['init', '-q', dir]); return dir; }
async function write(file, bytes) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, Buffer.alloc(bytes)); }
async function snapshot(root) {
  const out = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true, recursive: true })) out.push(path.join(entry.parentPath ?? entry.path, entry.name));
  return out.sort();
}

test('a tree is summed without following symlinks and a large tree is marked partial', async () => {
  // Arrange
  const root = await scratch();
  await write(path.join(root, 'a.bin'), 100);
  await write(path.join(root, 'sub', 'b.bin'), 50);
  const outside = await scratch();
  await write(path.join(outside, 'huge.bin'), 5000);
  await fs.symlink(outside, path.join(root, 'link'));
  // Act
  const full = await measureTree(root);
  const partial = await measureTree(root, { maxEntries: 1 });
  // Assert
  assert.equal(full.bytes, 150);
  assert.equal(full.files, 2);
  assert.equal(full.truncated, false);
  assert.equal(partial.truncated, true);
  assert.equal((await measureTree(path.join(root, 'missing'))).exists, false);
});

test('signing material inside a tree is detected', async () => {
  const root = await scratch();
  await write(path.join(root, 'android', 'upload.jks'), 10);
  assert.equal((await measureTree(root)).signing, true);
});

function fixtureRun({ receiptRoot, workspacePath, status = 'completed' }) {
  const dir = (nonce) => path.join(receiptRoot, 'run-1', 'build', '1-work-' + nonce);
  return {
    id: 'run-1', status, isolate: true, workspaceCreation: { state: 'created' }, workspacePath,
    nodes: [
      { id: 'build', status: 'passed', receipt: { path: path.join(dir('ok'), 'result.json') }, report: { evidence: [{ kind: 'artifact', path: path.join(dir('ok'), 'after.png') }] }, active: status === 'running' ? { nonce: 'live' } : null },
    ],
    jobs: [
      { nonce: 'ok', nodeId: 'build', state: 'complete', receiptDirectory: dir('ok') },
      { nonce: 'old', nodeId: 'build', state: 'superseded', receiptDirectory: dir('old') },
      { nonce: 'live', nodeId: 'build', state: status === 'running' ? 'running' : 'complete', receiptDirectory: dir('live') },
      { nonce: 'escape', nodeId: 'build', state: 'complete', receiptDirectory: '/etc' }
    ]
  };
}

test('receipt folders are classified as in use, referenced evidence or cleanup candidates, and nothing is removed', async () => {
  // Arrange
  const receiptRoot = await scratch();
  const workspacePath = await gitWorkspace();
  const run = fixtureRun({ receiptRoot, workspacePath, status: 'running' });
  for (const nonce of ['ok', 'old', 'live']) await write(path.join(receiptRoot, 'run-1', 'build', '1-work-' + nonce, 'result.json'), 40);
  await write(path.join(receiptRoot, 'run-1', 'build', '1-work-ok', 'after.png'), 1000);
  await write(path.join(workspacePath, 'build', 'app.apk'), 3000);
  await write(path.join(workspacePath, 'lib', 'main.dart'), 30);
  const before = [await snapshot(receiptRoot), await snapshot(workspacePath)];
  // Act
  const disk = await runDisk({ run, runs: [run], receiptRoot });
  // Assert
  const byNonce = Object.fromEntries(disk.receipts.jobs.map((item) => [path.basename(item.path), item.kind]));
  assert.deepEqual(byNonce, { '1-work-ok': 'referenced', '1-work-old': 'candidate', '1-work-live': 'live' });
  assert.equal(disk.receipts.path, path.join(receiptRoot, 'run-1'));
  assert.equal(disk.receipts.bytes, 1120);
  assert.ok(!disk.receipts.jobs.some((item) => item.path === '/etc'), 'a folder outside the run receipts is never listed');
  assert.equal(disk.builds.find((item) => item.relative === 'build').kind, 'live', 'a running run may still use its build output');
  assert.deepEqual(disk.candidates, { count: 1, bytes: 40 });
  assert.deepEqual([await snapshot(receiptRoot), await snapshot(workspacePath)], before, 'measuring removes nothing');
});

test('after the run ends, build outputs become candidates unless they hold signing material or are tracked by Git', async () => {
  // Arrange
  const receiptRoot = await scratch();
  const workspacePath = await gitWorkspace();
  await write(path.join(workspacePath, 'app', 'build', 'kept.txt'), 7);
  execFileSync('git', ['-C', workspacePath, 'add', 'app/build/kept.txt']);
  const run = fixtureRun({ receiptRoot, workspacePath });
  await write(path.join(workspacePath, 'build', 'app.apk'), 3000);
  await write(path.join(workspacePath, '.dart_tool', 'x'), 200);
  await write(path.join(workspacePath, '.dart_tool', 'release.keystore'), 5);
  // Act
  const disk = await runDisk({ run, runs: [run], receiptRoot });
  // Assert
  const kinds = Object.fromEntries(disk.builds.map((item) => [item.relative, item.kind + (item.reason ? ':' + item.reason : '')]));
  assert.deepEqual(kinds, { build: 'candidate', '.dart_tool': 'protected:signing', 'app/build': 'protected:tracked' });
  assert.equal(disk.receipts.exists, false);
  assert.deepEqual(disk.candidates, { count: 1, bytes: 3000 });
});

test('a workspace Neon did not create is not scanned for build outputs', async () => {
  const receiptRoot = await scratch();
  const workspacePath = await scratch();
  await write(path.join(workspacePath, 'build', 'app.apk'), 3000);
  const run = { ...fixtureRun({ receiptRoot, workspacePath }), isolate: false };
  const disk = await runDisk({ run, runs: [run], receiptRoot });
  assert.deepEqual(disk.builds, []);
  assert.match(disk.buildsNote, /Neon이 만든 작업 공간이 아니/);
});

test('a symlinked build output is not followed or listed', async () => {
  const receiptRoot = await scratch();
  const workspacePath = await gitWorkspace();
  const elsewhere = await scratch();
  await write(path.join(elsewhere, 'big.bin'), 9000);
  await fs.symlink(elsewhere, path.join(workspacePath, 'build'));
  const run = fixtureRun({ receiptRoot, workspacePath });
  const disk = await runDisk({ run, runs: [run], receiptRoot });
  assert.deepEqual(disk.builds, []);
});

test('the runs.disk request finds the run by id and refuses unknown or malformed ids', async () => {
  // Arrange
  const receiptRoot = await scratch();
  const run = fixtureRun({ receiptRoot, workspacePath: await scratch() });
  const { 'runs.disk': handler } = diskHandlers({ getRuns: () => [run], receiptRoot });
  // Act / Assert
  assert.equal((await handler({ runId: 'run-1' })).runId, 'run-1');
  await assert.rejects(handler({ runId: 'nope' }), /실행을 찾을 수 없습니다/);
  await assert.rejects(handler({ runId: '../x' }), /실행을 찾을 수 없습니다/);
});

test('a folder that could not be read in full is protected, never a candidate', async () => {
  // Arrange: more entries than the walk may read, in a finished run
  const receiptRoot = await scratch();
  const workspacePath = await gitWorkspace();
  for (let index = 0; index < 5; index++) await write(path.join(workspacePath, 'build', 'f' + index), 10);
  const run = fixtureRun({ receiptRoot, workspacePath });
  // Act
  const disk = await runDisk({ run, runs: [run], receiptRoot, maxEntries: 2 });
  // Assert
  assert.deepEqual([disk.builds[0].kind, disk.builds[0].reason, disk.builds[0].truncated], ['protected', 'unreadable', true]);
  assert.deepEqual(disk.candidates, { count: 0, bytes: 0 });
});

test('receipt bytes no job accounts for (an archived run has no folder ledger) are reported as unclassified', async () => {
  const receiptRoot = await scratch();
  await write(path.join(receiptRoot, 'run-1', 'build', '1-work-x', 'result.json'), 300);
  const run = { ...fixtureRun({ receiptRoot, workspacePath: await scratch() }), jobs: [{ nonce: 'x', nodeId: 'build', state: 'complete' }] };
  const disk = await runDisk({ run, runs: [run], receiptRoot });
  assert.equal(disk.receipts.unclassifiedBytes, 300);
  assert.deepEqual(disk.candidates, { count: 0, bytes: 0 });
});

test('an unreadable folder is reported as present but partial, not as absent', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root reads everything');
  const root = await scratch();
  await write(path.join(root, 'locked', 'a'), 10);
  await fs.chmod(path.join(root, 'locked'), 0o000);
  t.after(() => fs.chmod(path.join(root, 'locked'), 0o755));
  const result = await measureTree(path.join(root, 'locked'));
  assert.equal(result.exists, true);
  assert.equal(result.truncated, true);
});

test('a build output reached through a symlinked parent folder is not measured or listed', async () => {
  // Arrange: app -> a folder outside the workspace that holds build/
  const receiptRoot = await scratch();
  const workspacePath = await gitWorkspace();
  const elsewhere = await scratch();
  await write(path.join(elsewhere, 'build', 'big.bin'), 9000);
  await fs.symlink(elsewhere, path.join(workspacePath, 'app'));
  const run = fixtureRun({ receiptRoot, workspacePath });
  // Act
  const disk = await runDisk({ run, runs: [run], receiptRoot });
  // Assert
  assert.deepEqual(disk.builds, []);
});

test('a finished run\'s build outputs stay in use while another unfinished run shares its workspace', async () => {
  const receiptRoot = await scratch();
  const workspacePath = await gitWorkspace();
  await write(path.join(workspacePath, 'build', 'app.apk'), 3000);
  const run = fixtureRun({ receiptRoot, workspacePath });
  const other = { id: 'run-2', status: 'running', isolate: false, workspacePath, nodes: [], jobs: [] };
  const disk = await runDisk({ run, runs: [run, other], receiptRoot });
  assert.equal(disk.builds[0].kind, 'live');
  assert.deepEqual(disk.candidates, { count: 0, bytes: 0 });
});

test('a saved job that kept only its receipt file path is still classified by that file\'s folder', async () => {
  const receiptRoot = await scratch();
  const dir = path.join(receiptRoot, 'run-1', 'build', '1-work-old');
  await write(path.join(dir, 'result.json'), 50);
  const run = { ...fixtureRun({ receiptRoot, workspacePath: await scratch() }), jobs: [{ nonce: 'old', nodeId: 'build', state: 'superseded', receiptPath: path.join(dir, 'result.json') }] };
  const disk = await runDisk({ run, runs: [run], receiptRoot });
  assert.deepEqual(disk.receipts.jobs.map((item) => [item.path, item.kind]), [[dir, 'candidate']]);
});

test('a build output in a workspace that is not a Git checkout is protected, never a candidate', async () => {
  const receiptRoot = await scratch();
  const workspacePath = await scratch();
  await write(path.join(workspacePath, 'build', 'app.apk'), 3000);
  const run = fixtureRun({ receiptRoot, workspacePath });
  const disk = await runDisk({ run, runs: [run], receiptRoot });
  assert.equal(disk.builds[0].kind, 'protected');
  assert.deepEqual(disk.candidates, { count: 0, bytes: 0 });
});

test('the known build output folders are relative and stay inside the workspace', () => {
  for (const relative of BUILD_OUTPUTS) assert.ok(!path.isAbsolute(relative) && !relative.split('/').includes('..'));
});
