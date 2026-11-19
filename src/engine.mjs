/**
 * TORIS NEON workflow state machine.
 * Every exported transition returns a new JSON-serializable run. No function starts
 * processes, reads files, or treats an agent's "done" status as verification.
 */
export const RUN_VERSION = 1;
export const DEFAULT_TIME_ZONE = 'Asia/Seoul';
export const DEFAULT_GRAPH = [
  { id: 'research', title: '시장·앱 조사', deps: [], write: false },
  { id: 'brief', title: '제품 기획', deps: ['research'], write: false },
  { id: 'architecture', title: '구조 설계', deps: ['brief'], write: false },
  { id: 'design', title: '화면·상호작용 설계', deps: ['brief'], write: false },
  { id: 'assets', title: '앱 에셋', deps: ['design'], write: true },
  { id: 'build', title: '앱 구현', deps: ['architecture', 'assets'], write: true },
  { id: 'test', title: '테스트·수정 루프', deps: ['build'], write: false },
  { id: 'policy', title: 'Play 정책·권한 점검', deps: ['test'], write: false },
  { id: 'listing', title: '스토어 자료 준비', deps: ['test', 'policy'], write: false },
  { id: 'internal', title: '내부 테스트 제출', deps: ['listing'], write: true, requiresApproval: true },
  { id: 'release', title: '출시 제출', deps: ['internal'], write: true, requiresApproval: true },
];

const STOPPED = new Set(['paused', 'cancelled', 'completed']);
const OUTCOMES = new Set(['passed', 'failed', 'blocked']);
const PHASES = new Set(['work', 'review']);
const copy = value => structuredClone(value);

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function instant(now) {
  const value = now === undefined ? new Date() : new Date(now);
  if (!Number.isFinite(value.valueOf())) fail('invalid_date', '유효한 날짜가 필요합니다.');
  return value.toISOString();
}

function requiredText(value, label, max = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    fail('invalid_input', label + ' 값을 확인하세요.');
  }
  return value.trim();
}

function bounded(value, fallback, min, max, label) {
  const number = value ?? fallback;
  if (!Number.isInteger(number) || number < min || number > max) {
    fail('invalid_input', label + ': ' + min + '–' + max + ' 범위의 정수가 필요합니다.');
  }
  return number;
}

function nodeIn(run, nodeId) {
  const node = run.nodes.find(item => item.id === nodeId);
  if (!node) fail('unknown_node', '알 수 없는 단계: ' + nodeId);
  return node;
}

function event(run, type, summary, at, nodeId, extra = {}) {
  run.events.push({
    id: run.id + ':' + (run.eventSequence = (run.eventSequence ?? 0) + 1),
    at, type, summary, ...(nodeId ? { nodeId } : {}), ...extra,
  });
  run.updatedAt = at;
}

function dependenciesPassed(run, node) {
  return node.deps.every(id => nodeIn(run, id).status === 'passed');
}

function descendants(run, nodeId) {
  const found = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of run.nodes) {
      if (!found.has(node.id) && node.deps.some(id => id === nodeId || found.has(id))) {
        found.add(node.id);
        changed = true;
      }
    }
  }
  return found;
}

function resetNode(node) {
  node.status = 'pending';
  node.active = null;
  node.report = null;
  node.review = null;
  node.approval = null;
  node.failureReason = null;
  node.completedAt = null;
}

function invalidate(run, nodeId, includeSelf = false) {
  const ids = descendants(run, nodeId);
  if (includeSelf) ids.add(nodeId);
  if (run.nodes.some(node => ids.has(node.id) && node.active)) {
    fail('active_dependants', '연결된 실행 중 작업을 먼저 중지해야 합니다.');
  }
  for (const node of run.nodes) if (ids.has(node.id)) resetNode(node);
}

function settle(run) {
  for (const node of run.nodes) {
    if (node.status === 'pending' && dependenciesPassed(run, node)) {
      if (node.attempts >= run.maxAttempts) {
        node.status = 'failed';
        node.failureReason = '이 단계의 실행 횟수 한도에 도달했습니다.';
      } else if (node.requiresApproval && !node.approval) {
        node.status = 'awaiting-approval';
      }
    }
  }
  if (run.status === 'paused' || run.status === 'cancelled') return run;
  if (run.nodes.every(node => node.status === 'passed')) run.status = 'completed';
  else if (run.nodes.some(node => node.active)) run.status = 'running';
  else if (run.nodes.some(node => node.status === 'failed' || node.status === 'blocked')) run.status = 'blocked';
  else run.status = 'ready';
  return run;
}

