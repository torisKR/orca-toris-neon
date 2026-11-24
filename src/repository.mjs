/**
 * What Neon reads from a local Git checkout: whether a repository can seed a worktree, and the
 * content-sensitive source fingerprint that ties verification to the exact source. Fails closed:
 * a checkout that cannot be measured throws instead of reading as unchanged.
 */
import { promises as fs, constants as FS_CONSTANTS, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const runtimeError = (code, message) => Object.assign(new Error(message), { code });
function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

export async function digestFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename, { flags: FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0) })) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

/** Whether a local repository can seed a worktree: it needs a commit, and the chosen base if any. */
export async function gitRepositoryState(repositoryPath, baseBranch) {
  const verify = async (ref) => {
    try {
      await execFileAsync('git', ['-c', 'core.fsmonitor=false', '-C', repositoryPath, 'rev-parse', '--verify', '--quiet', ref + '^{commit}'], {
        encoding: 'utf8', timeout: 10_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      });
      return true;
    } catch (error) {
      if (error.code === 1) return false; // --quiet: the ref does not exist
      throw error;
    }
  };
  // Orca also accepts a base that exists only as a remote-tracking branch.
  const remoteOnly = async (name) => (await execFileAsync('git', ['-C', repositoryPath, 'for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes/*/' + name], {
    encoding: 'utf8', timeout: 10_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout.trim() !== '';
  const hasCommit = await verify('HEAD');
  if (!hasCommit || !baseBranch) return { hasCommit, hasBase: hasCommit };
  return { hasCommit, hasBase: await verify(baseBranch) || await remoteOnly(baseBranch) };
}
export function preflightMessage({ hasCommit, hasBase }, baseBranch) {
  if (!hasCommit) return '이 저장소에는 아직 커밋이 없어 작업 공간을 만들 기준 브랜치가 없습니다. 프로젝트에서 첫 커밋을 만든 뒤(예: git add -A && git commit -m "init") 같은 시작 버튼을 다시 누르세요.';
  if (!hasBase) return "기준 브랜치 '" + baseBranch + "'를 저장소에서 찾을 수 없습니다. 브랜치를 만들거나 기준 브랜치를 비운 새 흐름을 만드세요.";
  return null;
}

/** Content-sensitive Git fingerprint; fails closed if the checkout cannot be measured. */
export async function sourceFingerprint(workspacePath) {
  const git = async (args) => (await execFileAsync('git', ['-c', 'core.fsmonitor=false', '-C', workspacePath, ...args], {
    encoding: 'utf8', timeout: 20_000, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout;
  // Settle all children before reporting failure so none outlive checkout inspection.
  const reads = await Promise.allSettled([
    git(['rev-parse', 'HEAD']),
    git(['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--']),
    git(['ls-files', '--others', '--exclude-standard', '-z']),
    git(['ls-files', '--stage', '-v', '-z'])
  ]);
  const failed = reads.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  const [head, tracked, names, indexEntries] = reads.map(result => result.value);
  const entries = indexEntries.split('\0').filter(Boolean);
  if (entries.some(entry => /^[a-zS] /.test(entry))) {
    throw runtimeError('not_permitted', 'assume-unchanged/skip-worktree 파일은 실제 변경이 숨겨질 수 있어 검증 기준을 확정할 수 없습니다. Git 플래그를 해제하고 다시 검증하세요.');
  }
  if (entries.some(entry => /^\S (120000|160000) /.test(entry)) ||
      /^(?:new file mode|new mode) 120000$/m.test(tracked)) {
    throw runtimeError('not_permitted', '심볼릭 링크/서브모듈이 포함된 소스는 현재 검증 기준을 안전하게 확정할 수 없습니다. 일반 소스 파일로 구성된 작업 공간을 사용하세요.');
  }
  const hash = createHash('sha256').update(head).update('\0').update(tracked).update('\0');
  const untracked = names.split('\0').filter(Boolean).sort();
  if (untracked.length > 5000) throw runtimeError('too_large', '추적되지 않은 파일이 너무 많아 검증 기준을 확정할 수 없습니다.');
  let bytes = 0;
  for (const name of untracked) {
    const filename = path.resolve(workspacePath, name);
    if (!within(workspacePath, filename)) throw runtimeError('invalid_params', 'Git 파일 경로를 검증하지 못했습니다.');
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) {
      throw runtimeError('not_permitted', '미추적 심볼릭 링크가 있어 소스 신선도를 확인할 수 없습니다.');
    } else if (stat.isFile()) {
      bytes += stat.size;
      if (bytes > 128 * 1024 * 1024) throw runtimeError('too_large', '검증할 미추적 파일이 128 MiB를 넘습니다. 빌드 출력을 .gitignore에 추가하세요.');
      hash.update(name).update('\0').update(await digestFile(filename));
    }
  }
  return hash.digest('hex');
}
