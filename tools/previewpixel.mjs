/**
 * Synthetic runs for the pixel workshop preview (docs/design/pixel-ui/SPEC.md): one per state that
 * needs a live look. Times are relative to liveAt so the preview shows fresh and stale signals.
 * Sample names only; no real app, account or path.
 */
import { createRun, claimNode, templateGraph } from '../src/engine.mjs';

const iso = (ms) => new Date(ms).toISOString();
const CODE_MODE_MESSAGE = 'claude가 시작 화면의 "Code Mode (experimental)" 안내에서 멈춰 작업 지시를 받지 않았습니다. Claude 설정(CLAUDE_CODE_EXPERIMENTAL_CODE_MODE=1)이 띄운 안내라 Neon 밖의 조건입니다. 해결: Claude 설정의 CLAUDE_CODE_EXPERIMENTAL_CODE_MODE를 끄거나, Claude Code를 직접 열어 안내를 확인하세요. (미리보기 자료)';

function base(id, goal, project, { now, template = 'new-app', kind, passed = [], updatedAt, nodes: graph }) {
  const nodes = graph ?? (template === 'new-app' ? undefined : templateGraph(template, { kind }));
  const run = createRun({ id, goal, projectId: project, now: now - 3_600_000, ...(nodes ? { nodes } : {}) });
  Object.assign(run, { started: true, status: 'running', workspaceId: 'preview-workspace-' + id, workspacePath: '/example/' + id, autonomous: true, jobs: [], updatedAt: iso(updatedAt) });
  if (template !== 'new-app') Object.assign(run, { template, improvement: { kind, options: {}, projectName: id, playLink: null } });
  for (const node of run.nodes) { node.agent = 'codex'; node.reviewer = 'claude'; }
  for (const done of passed) Object.assign(run.nodes.find((node) => node.id === done), { status: 'passed', attempts: 1, reviewAttempts: 1, completedAt: iso(now - 1_800_000) });
  return run;
}
// A turn proven by the agent in its own session after the prompt was sent.
function working(run, nodeId, { now, startedAgo, lastAgo, phase = 'work', agent = 'codex' }) {
  const nonce = run.id + '-' + nodeId + '-' + phase;
  if (phase === 'review') Object.assign(run.nodes.find((node) => node.id === nodeId), { status: 'review', attempts: 1, report: { outcome: 'passed', summary: '미리보기 자료', evidence: [] } }); // the work report was accepted
  const next = claimNode(run, nodeId, { phase, nonce, now: now - startedAgo });
  next.jobs.push({ runId: run.id, nodeId, nonce, phase, attempt: 1, agent, state: 'running', selfDelivery: true, terminalId: 'preview-t-' + nonce,
    startedAt: iso(now - startedAgo), promptRecovery: { state: 'sent', at: iso(now - startedAgo + 6000) }, promptSeen: true,
    sessionId: 'preview-session-' + nonce, agentState: 'working', lastAgentEventAt: now - lastAgo });
  return next;
}

