import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { readArtifact, artifactReader, ARTIFACT_LIMITS } from '../src/artifacts.mjs';
import { createHash } from 'node:crypto';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'neon-artifacts-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const receipts = path.join(root, 'runs', 'r1'); const workspace = path.join(root, 'ws'); const outside = path.join(root, 'outside');
  for (const dir of [receipts, workspace, outside]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(receipts, 'after.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(workspace, 'build.log'), 'line\n'.repeat(50_000));
  await fs.writeFile(path.join(outside, 'secret.png'), 'x');
  await fs.symlink(path.join(outside, 'secret.png'), path.join(receipts, 'escape.png'));
  return { roots: [receipts, workspace], receipts, workspace, outside };
}

test('an image inside the run is sent as data with its type; a log as a bounded excerpt', async (t) => {
  const f = await fixture(t);
  const image = await readArtifact({ file: path.join(f.receipts, 'after.png'), roots: f.roots });
  assert.deepEqual([image.kind, image.mime, image.size], ['image', 'image/png', 4]);
  assert.equal(Buffer.from(image.data, 'base64').length, 4);
  const log = await readArtifact({ file: path.join(f.workspace, 'build.log'), roots: f.roots });
  assert.equal(log.kind, 'text');
  assert.ok(log.text.length <= ARTIFACT_LIMITS.textChars);
  assert.equal(log.truncated, true);
});

test('paths outside the run, symlink escapes, unknown types and oversized files are refused', async (t) => {
  const f = await fixture(t);
  await assert.rejects(readArtifact({ file: path.join(f.outside, 'secret.png'), roots: f.roots }), /실행 결과 폴더/);
  await assert.rejects(readArtifact({ file: path.join(f.receipts, '..', '..', 'outside', 'secret.png'), roots: f.roots }), /실행 결과 폴더/);
  await assert.rejects(readArtifact({ file: path.join(f.receipts, 'escape.png'), roots: f.roots }), /실행 결과 폴더/);
  await fs.writeFile(path.join(f.receipts, 'tool.exe'), 'x');
  await assert.rejects(readArtifact({ file: path.join(f.receipts, 'tool.exe'), roots: f.roots }), /형식/);
  await fs.writeFile(path.join(f.receipts, 'big.png'), Buffer.alloc(ARTIFACT_LIMITS.mediaBytes + 1));
  await assert.rejects(readArtifact({ file: path.join(f.receipts, 'big.png'), roots: f.roots }), /크기/);
});

test('the panel request resolves the run and reads only inside its receipt folder or workspace', async (t) => {
  const f = await fixture(t);
  const recorded = (file) => ({ id: 'build', report: { evidence: [{ kind: 'artifact', path: file }] } });
  const runs = [{ id: 'r1', workspacePath: f.workspace, nodes: [recorded(path.join(f.receipts, 'after.png')), recorded(path.join(f.workspace, 'build.log')), recorded(path.join(f.outside, 'secret.png'))] }];
  const read = artifactReader({ runs: () => runs, receiptRoot: path.dirname(f.receipts) });
  assert.equal((await read({ runId: 'r1', path: path.join(f.receipts, 'after.png') })).mime, 'image/png');
  assert.equal((await read({ runId: 'r1', path: path.join(f.workspace, 'build.log') })).kind, 'text');
  await assert.rejects(read({ runId: 'nope', path: path.join(f.receipts, 'after.png') }), /실행/);
  await assert.rejects(read({ runId: '../r1', path: path.join(f.receipts, 'after.png') }), /실행/);
  await assert.rejects(read({ runId: 'r1', path: path.join(f.outside, 'secret.png') }), /실행 결과 폴더/);
  await fs.writeFile(path.join(f.workspace, 'google-services.json'), '{}');
  await assert.rejects(read({ runId: 'r1', path: path.join(f.workspace, 'google-services.json') }), /보고서/, 'only files a report recorded as artifacts');
});

test('a receipt directory must still be a directory owned by the run when its artifact is read', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.receipts, 'after.png');
  const runs = [{ id: 'r1', workspacePath: f.workspace, nodes: [{ report: { evidence: [{ kind: 'artifact', path: file }] } }] }];
  const read = artifactReader({ runs: () => runs, receiptRoot: path.dirname(f.receipts) });
  await fs.rename(f.receipts, f.receipts + '-moved');
  await fs.symlink(f.receipts + '-moved', f.receipts);

  await assert.rejects(read({ runId: 'r1', path: file }), /실행 결과 폴더나 작업 공간 밖/);
});

const sha = (data) => createHash('sha256').update(data).digest('hex');

test('a relative artifact path is read from the receipt folder of the report that recorded it, as at intake', async (t) => {
  // Arrange
  const f = await fixture(t);
  const directory = path.join(f.receipts, 'build', '1-work-n1');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'after.png'), Buffer.from([1, 2, 3]));
  const report = { nodeId: 'build', nonce: 'n1', phase: 'work', attempt: 1, evidence: [{ kind: 'artifact', path: 'after.png', sha256: sha(Buffer.from([1, 2, 3])) }] };
  const runs = [{ id: 'r1', workspacePath: f.workspace, nodes: [{ id: 'build', report }] }];
  const read = artifactReader({ runs: () => runs, receiptRoot: path.dirname(f.receipts) });
  // Act
  const image = await read({ runId: 'r1', path: 'after.png' });
  // Assert
  assert.equal(image.kind, 'image');
  assert.equal(image.verified, true);
  await assert.rejects(read({ runId: 'r1', path: '../../outside/secret.png' }), /보고서/);
});

test('a file changed since intake shows 변경됨 instead of its content; a file with no stored hash says it is unverified', async (t) => {
  // Arrange
  const f = await fixture(t);
  const file = path.join(f.receipts, 'after.png');
  const runs = [{ id: 'r1', workspacePath: f.workspace, nodes: [
    { id: 'build', report: { evidence: [{ kind: 'artifact', path: file, sha256: sha('the screenshot taken at intake') }] } },
    { id: 'test', report: { evidence: [{ kind: 'artifact', path: path.join(f.workspace, 'build.log') }] } }] }];
  const read = artifactReader({ runs: () => runs, receiptRoot: path.dirname(f.receipts) });
  // Act
  const changed = await read({ runId: 'r1', path: file });
  const unhashed = await read({ runId: 'r1', path: path.join(f.workspace, 'build.log') });
  // Assert
  assert.equal(changed.kind, 'changed');
  assert.equal(changed.data, undefined, 'no content of a changed file is sent');
  assert.match(changed.text, /변경됨/);
  assert.equal(unhashed.kind, 'text');
  assert.equal(unhashed.verified, false);
});

test('the intake hash of the latest receipt is used when the report item carries none', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.receipts, 'after.png');
  const runs = [{ id: 'r1', workspacePath: f.workspace, nodes: [{ id: 'build', report: { evidence: [{ kind: 'artifact', path: file }] },
    receipt: { artifacts: [{ kind: 'artifact', path: file, sha256: sha(Buffer.from([0x89, 0x50, 0x4e, 0x47])) }] } }] }];
  const read = artifactReader({ runs: () => runs, receiptRoot: path.dirname(f.receipts) });
  assert.equal((await read({ runId: 'r1', path: file })).verified, true);
});