/** Returns a topological node id ordering, throwing for duplicate/unknown/cyclic edges. */
export function validateGraph(nodes) {
  if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 64) {
    fail('invalid_graph', '그래프에는 1–64개 단계가 필요합니다.');
  }
  const byId = new Map();
  for (const node of nodes) {
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(node.id)) {
      fail('invalid_graph', '단계 ID는 영문 소문자, 숫자, 하이픈을 사용하세요.');
    }
    if (byId.has(node.id)) fail('duplicate_node', '중복 단계: ' + node.id);
    if (!Array.isArray(node.deps) || new Set(node.deps).size !== node.deps.length) {
      fail('invalid_graph', '각 단계의 deps는 중복 없는 배열이어야 합니다.');
    }
    byId.set(node.id, node);
  }
  for (const node of nodes) for (const dep of node.deps) {
    if (!byId.has(dep)) fail('unknown_dependency', node.id + '의 선행 단계가 없습니다: ' + dep);
  }
  const visiting = new Set();
  const visited = new Set();
  const ordered = [];
  const visit = id => {
    if (visiting.has(id)) fail('cyclic_graph', '의존성 그래프에 순환이 있습니다: ' + id);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id).deps) visit(dep);
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  };
  nodes.forEach(node => visit(node.id));
  return ordered;
}

/**
 * options.assignments is { [nodeId]: { agent, reviewer } }.
 * An omitted reviewer uses the configured default, in a fresh independent session.
 */
export function createRun(options = {}) {
  const at = instant(options.now);
  const graph = copy(options.nodes ?? DEFAULT_GRAPH);
  validateGraph(graph);
  const agent = requiredText(options.agent ?? 'codex', '기본 에이전트', 80);
  const reviewer = requiredText(options.reviewer ?? 'codex', '검토 에이전트', 80);
  const run = {
    version: RUN_VERSION,
    id: requiredText(options.id, '실행 ID', 160),
    goal: requiredText(options.goal, '앱 목표', 16000),
    projectId: options.projectId ?? null,
    workspaceId: options.workspaceId ?? null,
    workspacePath: options.workspacePath ?? null,
    createdAt: at,
    updatedAt: at,
    status: 'ready',
    maxConcurrency: bounded(options.maxConcurrency, 2, 1, 6, '동시 실행 수'),
    maxAttempts: bounded(options.maxAttempts, 3, 1, 10, '단계별 실행 한도'),
    maxRepairLoops: bounded(options.maxRepairLoops, 3, 0, 6, 'QA 수정 루프 한도'),
    repairLoops: 0,
    nodes: graph.map(spec => {
      const assignment = options.assignments?.[spec.id] ?? {};
      return {
        id: spec.id,
        title: requiredText(spec.title ?? spec.id, '단계 이름', 160),
        deps: [...spec.deps],
        role: spec.role ?? spec.id,
        agent: requiredText(assignment.agent ?? spec.agent ?? agent, '담당 에이전트', 80),
        reviewer: requiredText(assignment.reviewer ?? spec.reviewer ?? reviewer, '검토 에이전트', 80),
        write: Boolean(spec.write),
        requiresApproval: Boolean(spec.requiresApproval) || spec.id === 'internal' || spec.id === 'release',
        status: 'pending',
        attempts: 0,
        reviewAttempts: 0,
        active: null,
        report: null,
        review: null,
        approval: null,
        failureReason: null,
        completedAt: null,
        history: [],
      };
    }),
    acceptedReports: [],
    eventSequence: 0,
    events: [],
  };
  event(run, 'run.created', '앱 제작 그래프를 준비했습니다.', at);
  return settle(run);
}

/** Ready dispatches, ordered with reviews first. Includes reserved but unlaunched slots. */
export function nextActions(run) {
  if (STOPPED.has(run.status)) return [];
  const active = run.nodes.filter(node => node.active);
  let slots = Math.max(0, run.maxConcurrency - active.length);
  let writerBusy = active.some(node => node.active.phase === 'work' && node.write);
  const result = [];
  const candidates = [
    ...run.nodes.filter(node => node.status === 'review' && !node.active && node.report?.outcome === 'passed'),
    ...run.nodes.filter(node => node.status === 'pending' && !node.active),
  ];
  for (const node of candidates) {
    if (slots === 0) break;
    if (!dependenciesPassed(run, node)) continue;
    if (node.requiresApproval && !node.approval) continue;
    const phase = node.status === 'review' ? 'review' : 'work';
    if (phase === 'work' && node.attempts >= run.maxAttempts) continue;
    if (phase === 'review' && node.reviewAttempts >= run.maxAttempts) continue;
    if (phase === 'work' && node.write && writerBusy) continue;
    result.push({ nodeId: node.id, phase, agent: phase === 'review' ? node.reviewer : node.agent });
    if (phase === 'work' && node.write) writerBusy = true;
    slots--;
  }
  return result;
}

