/**
 * Pure view model shared by the Auto App flow and the 에이전트 tab. Both tabs derive every
 * stage and agent state from the same run/job data here, so they cannot disagree.
 */
// Mirrors src/ecc.mjs (the panel cannot import worker files); tests/teams.test.mjs keeps them equal.
// What the previous release wrote into every new stage; such values mean "automatic".
export const LEGACY_ECC_DEFAULTS = {
  research: 'ecc:marketing-agent', brief: 'ecc:planner', architecture: 'ecc:architect',
  design: 'ecc:a11y-architect', assets: null, build: 'ecc:tdd-guide', test: 'ecc:e2e-runner',
  policy: 'ecc:security-reviewer', listing: 'ecc:seo-specialist', internal: 'ecc:build-error-resolver',
  release: 'ecc:code-reviewer',
};
export const TEAMS = [
  { id: 'plan', name: '기획팀', mark: '◇', stages: ['research', 'brief'], craft: '문제와 첫 버전의 범위를 정합니다' },
  { id: 'arch', name: '설계팀', mark: '△', stages: ['architecture'], craft: '구조와 데이터 흐름을 나눕니다' },
  { id: 'design', name: '디자인팀', mark: '○', stages: ['design', 'assets'], craft: '화면과 에셋을 만듭니다' },
  { id: 'build', name: '구현팀', mark: '□', stages: ['build'], craft: '설계를 작동하는 앱으로 만듭니다' },
  { id: 'qa', name: '검증팀', mark: '◎', stages: ['test'], craft: '실제로 돌려 보고 결함을 돌려보냅니다' },
  { id: 'ship', name: '출시팀', mark: '▷', stages: ['policy', 'listing', 'internal', 'release'], craft: '정책·스토어·제출을 준비합니다' },
];
const OTHER_TEAM = { id: 'other', name: '추가 단계', mark: '·', stages: [], craft: '사용자 정의 단계' };
export const STATE_LABELS = {
  waiting: '대기', queued: '검토 대기', working: '작업 중', reviewing: '검토 중',
  passed: '통과', attention: '확인 필요', approval: '승인 대기',
};
export const STATE_GLYPHS = { waiting: '○', queued: '◐', working: '●', reviewing: '◉', passed: '✓', attention: '!', approval: '?' };
export const LIVE_LABELS = {
  working: '작업 중', reviewing: '검토 중', handed: '검토로 넘김', waiting: '대기',
  undelivered: '지시 전달 전', attention: '확인 필요', done: '완료',
};

export const teamOf = (nodeId) => TEAMS.find((team) => team.stages.includes(nodeId)) ?? OTHER_TEAM;
/** The user's ECC choice for a stage: a pinned `ecc:` agent, 'none', or null for automatic. */
export function eccOverride(node) {
  const value = node?.eccAgent;
  if (value === undefined || value === null || value === '') return null;
  if (value === 'none') return 'none';
  if (Object.hasOwn(LEGACY_ECC_DEFAULTS, node.id) && LEGACY_ECC_DEFAULTS[node.id] === value) return null;
  return /^ecc:[a-z][a-z0-9-]{1,63}$/.test(value) ? value : null;
}
/** The ECC agent a role leads with: the pin, else the first of the shortlist chosen for that phase. */
function leadEcc(node, phase) {
  const override = eccOverride(node);
  if (override === 'none') return null;
  if (override) return override;
  return node.eccShortlist?.phase === phase ? node.eccShortlist.agents?.[0]?.name ?? null : null;
}

export function currentJob(run, node) {
  const nonce = node.active?.nonce ?? node.pendingReceipt?.nonce;
  return nonce ? (run.jobs ?? []).find((job) => job.nonce === nonce) ?? null : null;
}

export function stageState(node) {
  if (node.active) return node.active.phase === 'review' ? 'reviewing' : 'working';
  if (node.status === 'passed') return 'passed';
  if (['blocked', 'failed'].includes(node.status)) return 'attention';
  if (node.status === 'awaiting-approval') return 'approval';
  if (node.status === 'review') return 'queued';
  return 'waiting';
}

function stageMessage(run, node) {
  if (node.runtimeMessage) return node.runtimeMessage;
  if (node.failureReason) return node.failureReason;
  if (node.feedback?.summary && node.status !== 'passed') return '수정 요청 · ' + node.feedback.summary;
  return [...(run.events ?? [])].reverse().find((event) => event.nodeId === node.id)?.summary ?? '';
}

