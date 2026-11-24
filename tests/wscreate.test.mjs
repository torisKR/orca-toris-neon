import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { reservedGitTrace, recreateRefusal, CREATE_SETTLE_MS } from '../src/wscreate.mjs';

const git = promisify(execFile);
const NOW = Date.parse('2026-11-24T05:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();

async function repository() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'neon-wscreate-'));
  const run = (...args) => git('git', ['-C', root, ...args]);
  await run('init', '-q', '-b', 'main');
  await run('-c', 'user.email=a@example.com', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'init');
  return { root, run };
}

test('the git trace finds the reserved name as a branch with or without a prefix, and as a worktree folder', async () => {
  // Arrange
  const { root, run } = await repository();
  try {
    // Act / Assert
    assert.deepEqual(await reservedGitTrace(root, 'neon-abc'), { branch: false, worktree: false });
    await run('branch', 'me/neon-abc');
    assert.deepEqual(await reservedGitTrace(root, 'neon-abc'), { branch: true, worktree: false });
    assert.deepEqual(await reservedGitTrace(root, 'abc'), { branch: false, worktree: false }, 'only a whole segment matches');
    await run('worktree', 'add', '-q', '--detach', path.join(root, '.wt', 'neon-def'));
    assert.deepEqual(await reservedGitTrace(root, 'neon-def'), { branch: false, worktree: true });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('an unreadable repository is an error, never proof that nothing was created', async () => {
  await assert.rejects(reservedGitTrace('/nonexistent/neon-repo', 'neon-abc'));
});

test('recreating is refused inside the window, with a trace, or when git cannot be read; allowed only after all three clear', async () => {
  const clean = async () => ({ branch: false, worktree: false });
  const since = iso(NOW);
  assert.match(await recreateRefusal({ trace: clean, since, now: NOW + 1000 }), /아직 끝났는지 확인/);
  assert.match(await recreateRefusal({ trace: clean, since: 'not a time', now: NOW }), /아직 끝났는지 확인/, 'an unknown start time waits a full window');
  assert.match(await recreateRefusal({ trace: async () => ({ branch: true, worktree: false }), since, now: NOW + CREATE_SETTLE_MS }), /브랜치나 워크트리/);
  assert.match(await recreateRefusal({ trace: async () => { throw new Error('boom'); }, since, now: NOW + CREATE_SETTLE_MS }), /boom/);
  assert.equal(await recreateRefusal({ trace: clean, since, now: NOW + CREATE_SETTLE_MS }), null);
});