/** Reserve and persist a nonce before starting an Orca agent, preventing duplicate dispatch. */
export function claimNode(run, nodeId, { phase = 'work', nonce, now } = {}) {
  requiredText(nonce, '작업 nonce', 160);
  if (!PHASES.has(phase)) fail('invalid_phase', 'work 또는 review 단계가 필요합니다.');
  const existing = nodeIn(run, nodeId);
  if (existing.active?.nonce === nonce && existing.active.phase === phase) return copy(run);
  if (run.nodes.some(node => node.active?.nonce === nonce) || run.acceptedReports.some(item => item.nonce === nonce)) {
    fail('duplicate_nonce', '이미 사용된 작업 nonce입니다.');
  }
  if (!nextActions(run).some(action => action.nodeId === nodeId && action.phase === phase)) {
    fail('not_ready', '선행 검증·승인·동시 실행 조건을 충족하지 않은 단계입니다.');
  }
  const next = copy(run);
  const node = nodeIn(next, nodeId);
  const at = instant(now);
  if (phase === 'work') {
    node.attempts++;
    node.status = 'running';
    node.report = null;
    node.review = null;
  } else {
    node.reviewAttempts++;
    node.status = 'review';
  }
  node.failureReason = null;
  node.active = {
    phase, nonce, terminalId: null, startedAt: at,
    attempt: phase === 'work' ? node.attempts : node.reviewAttempts,
  };
  event(next, 'task.claimed', node.title + (phase === 'review' ? ' 검토를 할당했습니다.' : ' 작업을 할당했습니다.'), at, nodeId, { phase, nonce });
  return settle(next);
}

export function recordLaunch(run, nodeId, { nonce, terminalId, workspaceId, sessionId, now } = {}) {
  requiredText(terminalId, '터미널 ID', 400);
  const next = copy(run);
  const node = nodeIn(next, nodeId);
  if (!node.active || node.active.nonce !== nonce) fail('stale_report', '현재 실행과 다른 시작 영수증입니다.');
  if (node.active.terminalId && node.active.terminalId !== terminalId) fail('duplicate_launch', '이미 다른 터미널이 연결되어 있습니다.');
  if (node.active.terminalId === terminalId) return next;
  node.active = {
    ...node.active, terminalId,
    ...(workspaceId ? { workspaceId } : {}),
    ...(sessionId ? { sessionId } : {}),
  };
  event(next, 'task.launched', node.title + ' 에이전트가 시작되었습니다.', instant(now), nodeId, { phase: node.active.phase, terminalId });
  return settle(next);
}

function normalizeReport(run, nodeId, report) {
  if (!report || typeof report !== 'object' || report.runId !== run.id || report.nodeId !== nodeId) {
    fail('invalid_report', '작업 결과의 실행 ID 또는 단계 ID가 다릅니다.');
  }
  requiredText(report.nonce, '결과 nonce', 160);
  if (!PHASES.has(report.phase) || !OUTCOMES.has(report.outcome)) fail('invalid_report', '결과 단계 또는 판정을 확인하세요.');
  const summary = requiredText(report.summary, '결과 요약', 16000);
  if (!Array.isArray(report.evidence) || report.evidence.length > 30) fail('invalid_report', '결과 근거는 최대 30개 배열이어야 합니다.');
  const evidence = report.evidence.map(item => {
    if (!item || typeof item !== 'object') fail('invalid_evidence', '결과 근거 형식이 잘못되었습니다.');
    if (item.kind === 'command') {
      const command = requiredText(item.command, '실행한 명령', 4000);
      if (!Number.isInteger(item.exitCode)) fail('invalid_evidence', '명령 종료 코드가 필요합니다.');
      if (report.outcome === 'passed' && item.exitCode !== 0) fail('contradictory_evidence', '실패한 명령을 통과 근거로 사용할 수 없습니다.');
      return { ...copy(item), kind: 'command', command, exitCode: item.exitCode };
    }
    if (item.kind === 'artifact') return { ...copy(item), kind: 'artifact', path: requiredText(item.path, '산출물 경로', 4000) };
    if (item.kind === 'note') return { ...copy(item), kind: 'note', text: requiredText(item.text, '확인 근거', 12000) };
    fail('invalid_evidence', 'command, artifact, note 근거만 지원합니다.');
  });
  if (report.outcome === 'passed' && evidence.length === 0) fail('missing_evidence', '근거 없이 작업이나 검토를 통과시킬 수 없습니다.');
  return {
    ...copy(report), runId: run.id, nodeId, nonce: report.nonce,
    phase: report.phase, outcome: report.outcome, summary, evidence,
    ...(report.next ? { next: requiredText(report.next, '다음 행동', 4000) } : {}),
  };
}

