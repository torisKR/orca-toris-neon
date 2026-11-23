import test from 'node:test';
import assert from 'node:assert/strict';
import { readBuildInfo, buildLabel } from '../src/buildinfo.mjs';

const manifest = async () => JSON.stringify({ version: '0.2.0' });
const git = (head, status = '') => async (args) => {
  if (args.includes('rev-parse')) { if (head === null) throw Object.assign(new Error('fatal: not a git repository'), { code: 128 }); return head + '\n'; }
  if (args.includes('status')) return status;
  throw new Error('unexpected git ' + args.join(' '));
};

test('a dev-loaded checkout reports version, commit and a clean tree', async () => {
  const info = await readBuildInfo({ root: '/Users/me/projects/orca-toris-neon', readFile: manifest, git: git('493d14f0123456789') });
  assert.deepEqual(info, { version: '0.2.0', commit: '493d14f0123456789', shortCommit: '493d14f', dirty: false, channel: 'dev', error: null });
  assert.equal(buildLabel(info), 'v0.2.0 · 493d14f · 개발 폴더');
});

test('a dirty tree, a non-git folder and an installed release are said plainly', async () => {
  const dirty = await readBuildInfo({ root: '/r', readFile: manifest, git: git('abcdef1234', ' M src/runtime.mjs\n') });
  assert.equal(dirty.dirty, true);
  assert.equal(buildLabel(dirty), 'v0.2.0 · abcdef1+수정 · 개발 폴더');
  const plain = await readBuildInfo({ root: '/Users/me/Library/Application Support/orca/plugins/local.toris-neon', readFile: manifest, git: git(null) });
  assert.equal(plain.channel, 'release');
  assert.equal(plain.commit, null);
  assert.match(plain.error, /git/);
  assert.equal(buildLabel(plain), 'v0.2.0 · 커밋 정보 없음 · 설치본');
  assert.equal(buildLabel(null), '버전 정보 없음');
});
