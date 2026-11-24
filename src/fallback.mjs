/**
 * Moving a run off an agent that cannot work (a screen only a person can clear, src/agentscreen.mjs)
 * is visible, not silent. Each moved stage remembers its original agent or reviewer; a design or
 * assets stage moved off Codex (the agent with the image tools) records the fallback so the result
 * card can offer to redo it. When the agent works again (a job on it started work after it was
 * avoided, in any run), stages not yet started go back to their original assignment. These
 * functions change the supervisor's working copy of the run, like the runtime's own handlers.
 */
import { VISUAL_STAGES } from './visual.mjs';

export const IMAGE_AGENT = 'codex';
const WORK_NOT_STARTED = new Set(['pending', 'awaiting-approval']);
const REVIEW_NOT_STARTED = new Set(['pending', 'awaiting-approval', 'review']);
const MAX_FALLBACKS = 20;
const record = (run, entry) => { run.fallbacks = [...(run.fallbacks ?? []), entry].slice(-MAX_FALLBACKS); };

/** Every stage not running or passed stops using `agent`; returns what moved ('build 검토' for a reviewer). */
export function moveAway(run, agent, replacement, { at, reason = '' }) {
  const moved = [];
  for (const node of run.nodes) {
    if (node.active || ['passed', 'skipped'].includes(node.status)) continue;
    for (const key of ['agent', 'reviewer']) {
      if (node[key] !== agent || (key === 'agent' && node.status === 'review')) continue; // finished work waiting for review keeps its maker
      node.original = { ...node.original, [key]: node.original?.[key] ?? agent };
      node[key] = replacement;
      moved.push(node.id + (key === 'reviewer' ? ' 검토' : ''));
      if (key === 'agent' && agent === IMAGE_AGENT && VISUAL_STAGES.includes(node.id)) node.fallback = { from: agent, to: replacement, at, reason: reason.slice(0, 600) };
    }
  }
  run.avoided = { ...run.avoided, [agent]: { at, to: replacement } };
  record(run, { agent, to: replacement, at, reason: reason.slice(0, 600), stages: moved });
  return moved;
}

const notStarted = (node, key) => !node.active && !node.pendingReceipt && (key === 'agent' ? WORK_NOT_STARTED : REVIEW_NOT_STARTED).has(node.status);

/** Stages not yet started go back to `agent`; returns what moved back. */
export function restoreAgent(run, agent, { at, why = '' }) {
  const restored = [];
  for (const node of run.nodes) {
    for (const key of ['agent', 'reviewer']) {
      if (node.original?.[key] !== agent || !notStarted(node, key)) continue;
      node[key] = agent;
      const { [key]: _gone, ...rest } = node.original;
      if (Object.keys(rest).length) node.original = rest; else delete node.original;
      if (key === 'agent') delete node.fallback;
      restored.push(node.id + (key === 'reviewer' ? ' 검토' : ''));
    }
  }
  const { [agent]: _done, ...still } = run.avoided ?? {};
  if (Object.keys(still).length) run.avoided = still; else delete run.avoided;
  record(run, { agent, at, restored: true, reason: why.slice(0, 300), stages: restored });
  return restored;
}

/** A job on `agent` started work after the run avoided it. */
export function usableAgain(run, agent, jobs) {
  const since = run.avoided?.[agent]?.at;
  return Boolean(since) && jobs.some((job) => job.agent === agent && job.promptSeen && job.startedAt > since);
}

/** Design or assets stages that passed on the fallback agent: the result card offers to redo them. */
export const visualFallbacks = (run) => run.nodes.filter((node) => node.fallback && node.status === 'passed');