function repairAfterFailure(run, node, report, at) {
  node.active = null;
  node.failureReason = report.summary;
  invalidate(run, node.id);
  if (node.id === 'test' && run.nodes.some(item => item.id === 'build')) {
    const build = nodeIn(run, 'build');
    if (run.repairLoops < run.maxRepairLoops && node.attempts < run.maxAttempts && build.attempts < run.maxAttempts) {
      run.repairLoops++;
      const feedback = copy(report);
      invalidate(run, 'build', true);
      nodeIn(run, 'build').feedback = feedback;
      nodeIn(run, 'test').feedback = feedback;
      event(run, 'loop.repair', '테스트 실패를 구현 단계로 돌려보냈습니다. 수정 루프 ' + run.repairLoops + '/' + run.maxRepairLoops, at, 'build', { sourceNodeId: node.id });
      return;
    }
    node.status = 'failed';
    node.failureReason += ' · 테스트 수정 루프 또는 단계별 실행 한도에 도달했습니다.';
  } else if (node.attempts < run.maxAttempts && node.reviewAttempts < run.maxAttempts) {
    node.feedback = copy(report);
    node.status = 'pending';
    node.report = null;
    node.review = null;
    node.approval = null;
    event(run, 'task.retry-planned', node.title + ' 재작업을 준비했습니다.', at, node.id);
  } else {
    node.status = 'failed';
    node.failureReason += ' · 단계별 실행 한도에 도달했습니다.';
  }
}

/** Apply an explicit, nonce-bound report; repeated accepted reports are idempotent. */
export function applyReport(run, nodeId, report, { now } = {}) {
  const clean = normalizeReport(run, nodeId, report);
  const accepted = run.acceptedReports.find(item => item.nonce === clean.nonce);
  if (accepted) {
    if (accepted.nodeId !== nodeId || accepted.phase !== clean.phase) fail('stale_report', '다른 작업에 사용된 결과 nonce입니다.');
    return copy(run);
  }
  const source = nodeIn(run, nodeId);
  if (!source.active || source.active.nonce !== clean.nonce || source.active.phase !== clean.phase) {
    fail('stale_report', '중단·재시도 전의 결과 또는 현재 실행과 다른 결과입니다.');
  }
  if (clean.attempt !== undefined && clean.attempt !== source.active.attempt) fail('stale_report', '다른 시도 횟수의 결과입니다.');
  const next = copy(run);
  const node = nodeIn(next, nodeId);
  const at = instant(now);
  const acceptedReport = { ...clean, receivedAt: at };
  next.acceptedReports.push({ nonce: clean.nonce, nodeId, phase: clean.phase });
  node.history.push(acceptedReport);
  if (clean.phase === 'work') node.report = acceptedReport;
  else node.review = acceptedReport;
  node.active = null;
  event(next, 'task.reported', clean.summary, at, nodeId, { phase: clean.phase, outcome: clean.outcome, next: clean.next ?? null });

  if (clean.outcome === 'blocked') {
    node.status = 'blocked';
    node.failureReason = clean.summary;
    node.blockedPhase = clean.phase;
  } else if (clean.outcome === 'failed') {
    repairAfterFailure(next, node, acceptedReport, at);
  } else if (clean.phase === 'work') {
    if (node.reviewAttempts >= next.maxAttempts) {
      node.status = 'failed';
      node.failureReason = '검토 실행 한도에 도달했습니다.';
    } else {
      node.status = 'review';
    }
  } else {
    node.status = 'passed';
    node.completedAt = at;
    node.failureReason = null;
    event(next, 'task.passed', node.title + ' 작업과 독립 검토를 통과했습니다.', at, nodeId);
  }
  const settled = settle(next);
  if (settled.status === 'completed' && run.status !== 'completed') event(settled, 'run.completed', '모든 단계의 작업과 검토가 완료되었습니다.', at);
  return settled;
}

