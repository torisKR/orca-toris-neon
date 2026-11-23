/**
 * Which stage Neon assigns next, across every run: at most GLOBAL_LIMITS.activeJobs assignments in
 * total and GLOBAL_LIMITS.heavyJobs heavy ones (builds, tests, device work), on top of each run's own
 * maxConcurrency; runs take turns. Also the true reason a ready stage is waiting. This bounds only
 * what Neon assigns, not other agents the person runs.
 */
import { nextActions } from './engine.mjs';

/** Defaults; the person can change them in the plugin settings (maxActiveJobs, maxHeavyJobs). */
export const GLOBAL_LIMITS = Object.freeze({ activeJobs: 2, heavyJobs: 1 });
const MAX_LIMIT = 8;
const settingLimit = async (settings, key, fallback) => {
  let value;
  try { value = await settings?.get?.(key); } catch { return fallback; } // unreadable settings keep the safe default
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 && number <= MAX_LIMIT ? number : fallback;
};
/** The limits in force: the settings when valid, else the defaults; heavy never above active. */
export async function readLimits(settings) {
  const activeJobs = await settingLimit(settings, 'maxActiveJobs', GLOBAL_LIMITS.activeJobs);
  const heavyJobs = Math.min(activeJobs, await settingLimit(settings, 'maxHeavyJobs', GLOBAL_LIMITS.heavyJobs));
  return { activeJobs, heavyJobs };
}
/** Stages that build the app or drive a device or emulator. */
export const HEAVY_STAGES = new Set(['build', 'test', 'internal', 'monetization', 'reproduce', 'measure']);
export const isHeavy = (nodeId) => HEAVY_STAGES.has(nodeId);
const LIVE_JOB_STATES = new Set(['launching', 'running', 'awaiting-report', 'uncertain']);
export const reservesSlot = (job) => LIVE_JOB_STATES.has(job.state);

export function globalCounts(runs) {
  const assignments = runs.flatMap((run) => {
    const reserved = new Map((run.jobs ?? []).filter(reservesSlot).map((job) => [job.nonce, job.nodeId]));
    for (const node of run.nodes) if (node.active) reserved.set(node.active.nonce, node.id);
    return [...reserved.values()];
  });
  return { active: assignments.length, heavy: assignments.filter(isHeavy).length };
}

const blocked = (run) => run.nodes.some((node) => ['blocked', 'failed'].includes(node.status)) ||
  (run.jobs ?? []).some((job) => ['uncertain', 'awaiting-report'].includes(job.state));
const sharedBusy = (run, runs) => runs.some((other) => other.id !== run.id && other.workspaceId === run.workspaceId &&
  (other.jobs ?? []).some(reservesSlot));
const runnable = (run, runs) => run.started && ['ready', 'running'].includes(run.status) && run.workspaceId && run.workspacePath &&
  !blocked(run) && !sharedBusy(run, runs);

/** The run's own next assignments, after its writer rules: one writer, reviews never beside a writer at work. */
export function launchCandidates(run, runs) {
  if (!runnable(run, runs)) return [];
  const active = run.nodes.filter((node) => node.active);
  const writerAtWork = active.some((item) => item.write && item.active.phase === 'work');
  return nextActions(run).filter((candidate) => {
    const node = run.nodes.find((item) => item.id === candidate.nodeId);
    if (candidate.phase === 'review') return !writerAtWork;
    if (node.write) return !active.some((item) => item.write || item.active.phase === 'review');
    return !writerAtWork;
  });
}

const admits = (nodeId, counts, limits) => counts.active < limits.activeJobs && (!isHeavy(nodeId) || counts.heavy < limits.heavyJobs);

/** The next assignment, starting from the run at `cursor` (round robin); null when nothing may start. */
export function nextLaunch(runs, { cursor = 0, limits = GLOBAL_LIMITS } = {}) {
  const counts = globalCounts(runs);
  if (counts.active >= limits.activeJobs || !runs.length) return null;
  for (let step = 0; step < runs.length; step++) {
    const index = (cursor + step) % runs.length;
    const action = launchCandidates(runs[index], runs).find((item) => admits(item.nodeId, counts, limits));
    if (action) return { runId: runs[index].id, action, cursor: index + 1 };
  }
  return null;
}

const depsPassed = (run, node) => node.deps.every((id) => run.nodes.find((item) => item.id === id)?.status === 'passed');

/** Why each ready-but-unassigned stage of `run` waits, as the person reads it. */
export function waitReasons(run, runs, limits = GLOBAL_LIMITS) {
  const counts = globalCounts(runs);
  const planned = new Set(nextActions(run).map((item) => item.nodeId));
  const candidates = new Set(launchCandidates(run, runs).map((item) => item.nodeId));
  const reasons = {};
  for (const node of run.nodes) {
    if (node.active || !['pending', 'review', 'awaiting-approval'].includes(node.status)) continue;
    if (node.status === 'awaiting-approval') { reasons[node.id] = '승인 대기'; continue; }
    if (!depsPassed(run, node)) { reasons[node.id] = '선행 단계 대기'; continue; }
    if (run.status === 'paused') { reasons[node.id] = '일시 정지'; continue; }
    if (!run.started) { reasons[node.id] = '시작 전'; continue; }
    if (!planned.has(node.id)) {
      reasons[node.id] = run.nodes.filter((item) => item.active).length >= run.maxConcurrency ? '실행별 한도' : '쓰기 작업 완료 대기';
    } else if (!candidates.has(node.id)) reasons[node.id] = blocked(run) ? '확인이 필요한 단계 처리 대기' : '쓰기 작업 완료 대기';
    else if (counts.active >= limits.activeJobs) reasons[node.id] = '전체 작업 ' + limits.activeJobs + '개 실행 중';
    else if (isHeavy(node.id) && counts.heavy >= limits.heavyJobs) reasons[node.id] = '빌드 작업 완료 대기';
    else reasons[node.id] = '배정 순서 대기';
  }
  return reasons;
}