export function pixelSamples(now) {
  // 시작 지연 · 재시도 2/3: the design agent never reported ready twice; the third start is being checked.
  let stuck = base('preview-moonlog', '달빛 일기 · 새 앱', 'preview-project', { now, passed: ['research', 'brief'], updatedAt: now });
  stuck = working(stuck, 'architecture', { now, startedAgo: 140_000, lastAgo: 12_000 });
  stuck = claimNode(stuck, 'design', { phase: 'work', nonce: 'preview-moonlog-design-3', now: now - 78_000 });
  stuck.nodes.find((node) => node.id === 'design').deliveryRetries = 2;
  stuck.jobs.push({ runId: stuck.id, nodeId: 'design', nonce: 'preview-moonlog-design-3', phase: 'work', attempt: 1, agent: 'codex', state: 'running',
    selfDelivery: true, terminalId: 'preview-t-design-3', startedAt: iso(now - 78_000), readyAt: iso(now - 18_000) });

  // Two agents in parallel, both with a confirmed work signal.
  let parallel = base('preview-starmap', '별자리 지도 · 새 앱', 'preview-project-2', { now, passed: ['research', 'brief'], updatedAt: now - 1000 });
  parallel = working(parallel, 'architecture', { now, startedAgo: 24_000, lastAgo: 8000 });
  parallel = working(parallel, 'design', { now, startedAgo: 20_000, lastAgo: 9000, agent: 'claude' });

  // Quiet for 4 minutes: the build agent is still working by its last record, but has sent nothing since.
  let quiet = base('preview-onepage', '한 장 노트 · 새 앱', 'preview-project-9', { now, passed: ['research', 'brief', 'architecture', 'design', 'assets'], updatedAt: now - 2000 });
  quiet = working(quiet, 'build', { now, startedAgo: 900_000, lastAgo: 250_000 });

  // Blocked by a start dialog: the identity stage of an update stopped on Claude's Code Mode notice.
  let dialog = base('preview-greenlog', '초록 기록 · 알림 오류 고치기', 'preview-project-5', { now, template: 'improve', kind: 'bugfix', updatedAt: now - 3000 });
  dialog = claimNode(dialog, 'identity', { phase: 'work', nonce: 'preview-greenlog-identity', now: now - 95_000 });
  dialog.status = 'blocked';
  const identity = dialog.nodes.find((node) => node.id === 'identity');
  Object.assign(identity, { status: 'blocked', agent: 'claude', pendingReceipt: { ...identity.active }, active: null, runtimeMessage: CODE_MODE_MESSAGE, attempts: 0 });
  dialog.jobs.push({ runId: dialog.id, nodeId: 'identity', nonce: 'preview-greenlog-identity', phase: 'work', attempt: 1, agent: 'claude', state: 'awaiting-report',
    selfDelivery: true, terminalId: 'preview-t-identity', startedAt: iso(now - 95_000), blocker: { kind: 'start-dialog', agent: 'claude', dialog: 'code-mode' },
    refunded: { at: iso(now - 90_000), reason: '에이전트 화면(start-dialog)에서 멈춰 작업을 시작하지 않았습니다.' } });

  // A person's approval before release submission.
  const approval = base('preview-ripple', '물결 메모 · 출시 준비', 'preview-project-3', { now, passed: ['research', 'brief', 'architecture', 'design', 'assets', 'build', 'test', 'policy', 'listing', 'internal'], updatedAt: now - 4000 });
  approval.status = 'blocked';
  approval.nodes.find((node) => node.id === 'release').status = 'awaiting-approval';
  // A goal written as one long sentence (150 characters): titles clamp, the pass count stays on one line.
  const longGoal = '하루 일정과 습관을 한 화면에서 기록하고 주간 통계를 보여 주며 알림 시간과 위젯을 사용자가 직접 고를 수 있는 생산성 앱의 첫 버전을 만들고 안드로이드 실기기에서 저장과 복원까지 확인해 주세요 그리고 다크 모드와 큰 글씨 설정, 접근성 대비도 함께 꼭 지원해야 합니다';
  let long = base('preview-longgoal', longGoal, 'preview-project-4', { now, template: 'improve', kind: 'bugfix', updatedAt: now - 500, passed: ['identity', 'reproduce', 'build', 'test'].slice(0, 3) });
  long = working(long, 'test', { now, startedAgo: 60_000, lastAgo: 5000 });
  return [...flowSamples(now), stuck, parallel, quiet, dialog, approval, long];
}

/**
 * The RESPONSIVE.md supply-line samples: brief feeds three parallel stages (two proven working, one stopped on a
 * start screen) that all join at build; a review about to pass (preview.pass turns it into one handoff); and a
 * slot wait. Sample names only.
 */
export function flowSamples(now) {
  const nodes = templateGraph('new-app').flatMap((node) => node.id === 'design'
    ? [node, { ...node, id: 'notify', title: '알림 설계', deps: ['brief'] }]
    : [node.id === 'build' ? { ...node, deps: [...node.deps, 'notify'] } : node]);
  let fork = base('preview-starbook', '별가람 일지 · 새 앱', 'preview-project-6', { now, nodes, passed: ['research', 'brief'], updatedAt: now + 1000 });
  fork.maxConcurrency = 3;
  fork = working(fork, 'architecture', { now, startedAgo: 140_000, lastAgo: 12_000 });
  fork = working(fork, 'design', { now, startedAgo: 120_000, lastAgo: 9000, phase: 'review', agent: 'claude' });
  fork = claimNode(fork, 'notify', { phase: 'work', nonce: 'preview-starbook-notify', now: now - 78_000 });
  Object.assign(fork.nodes.find((node) => node.id === 'notify'), { agent: 'claude' });
  fork.jobs.push({ runId: fork.id, nodeId: 'notify', nonce: 'preview-starbook-notify', phase: 'work', attempt: 1, agent: 'claude', state: 'running', selfDelivery: true,
    terminalId: 'preview-t-notify', startedAt: iso(now - 78_000), blocker: { kind: 'start-dialog', agent: 'claude', dialog: 'code-mode' } });

  // 제품 기획 is in review now; preview.pass hands it to the next stage once, as a real pass would.
  let pass = base('preview-cloudstep', '구름 스텝 · 운동 기록', 'preview-project-7', { now, passed: ['research'], updatedAt: now + 900 });
  pass = working(pass, 'brief', { now, startedAgo: 90_000, lastAgo: 4000, phase: 'review', agent: 'claude' });

  // Every run-level slot is taken: the next stage waits for one.
  let slot = base('preview-smallseed', '작은 씨앗 · 물주기 알림', 'preview-project-8', { now, passed: ['research', 'brief'], updatedAt: now + 800 });
  slot.maxConcurrency = 1;
  slot = working(slot, 'architecture', { now, startedAgo: 60_000, lastAgo: 7000 });
  return [fork, pass, slot];
}