export function approveNode(run, nodeId, { note = '사용자가 이 단계의 실행을 승인했습니다.', now } = {}) {
  const next = copy(run);
  const node = nodeIn(next, nodeId);
  if (!node.requiresApproval) fail('approval_not_required', '승인이 필요한 단계가 아닙니다.');
  if (next.status === 'cancelled') fail('cancelled', '취소된 실행은 승인할 수 없습니다.');
  if (!dependenciesPassed(next, node)) fail('not_ready', '선행 단계의 검증을 먼저 마쳐야 합니다.');
  if (node.approval && !node.active) return next;
  if (node.status !== 'awaiting-approval') fail('not_ready', '현재 승인 대기 중인 단계가 아닙니다.');
  const at = instant(now);
  node.approval = { at, note: requiredText(note, '승인 내용', 4000) };
  node.status = 'pending';
  event(next, 'task.approved', node.title + ' 실행을 승인했습니다.', at, nodeId, { note: node.approval.note });
  return settle(next);
}

export function pauseRun(run, { reason = '사용자가 일시정지했습니다.', now } = {}) {
  const next = copy(run);
  if (next.status === 'cancelled' || next.status === 'completed') return next;
  if (next.status !== 'paused') event(next, 'run.paused', requiredText(reason, '중단 사유'), instant(now));
  next.status = 'paused';
  return next;
}

export function resumeRun(run, { now } = {}) {
  const next = copy(run);
  if (next.status === 'cancelled') fail('cancelled', '취소된 실행은 다시 시작할 수 없습니다. 새 실행을 만드세요.');
  if (next.status === 'completed') return next;
  if (next.status === 'paused') {
    next.status = 'ready';
    event(next, 'run.resumed', '저장된 지점부터 이어갑니다.', instant(now));
  }
  return settle(next);
}

/** Block missing completion/permission/ambiguous launch; never invent a passing report. */
export function blockNode(run, nodeId, { nonce, reason, now } = {}) {
  const next = copy(run);
  const node = nodeIn(next, nodeId);
  if (nonce && node.active?.nonce !== nonce) fail('stale_report', '현재 실행과 다른 중단 요청입니다.');
  if (node.status === 'passed') fail('already_passed', '검증 완료된 단계는 명시적으로 다시 실행해야 합니다.');
  node.blockedPhase = node.active?.phase ?? (node.status === 'review' ? 'review' : 'work');
  node.active = null;
  node.status = 'blocked';
  node.failureReason = requiredText(reason, '중단 사유', 4000);
  event(next, 'task.blocked', node.failureReason, instant(now), nodeId);
  return settle(next);
}

/**
 * Explicit user retry only. A blocked review resumes review; all other retries start
 * fresh work, invalidate downstream validation/approvals, and keep consumed attempt counts.
 */
export function retryNode(run, nodeId, { now } = {}) {
  const next = copy(run);
  const node = nodeIn(next, nodeId);
  if (next.status === 'cancelled' || next.status === 'completed') fail('not_retryable', '완료·취소된 실행에서는 새 실행을 만드세요.');
  if (!['blocked', 'failed'].includes(node.status) || node.active) fail('not_retryable', '중단되거나 실패한 단계만 재시도할 수 있습니다.');
  const reviewOnly = node.blockedPhase === 'review' && node.report?.outcome === 'passed';
  if ((reviewOnly ? node.reviewAttempts : node.attempts) >= next.maxAttempts) fail('attempt_limit', '실행 횟수 한도에 도달했습니다. 목표나 설정을 수정해 새 실행을 만드세요.');
  invalidate(next, nodeId);
  node.status = reviewOnly ? 'review' : 'pending';
  node.failureReason = null;
  if (!reviewOnly) {
    node.report = null;
    node.review = null;
    node.approval = null;
  }
  event(next, 'task.retry-requested', node.title + ' 재시도를 요청했습니다.', instant(now), nodeId);
  return settle(next);
}

/**
 * After a restart, only proven live terminal IDs retain their reservations.
 * Missing/unknown launches become blocked and require explicit retry/reconciliation.
 */
