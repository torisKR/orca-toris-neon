/**
 * A durable cancel (review H-1). A cancel is the user's decision and is never refused because
 * storage failed: the run is cancelled in memory at once, so the scheduler and the supervisor skip
 * it. Before any terminal closes the intent is made durable: the full save, or else a small mark
 * under its own key that a restart applies over the older stored run. When neither can be written
 * the agents keep running, the run says the cancel is not saved yet, and the runtime closes them
 * once a later save succeeds (`cancelUnsaved`).
 */
import { cancelRun } from './engine.mjs';

export const CANCEL_MARK_PREFIX = 'toris-neon.cancel.';
export const UNSAVED_CANCEL = '취소를 아직 저장하지 못했습니다. 새 단계는 배정하지 않습니다. 다시 시작돼도 취소가 지켜지도록 저장되기 전에는 에이전트 터미널을 닫지 않으며, 저장되면 자동으로 닫습니다.';
const RESTART_REASON = '재시작 전에 저장을 마치지 못한 사용자 취소를 적용했습니다.';
const FINISHED = new Set(['cancelled', 'completed']);
const LIVE_JOB = new Set(['launching', 'running', 'awaiting-report', 'uncertain']);

/** Cancel marks in `storage`: written when the full save fails, applied at load, cleared after a full save. */
export function createCancelMarks(storage, log = () => {}) {
  const marked = new Set();
  return {
    async write(runId, at) {
      try { await storage.set(CANCEL_MARK_PREFIX + runId, { runId, at }); }
      catch (error) { log('Toris Neon storage: 실행 ' + runId + '의 취소 표시도 저장하지 못했습니다: ' + String(error?.message ?? error)); return false; }
      marked.add(runId);
      return true;
    },
    /** Cancels every loaded run a mark names; returns the ids it changed. */
    async apply(state, now) {
      const keys = ((await storage.keys?.()) ?? []).filter((key) => key.startsWith(CANCEL_MARK_PREFIX));
      const applied = [];
      for (const key of keys) {
        const runId = key.slice(CANCEL_MARK_PREFIX.length);
        marked.add(runId);
        const index = state.runs.findIndex((run) => run.id === runId);
        if (index === -1 || FINISHED.has(state.runs[index].status)) continue;
        const run = cancelRun(state.runs[index], { now, reason: RESTART_REASON });
        // The closes before the restart were never saved: each owned agent still needs checking.
        run.stopFailures = (run.jobs ?? []).filter((job) => job.terminalId && LIVE_JOB.has(job.state))
          .map((job) => ({ terminalId: job.terminalId, code: 'unconfirmed', message: '재시작 전에 취소했지만 이 에이전트 터미널의 종료 결과가 저장되지 않았습니다. 터미널을 확인하세요.' }));
        state.runs[index] = run;
        applied.push(runId);
      }
      return applied;
    },
    /** After a successful full save: a mark whose run is stored cancelled (or no longer live) is done. */
    async clear(state) {
      for (const runId of [...marked]) {
        const run = state.runs.find((item) => item.id === runId);
        if (run && !FINISHED.has(run.status)) continue;
        try { await storage.delete(CANCEL_MARK_PREFIX + runId); marked.delete(runId); }
        catch (error) { log('Toris Neon storage: 취소 표시 ' + runId + '를 지우지 못했습니다(다음 저장 때 다시 시도): ' + String(error?.message ?? error)); }
      }
    },
  };
}

/**
 * Closes a cancelled run's own terminals once the cancel is durable. `save()` is true when the full
 * state was written; `mark()` writes the fallback mark. Mutates `run` like the runtime's handlers.
 */
export async function closeCancelled(run, { save, mark, close, appendEvent, activeJobs, describeError }) {
  run.stopFailures = [];
  if (!(await save()) && !(await mark(run.id))) {
    if (!run.cancelUnsaved) appendEvent(run, UNSAVED_CANCEL); // once per episode, not on every retry
    run.cancelUnsaved = true;
    run.stopFailures.push({ terminalId: null, code: 'unsaved', message: UNSAVED_CANCEL });
    return run;
  }
  delete run.cancelUnsaved;
  for (const job of activeJobs(run).filter((item) => item.terminalId)) {
    try {
      const closed = await close(job.terminalId);
      if (closed?.closed !== true) throw Object.assign(new Error('소유한 에이전트 터미널의 종료를 확인하지 못했습니다.'), { code: 'action_failed' });
      job.state = 'cancelled';
    } catch (error) {
      run.stopFailures.push({ terminalId: job.terminalId, ...describeError(error) });
    }
  }
  for (const job of run.jobs || []) {
    if (!job.terminalId && job.state === 'uncertain') run.stopFailures.push({ terminalId: null, code: 'uncertain', message: '응답이 없는 실행 요청이 있습니다. Orca에서 해당 실행을 확인하세요.' });
  }
  appendEvent(run, run.stopFailures.length ? '취소됐지만 일부 터미널 종료 여부를 확인해야 합니다.' : '실행을 취소하고 소유한 활성 터미널을 종료했습니다.');
  await save();
  return run;
}
