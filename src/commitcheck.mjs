/**
 * A stage that writes source must leave its work committed on the run branch before its report is
 * accepted: a clean tree (ignored files aside) and a HEAD that moved since the stage started.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const git = async (cwd, args) => (await run('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
  encoding: 'utf8', timeout: 10_000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;

/** { head, clean, changed: up to 20 paths } of a working tree. */
export async function gitWorkingState(dir) {
  const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const lines = (await git(dir, ['status', '--porcelain=v1', '--untracked-files=all'])).split('\n').filter(Boolean);
  return { head, clean: lines.length === 0, changed: lines.slice(0, 20).map((line) => line.slice(3)) };
}

/** Why the work is not committed, for the agent; null when it is. */
export function commitProblem(job, state) {
  if (!state) return null;
  const problems = [];
  if (!state.clean) problems.push('커밋하지 않은 변경이 있습니다(' + state.changed.slice(0, 8).join(', ') + (state.changed.length > 8 ? ' 외' : '') + ')');
  if (job.startHead && state.head === job.startHead) problems.push('이 단계에서 새 커밋이 없습니다');
  return problems.length ? problems.join('; ') + '.' : null;
}

/**
 * For a passed report: a writing stage's work must be committed ('commit', the agent can fix it);
 * a review is of one commit, so HEAD moving during the review makes it stale ('moved').
 */
export function sourceProblem({ job, write, report, state }) {
  if (!state || report?.outcome !== 'passed') return null;
  if (job.phase === 'work' && write) {
    const message = commitProblem(job, state);
    return message ? { kind: 'commit', message } : null;
  }
  if (job.phase === 'review' && job.sourceCommit && state.head !== job.sourceCommit) {
    return { kind: 'moved', message: '검토 도중 실행 브랜치의 커밋이 바뀌었습니다(' + job.sourceCommit.slice(0, 7) + ' → ' + state.head.slice(0, 7) + '). 현재 커밋을 다시 검토해야 합니다.' };
  }
  return null;
}