export function recoverRun(run, liveTerminalIds = [], { now } = {}) {
  const next = copy(run);
  const live = new Set(liveTerminalIds);
  const at = instant(now);
  for (const node of next.nodes) {
    if (!node.active || (node.active.terminalId && live.has(node.active.terminalId))) continue;
    node.interrupted = copy(node.active);
    node.blockedPhase = node.active.phase;
    node.active = null;
    node.status = 'blocked';
    node.failureReason = '재시작 후 기존 실행을 확인할 수 없습니다. 결과를 확인한 뒤 재시도하세요.';
    event(next, 'task.recovery-blocked', node.failureReason, at, node.id);
  }
  return settle(next);
}

export function cancelRun(run, { reason = '사용자가 실행을 취소했습니다.', now } = {}) {
  const next = copy(run);
  if (next.status === 'completed' || next.status === 'cancelled') return next;
  const at = instant(now);
  next.status = 'cancelled';
  for (const node of next.nodes) {
    if (node.active) node.interrupted = copy(node.active);
    if (node.status !== 'passed') {
      node.status = 'blocked';
      node.failureReason = reason;
      node.active = null;
    }
  }
  event(next, 'run.cancelled', requiredText(reason, '취소 사유'), at);
  return next;
}

export function dateKey(value, timeZone = DEFAULT_TIME_ZONE) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    fail('invalid_timezone', '유효하지 않은 시간대입니다.');
  }
  const parts = formatter.formatToParts(new Date(instant(value)));
  return ['year', 'month', 'day'].map(key => parts.find(part => part.type === key).value).join('-');
}

function previousDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('invalid_date', '날짜는 YYYY-MM-DD 형식이어야 합니다.');
  const at = new Date(date + 'T00:00:00.000Z');
  if (!Number.isFinite(at.valueOf()) || at.toISOString().slice(0, 10) !== date) fail('invalid_date', '유효하지 않은 날짜입니다.');
  return new Date(at.valueOf() - 86400000).toISOString().slice(0, 10);
}

/** Calendar-day summaries deliberately distinguish yesterday from the last active day. */
export function dailySnapshot(runs, { date, now, timeZone = DEFAULT_TIME_ZONE } = {}) {
  const day = date ?? dateKey(now, timeZone);
  const yesterday = previousDay(day);
  const events = runs.flatMap(run => run.events.map(item => ({
    ...copy(item), runId: run.id, goal: run.goal, workspaceId: run.workspaceId,
    day: dateKey(item.at, timeZone),
  }))).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  const lastActiveDay = events.find(item => item.day < day)?.day ?? null;
  const next = runs.filter(run => !['completed', 'cancelled'].includes(run.status)).map(run => {
    const candidates = run.nodes.filter(node => node.status !== 'passed');
    const node = candidates.find(item => item.active)
      ?? candidates.find(item => ['blocked', 'failed', 'awaiting-approval'].includes(item.status))
      ?? candidates.find(item => dependenciesPassed(run, item))
      ?? candidates[0];
    const lastVerified = [...run.nodes].filter(item => item.completedAt).sort((a, b) => b.completedAt.localeCompare(a.completedAt))[0];
    return {
      runId: run.id, goal: run.goal, workspaceId: run.workspaceId,
      status: run.status, nodeId: node?.id ?? null, title: node?.title ?? null,
      state: node?.status ?? null, why: node?.failureReason ?? null,
      next: node?.report?.next ?? node?.review?.next ?? (
        run.status === 'paused' ? '저장한 실행을 재개하세요.' :
        node?.status === 'awaiting-approval' ? '검증 결과를 확인하고 이 단계의 실행을 승인하세요.' :
        ['blocked', 'failed'].includes(node?.status) ? '중단 원인과 기존 에이전트 결과를 확인하세요.' :
        node?.active ? '실행 중인 에이전트의 결과를 기다립니다.' : '선행 검증을 충족한 다음 단계를 진행합니다.'
      ),
      verified: lastVerified ? { nodeId: lastVerified.id, title: lastVerified.title, at: lastVerified.completedAt, summary: lastVerified.review?.summary ?? lastVerified.report?.summary } : null,
    };
  });
  return {
    date: day, yesterdayDate: yesterday, timeZone,
    today: events.filter(item => item.day === day),
    yesterday: events.filter(item => item.day === yesterday),
    hasYesterday: events.some(item => item.day === yesterday),
    lastActiveDay,
    lastActive: lastActiveDay ? events.filter(item => item.day === lastActiveDay) : [],
    next,
  };
}
