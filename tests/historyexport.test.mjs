import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createHistoryExport, repositoryVisibility, EXPORT_SETTING } from '../src/historyexport.mjs';

const AT = Date.parse('2026-11-24T05:00:00.000Z');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const sha = (data) => createHash('sha256').update(data).digest('hex');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'neon-history-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const receiptRoot = path.join(root, 'runs'), workspace = path.join(root, 'ws'), target = path.join(root, 'export');
  const folder = path.join(receiptRoot, 'run-1', 'build', '1-work-n1');
  await fs.mkdir(folder, { recursive: true });
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(folder, 'after.png'), PNG);
  await fs.writeFile(path.join(folder, 'before.png'), PNG);
  const run = (id, extra = {}) => ({ id, goal: '물주기 앱 ' + id, status: 'completed', workspacePath: workspace, createdAt: '2026-11-23T00:00:00.000Z', updatedAt: '2026-11-23T01:00:00.000Z',
    nodes: [{ id: 'build', title: '앱 구현', status: 'passed', review: { outcome: 'passed' },
      report: { outcome: 'passed', phase: 'work', nonce: 'n1', attempt: 1, summary: '완료', evidence: [
        { kind: 'artifact', path: 'after.png', label: 'screenshot', sha256: sha(PNG) },
        { kind: 'artifact', path: 'before.png', label: 'screenshot', sha256: sha('the image taken at intake') }] } }], ...extra });
  const runs = [run('run-1'), run('run-2'), run('live', { status: 'running' })];
  return { root, receiptRoot, workspace, target, runs };
}
const notGit = async (file, args) => { if (file === 'git') throw Object.assign(new Error('Command failed'), { code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' }); throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
const exporter = (f, extra = {}) => createHistoryExport({ getRuns: () => f.runs, settings: { get: async (key) => key === EXPORT_SETTING ? f.target : undefined }, receiptRoot: f.receiptRoot,
  readPlay: async () => ({ accounts: [] }), exec: notGit, now: () => AT, home: f.root, platform: 'linux', ...extra });

test('finished runs are written to one folder per run id as JSON and a static page with verified thumbnails', async (t) => {
  // Arrange
  const f = await fixture(t);
  // Act
  const result = await exporter(f).export({});
  // Assert
  assert.deepEqual(result.exported.map((item) => item.runId).sort(), ['run-1', 'run-2'], 'a running run is not exported');
  const record = JSON.parse(await fs.readFile(path.join(f.target, 'run-1', 'run.json'), 'utf8'));
  assert.equal(record.snapshot, true);
  assert.equal(record.exportedAt, new Date(AT).toISOString());
  const files = record.stages[0].files;
  assert.equal(files[0].thumbnail, 'thumbs/build-1.png');
  assert.deepEqual(await fs.readFile(path.join(f.target, 'run-1', 'thumbs', 'build-1.png')), PNG);
  assert.equal(files[1].changed, true, 'a file changed since intake is marked, not exported');
  assert.equal(files[1].thumbnail, undefined);
  const page = await fs.readFile(path.join(f.target, 'run-1', 'index.html'), 'utf8');
  assert.match(page, /내보낸 시점의 스냅샷/);
  assert.ok(!JSON.stringify(record).includes(f.root), 'no absolute path of this machine');
  assert.deepEqual((await fs.readdir(f.target)).sort(), ['run-1', 'run-2']);
});

test('only the chosen runs are exported, and a run that is not finished is skipped with the reason', async (t) => {
  const f = await fixture(t);
  const result = await exporter(f).export({ runIds: ['run-2', 'live', 'missing'] });
  assert.deepEqual(result.exported.map((item) => item.runId), ['run-2']);
  assert.deepEqual(result.skipped.map((item) => item.runId), ['live', 'missing']);
  assert.match(result.skipped[0].reason, /끝난 실행/);
});

test('without a chosen folder nothing is written and the person is told where to set it', async (t) => {
  const f = await fixture(t);
  await assert.rejects(exporter(f, { settings: { get: async () => '' } }).export({}), (error) => /settings_required/.test(error.message) && /기록 내보내기 폴더/.test(error.message));
  await assert.rejects(exporter(f, { settings: { get: async () => 'relative/dir' } }).export({}), /절대 경로/);
});

const gitHost = (visibility) => async (file, args) => {
  if (file === 'git' && args.includes('--show-toplevel')) return { stdout: '/Users/me/notes\n' };
  if (file === 'git' && args.at(-1) === 'remote') return { stdout: 'origin\n' };
  if (file === 'git' && args.includes('get-url')) return { stdout: 'https://github.com/example/notes.git\n' };
  if (file === 'gh') { if (visibility instanceof Error) throw visibility; return { stdout: visibility + '\n' }; }
  throw new Error('unexpected ' + file);
};

test('a target inside a git repository whose remote is public is refused before anything is written', async (t) => {
  // Arrange
  const f = await fixture(t);
  // Act / Assert
  await assert.rejects(exporter(f, { exec: gitHost('PUBLIC') }).export({}), (error) => /public_repository/.test(error.message) && /공개 저장소/.test(error.message));
  await assert.rejects(fs.readdir(f.target), { code: 'ENOENT' });
});

test('unknown visibility needs an explicit confirmation; a private remote or a folder outside git does not', async (t) => {
  // Arrange
  const f = await fixture(t);
  const noGh = gitHost(Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }));
  // Act / Assert
  await assert.rejects(exporter(f, { exec: noGh }).export({}), (error) => /confirmation_required/.test(error.message) && /공개 여부를 확인하지 못했습니다/.test(error.message));
  assert.equal((await exporter(f, { exec: noGh }).export({ confirmUnknownVisibility: true })).visibility, 'unknown');
  assert.equal((await exporter(f, { exec: gitHost('PRIVATE') }).export({})).visibility, 'private');
  assert.equal((await repositoryVisibility('/tmp/x', notGit)).state, 'none');
});

test('a git failure other than "not a repository" is unknown, so the person must confirm instead of exporting silently', async (t) => {
  const f = await fixture(t);
  const dubious = async (file) => { throw Object.assign(new Error('Command failed'), { code: 128, stderr: 'fatal: detected dubious ownership in repository' }); };
  assert.equal((await repositoryVisibility('/tmp/x', dubious)).state, 'unknown');
  await assert.rejects(exporter(f, { exec: dubious }).export({}), /confirmation_required/);
});

test('a missing thumbnail and an unreadable Play state are said in the record, not dropped silently', async (t) => {
  // Arrange
  const f = await fixture(t);
  await fs.rm(path.join(f.receiptRoot, 'run-1', 'build', '1-work-n1', 'after.png'));
  // Act
  await exporter(f, { readPlay: async () => { throw new Error('token expired'); } }).export({ runIds: ['run-1'] });
  // Assert
  const record = JSON.parse(await fs.readFile(path.join(f.target, 'run-1', 'run.json'), 'utf8'));
  assert.match(record.stages[0].files[0].thumbnailMissing, /읽지 못했습니다/);
  assert.match(record.playError, /Play 관측값을 읽지 못했습니다.*token expired/);
});

test('a settings read failure is reported as that, not as an unset folder', async (t) => {
  const f = await fixture(t);
  await assert.rejects(exporter(f, { settings: { get: async () => { throw new Error('settings locked'); } } }).export({}), /설정을 읽지 못했습니다.*settings locked/);
});