/** Everything either tab shows about one stage. */
export function stageView(run, node) {
  const state = stageState(node);
  const job = currentJob(run, node);
  const phase = node.active?.phase ?? node.pendingReceipt?.phase ?? (['queued', 'reviewing'].includes(state) ? 'review' : 'work');
  const agent = phase === 'review' ? node.reviewer : node.agent;
  const eccAgent = leadEcc(node, phase);
  return {
    id: node.id, team: teamOf(node.id), state, label: STATE_LABELS[state], glyph: STATE_GLYPHS[state],
    phase, attempt: phase === 'review' ? node.reviewAttempts ?? 0 : node.attempts ?? 0,
    agent, worker: node.agent, reviewer: node.reviewer,
    eccAgent, eccApplies: Boolean(eccAgent) && agent === 'claude', eccOverride: eccOverride(node), eccShortlist: node.eccShortlist ?? null,
    startedAt: node.active?.startedAt ?? null, budgetMinutes: job?.budgetMinutes ?? null, message: stageMessage(run, node),
    terminalId: node.active?.terminalId ?? node.pendingReceipt?.terminalId ?? null,
    // Launched but not typed into yet (the plugin types once the agent reports in).
    undelivered: Boolean(node.active && job && (job.selfDelivery ? !job.promptRecovery : !job.promptSeen && job.agentState === 'done')),
    deps: node.deps ?? [], repair: Boolean(node.feedback && node.status !== 'passed'),
  };
}

export function relations(run, nodeId) {
  const node = run.nodes.find((item) => item.id === nodeId);
  return {
    upstream: run.nodes.filter((item) => node?.deps?.includes(item.id)),
    downstream: run.nodes.filter((item) => item.deps?.includes(nodeId)),
  };
}

export function teamLanes(run) {
  const known = TEAMS.map((team) => ({ team, nodes: run.nodes.filter((node) => teamOf(node.id) === team) }));
  const extra = run.nodes.filter((node) => teamOf(node.id) === OTHER_TEAM);
  return [...known, ...(extra.length ? [{ team: OTHER_TEAM, nodes: extra }] : [])].filter((lane) => lane.nodes.length);
}

/** Teams that receive this lane's output, for the handoff line between lanes. */
export function handsOffTo(run, lane) {
  const ids = new Set(lane.nodes.map((node) => node.id));
  const teams = new Map();
  for (const node of run.nodes) {
    if (!ids.has(node.id) && node.deps?.some((dep) => ids.has(dep))) teams.set(teamOf(node.id).id, teamOf(node.id));
  }
  return [...teams.values()];
}

/** Who is working right now, and whether QA has sent work back. An idle run returns nothing live. */
export function collaboration(run) {
  const live = run.nodes.filter((node) => node.active).map((node) => stageView(run, node));
  const repairing = run.nodes.find((node) => node.id === 'build' && node.feedback && node.status !== 'passed');
  return { live, loops: run.repairLoops ?? 0, maxLoops: run.maxRepairLoops ?? 0, repairing: repairing ? repairing.id : null };
}

function memberState(view, role) {
  if (view.undelivered && role === view.phase) return 'undelivered';
  if (view.state === 'passed') return 'done';
  if (role === 'work') {
    if (view.state === 'working') return 'working';
    if (['queued', 'reviewing'].includes(view.state)) return 'handed';
  } else if (view.state === 'reviewing') return 'reviewing';
  if (view.state === 'attention' && view.phase === role) return 'attention';
  return 'waiting';
}

/** The people view: each stage's worker and reviewer, grouped by team, with live state. */
export function agentRoster(run) {
  return teamLanes(run).map(({ team, nodes }) => ({
    team,
    members: nodes.flatMap((node) => {
      const view = stageView(run, node);
      return [
        { key: node.id + ':work', role: 'work', agent: node.agent, eccAgent: leadEcc(node, 'work'), eccApplies: Boolean(leadEcc(node, 'work')) && node.agent === 'claude', view, live: memberState(view, 'work') },
        { key: node.id + ':review', role: 'review', agent: node.reviewer, eccAgent: leadEcc(node, 'review'), eccApplies: Boolean(leadEcc(node, 'review')) && node.reviewer === 'claude', view, live: memberState(view, 'review') },
      ];
    }),
  }));
}

export const snapshotStates = (run) => new Map(run.nodes.map((node) => [node.id, {
  state: stageState(node), repair: Boolean(node.feedback), feedbackNonce: node.feedback?.nonce ?? null,
}]));

/** What actually happened between two pushed states; drives one-shot motion only. */
export function transitions(previous, run) {
  const changes = new Map();
  if (!previous) return changes;
  for (const node of run.nodes) {
    const before = previous.get(node.id);
    const after = stageState(node);
    if (!before) continue;
    const newFeedback = Boolean(node.feedback && (!before.repair || (node.feedback.nonce && node.feedback.nonce !== before.feedbackNonce)));
    if (before.state === after && !newFeedback) continue;
    if (after === 'passed') changes.set(node.id, 'verdict');
    else if (after === 'attention' || newFeedback) changes.set(node.id, 'retry');
    else if (before.state === 'working' && ['queued', 'reviewing'].includes(after)) changes.set(node.id, 'handoff');
    else if (['working', 'reviewing'].includes(after)) changes.set(node.id, 'start');
  }
  return changes;
}

export function elapsed(fromIso, nowMs) {
  const started = Date.parse(fromIso ?? '');
  if (!Number.isFinite(started)) return '';
  const seconds = Math.max(0, Math.floor((nowMs - started) / 1000));
  if (seconds < 60) return seconds + '초';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + '분 ' + (seconds % 60) + '초';
  return Math.floor(minutes / 60) + '시간 ' + (minutes % 60) + '분';
}
