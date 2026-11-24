/**
 * When a workspace.create whose answer never came may be issued again (review H-2).
 *
 * A timeout or a worker stopped mid-call leaves the first create in flight: Orca may still be adding
 * the worktree, so "the reserved name is not listed yet" is not "absent". A second create goes out
 * only when the first is proven absent: the name is still unlisted after a settle window, and git
 * has no branch (Orca names it `<prefix>/<name>` or `<name>`) and no registered worktree of that name.
 * A git state that cannot be read proves nothing and refuses too.
 */
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
/** How long after an uncertain create the plugin keeps waiting for it to show up before recreating. */
export const CREATE_SETTLE_MS = 2 * 60_000;

/** Whether the reserved name exists in git as a branch (any prefix) or a registered worktree. Throws when git cannot answer. */
export async function reservedGitTrace(repositoryPath, name) {
  const git = async (args) => (await execFileAsync('git', ['-c', 'core.fsmonitor=false', '-C', repositoryPath, ...args], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })).stdout;
  const [branches, worktrees] = await Promise.all([
    git(['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
    git(['worktree', 'list', '--porcelain']),
  ]);
  return {
    branch: branches.split('\n').some((ref) => ref === name || ref.endsWith('/' + name)),
    worktree: worktrees.split('\n').some((line) => line.startsWith('worktree ') && path.basename(line.slice('worktree '.length)) === name),
  };
}

/** Why the create must not be sent again yet, or null once the first is proven absent. `since` is when it became uncertain. */
export async function recreateRefusal({ trace, since, now }) {
  const started = Date.parse(since ?? '');
  const left = Number.isFinite(started) ? started + CREATE_SETTLE_MS - now : CREATE_SETTLE_MS;
  if (left > 0) {
    return '첫 작업 공간 생성 요청이 아직 끝났는지 확인하는 중입니다. 중복 생성을 막기 위해 다시 만들지 않았습니다. ' +
      Math.ceil(left / 1000) + '초 뒤 같은 버튼을 다시 누르세요. 그사이 Orca에 나타나면 그 작업 공간을 이어서 씁니다.';
  }
  let found;
  try { found = await trace(); }
  catch (error) {
    return 'Git 상태를 확인하지 못해 첫 생성 요청이 없었다고 확정할 수 없습니다. 중복 생성하지 않았습니다: ' + String(error?.message ?? error).slice(0, 300);
  }
  if (found.branch || found.worktree) {
    return '예약한 이름의 브랜치나 워크트리가 Git에 있지만 Orca 목록에는 없습니다. 첫 생성이 아직 진행 중이거나 중간에 멈춘 흔적입니다. ' +
      'Orca에 나타나면 같은 버튼으로 이어 쓰고, 멈춘 흔적이면 Orca 또는 Git에서 정리한 뒤 다시 누르세요. 중복 생성하지 않았습니다.';
  }
  return null;
}
