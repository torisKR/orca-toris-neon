/**
 * Which code is running: plugin version, the git commit of the plugin folder (with a dirty flag),
 * and whether Orca loaded a development folder or an installed release. Read once at worker start.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const defaultGit = async (args, cwd) => (await run('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true })).stdout;
// Orca installs plugins under its application-support folder; a folder elsewhere is a development load.
const INSTALLED = /[\\/]orca[\\/]plugins[\\/]/;

export async function readBuildInfo({ root, readFile = (file) => fs.readFile(file, 'utf8'), git = defaultGit } = {}) {
  let version = null;
  try { version = JSON.parse(await readFile(path.join(root, 'orca-plugin.json'))).version ?? null; } catch { version = null; }
  const channel = INSTALLED.test(root) ? 'release' : 'dev';
  try {
    const commit = (await git(['rev-parse', 'HEAD'], root)).trim();
    const status = await git(['status', '--porcelain=v1', '--untracked-files=normal'], root);
    return { version, commit, shortCommit: commit.slice(0, 7), dirty: status.trim() !== '', channel, error: null };
  } catch (error) {
    return { version, commit: null, shortCommit: null, dirty: null, channel, error: '이 폴더의 git 커밋을 읽지 못했습니다: ' + String(error?.message ?? error).split('\n')[0].slice(0, 160) };
  }
}

export function buildLabel(info) {
  if (!info) return '버전 정보 없음';
  return ['v' + (info.version ?? '?'), info.shortCommit ? info.shortCommit + (info.dirty ? '+수정' : '') : '커밋 정보 없음', info.channel === 'release' ? '설치본' : '개발 폴더'].join(' · ');
}
