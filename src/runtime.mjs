import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createRun, nextActions, claimNode, recordLaunch, applyReport, approveNode,
  pauseRun, resumeRun, retryNode, blockNode, cancelRun, releaseClaim
} from './engine.mjs';
import { applyAssignments } from './assignments.mjs';
import { skipReleaseStages } from './scope.mjs';
import { restoreAgent } from './fallback.mjs';
import { AUTONOMY_LIMITS, DECIDE_PROMPT, createSupervisor } from './autonomy.mjs';
import { EFFORTS, VISUAL_STAGES, VISUAL_DEFAULT } from './visual.mjs';
import { resolveLaunch } from './profile.mjs';
import { createPersistence, archiveRun, retainArchives } from './store.mjs';
import { createJobWatch, WATCH_INTERVAL_MS } from './watch.mjs';
import { runtimeUsageSync } from './usage.mjs';
import { projectState } from './views.mjs';
import { buildNodePrompt } from './prompt.mjs';
import { planRunInput, requestKey } from './flows.mjs';
import { approvalScope } from './approval.mjs';
import { stageBudget } from './proportion.mjs';
import { createTerminalCleanup, cleanupRecorder, describeSweep, CLEANUP_INTERVAL_MS } from './cleanup.mjs';
import { classifySendError, focusTerminal, SEND_RETRY_DELAYS_MS } from './delivery.mjs';
import { readBlocker, BEFORE_ANY_TURN } from './agentscreen.mjs';
import { safeError } from './safeerror.mjs';
import { sendingEvidence, workEvidence } from './sending.mjs';
import { refundAttempts, planManualRefund, NO_WORK } from './refund.mjs';
import { within, assertNoSymlinks, boundedJson, resultFiles } from './receipts.mjs';
import { nextLaunch, readLimits, GLOBAL_LIMITS } from './scheduler.mjs';
import { gitWorkingState, sourceProblem } from './commitcheck.mjs';
import { buildLabel } from './buildinfo.mjs';
import { artifactReader } from './artifacts.mjs';
import { recreateRefusal, reservedGitTrace } from './wscreate.mjs';
import { createCancelMarks, closeCancelled } from './cancel.mjs';
import { releaseUncertainJob } from './slotrelease.mjs';
import { createRequestLedger } from './requests.mjs';
import { parentEvidenceOf, recheckParentEvidence } from './reuse.mjs';
import { digestFile, gitRepositoryState, preflightMessage, sourceFingerprint } from './repository.mjs';
import { recordReleaseBinary, recheckBeforeSubmission, readReleaseFile } from './releaselink.mjs';
import { MAX_REPORT_FIXES, REPORT_FIX_DELAY_MS, isReportFormError, formError, reportFixPrompt } from './reportfix.mjs';

export { buildNodePrompt, gitRepositoryState, sourceFingerprint };

const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_RUNS = 40;
const MAX_HOST_PROMPT_CHARS = 4096;
// Orca's agent.launch types a passed prompt before it detects the agent process and drops it
// (agent_launch_terminal_not_running_agent, only in the plugin log). The plugin launches without
// a prompt, waits until the agent reports in, and types the prompt itself into the focused terminal.
const READY_POLL_MS = 1000;
const READY_POLLS = 60;
const PROMPT_CONFIRM_MS = 45_000;
const MAX_PROMPT_DELIVERY_RETRIES = 2;
// A turn of a prompted agent that dies of an error (network, API) is continued by the same agent:
// one short line, never the assignment again, bounded with growing waits.
const CONTINUE_DELAYS_MS = [15_000, 60_000, 180_000];
const MAX_CONTINUATIONS = CONTINUE_DELAYS_MS.length;
const CONTINUE_PROMPT = '이전 턴이 오류로 중단됐습니다. 같은 작업 지시를 이어서 완료하고 보고서를 저장하세요.';
const RECEIPT_TURN_MARGIN_MS = 1000;
const DECISION_NUDGE_DELAY_MS = 5000;
const UNREADY_RETRY_SAFE = '아무 지시도 입력하지 않았고 터미널은 닫혔으므로 이 단계를 다시 시도해도 안전합니다.';
// Hosts can finish later after these; anything else with no workspace of the reserved name failed.
const AMBIGUOUS_HOST_CODES = new Set(['timeout', 'cancelled']);
const FAILED_AGENT_OUTCOMES = new Set(['failure', 'cancellation', 'superseded', 'interruption']);
export const PROVIDERS = ['codex', 'claude', 'cursor', 'grok', 'antigravity', 'gemini', 'opencode', 'kiro'];
const clone = (value) => structuredClone(value);
// Orca rejects own properties whose value is undefined, although structuredClone
// preserves them. Normalize only at persistence/RPC boundaries, just as a JSON
// wire encoding does; reject values that could silently corrupt domain data.
function jsonValue(value) {
  const encoded = JSON.stringify(value, (_key, item) => {
    if (['bigint', 'function', 'symbol'].includes(typeof item) ||
        (typeof item === 'number' && !Number.isFinite(item))) {
      throw runtimeError('invalid_params', '실행 데이터에 JSON으로 저장할 수 없는 값이 있습니다.');
    }
    return item;
  });
  if (encoded === undefined) throw runtimeError('invalid_params', '응답 데이터가 비어 있습니다.');
  return JSON.parse(encoded);
}
const nowIso = (clock) => new Date(clock()).toISOString();

export function runtimeError(code, message) {
  return Object.assign(new Error(message), { code });
}
function requireString(value, label, maximum = 4000) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum) {
    throw runtimeError('invalid_params', label + ' 값이 필요합니다 (최대 ' + maximum + '자).');
  }
  return value.trim();
}
function isLocal(row) {
  return !row?.hostId || row.hostId === 'local';
}
function safeSegment(value) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw runtimeError('invalid_params', '잘못된 실행 식별자입니다.');
  }
  return value;
}
function findNode(run, id) {
  const node = run.nodes.find((item) => item.id === id);
  if (!node) throw runtimeError('invalid_params', '실행에 해당 단계가 없습니다.');
  return node;
}
function checkExpectedNonce(node, expectedNonce) {
  if (expectedNonce !== undefined && expectedNonce !== (node.active?.nonce ?? node.pendingReceipt?.nonce)) {
    throw runtimeError('stale_assignment', '확인한 배정이 이미 변경됐습니다. 현재 단계와 터미널을 다시 확인하세요.');
  }
}
function activeJobs(run) {
  return (run.jobs || []).filter((job) => ['launching', 'running', 'awaiting-report', 'uncertain'].includes(job.state));
}
function matchingNodeJob(run, job) {
  const node = findNode(run, job.nodeId);
  return node.active?.nonce === job.nonce || node.pendingReceipt?.nonce === job.nonce;
}
function appendEvent(run, summary, clock, extra = {}) {
  run.events ||= [];
  run.events.push({ id: randomUUID(), at: nowIso(clock), type: 'runtime', kind: 'runtime', summary, ...extra });
  if (run.events.length > 600) run.events.splice(0, run.events.length - 600);
  run.updatedAt = nowIso(clock);
}
export function createRuntime({ orca, now = Date.now, receiptRoot = path.join(homedir(), '.toris-neon', 'runs'),
  fingerprint = sourceFingerprint, readReceipt = boundedJson, ensureDirectory,
  writeBrief = (file, text) => fs.writeFile(file, text, { mode: 0o600 }),
  inspectRepository = gitRepositoryState, workspaceTrace = reservedGitTrace, eccAdvisor = null, visualAdvisor = null, launchOverrides = null,
  receiptWrittenAt = async (file) => (await fs.stat(file)).mtimeMs, listResultFiles = resultFiles,
  validateArtifact, resolvePlayAccount, readPlayApp, id = randomUUID, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  watchIntervalMs = WATCH_INTERVAL_MS, cleanupIntervalMs = CLEANUP_INTERVAL_MS, gitState = gitWorkingState, buildInfo = null, readRelease = readReleaseFile } = {}) {
  if (!orca?.host || !orca?.storage) throw new Error('Orca host and storage are required.');
  // Situational ECC agents and skills for this launch, kept on the job (prompt) and the stage
  // (inspector). Missing guidance never blocks a launch; for a Claude stage it is said in an event.
  const adviseEcc = async (run, node, job) => {
    if (!eccAdvisor) return;
    let advice;
    try { advice = await eccAdvisor.advise({ run, node, job }); }
    catch (error) { advice = { agents: [], skills: [], error: 'ECC 추천을 만들지 못했습니다: ' + safeError(error).message }; }
    if (!advice) return;
    const shortlist = jsonValue({
      phase: job.phase, at: nowIso(now), version: advice.version ?? null, stack: advice.stack ?? null,
      situation: advice.situation ?? null, agents: (advice.agents ?? []).slice(0, 4), skills: (advice.skills ?? []).slice(0, 5),
      ...(advice.disabled ? { disabled: true } : {}), ...(advice.error ? { error: String(advice.error).slice(0, 400) } : {})
    });
    job.ecc = shortlist;
    node.eccShortlist = shortlist;
    if (shortlist.error && job.agent === 'claude') appendEvent(run, node.title + ': ECC 안내 없이 진행합니다 (' + shortlist.error + ')', now, { nodeId: node.id });
  };
  // Design/assets: installed image and sprite skills for the art direction (src/visual.mjs).
  const adviseVisual = async (run, node, job) => {
    if (!visualAdvisor) return;
    let record = null;
    try { record = await visualAdvisor.advise({ run, node, job }); }
    catch (error) { record = { stage: node.id, skills: [], error: '시각 스킬 안내를 만들지 못했습니다: ' + safeError(error).message }; }
    if (!record) return;
    job.visual = jsonValue(record);
    node.visualShortlist = job.visual;
    if (record.error) appendEvent(run, node.title + ': ' + record.error, now, { nodeId: node.id });
  };
  // The host's agent.launch takes no model; Orca's agent.launch.before hook rewrites the command
  // line for the one launch registered here (src/visual.mjs). The outcome is recorded either way.
  const expectLaunchSettings = (run, node, action) => {
    const settings = resolveLaunch(run, node, action.phase, action.agent); // profile, stage override or visual default (src/profile.mjs)
    if (!settings) return null;
    return { settings, pending: launchOverrides?.expect({ workspaceId: run.workspaceId, workspacePath: run.workspacePath, agent: action.agent, settings }) ?? null };
  };
  const recordLaunchSettings = (run, node, job, expected) => {
    if (!expected) return;
    const outcome = expected.pending?.result() ?? { applied: false, reason: '모델 지정 hook이 연결돼 있지 않습니다.' };
    job.launchSettings = jsonValue({ ...expected.settings, ...outcome });
    node.launchSettings = job.launchSettings;
    const label = [expected.settings.model, expected.settings.effort].filter(Boolean).join(' · ');
    appendEvent(run, node.title + (outcome.applied ? ': ' + label + '로 에이전트를 실행했습니다.'
      : ': ' + label + ' 설정을 적용하지 못했습니다 (' + outcome.reason + '). 에이전트 기본 모델로 실행합니다.'), now, { nodeId: node.id });
  };
  const eccChoices = async () => {
    if (!eccAdvisor) return [];
    // catalog() never rejects by contract; a broken advisor only empties the picker.
    try { return (await eccAdvisor.catalog()).agents.map((item) => item.name); } catch { return []; }
  };
  // Orca refuses prompts over 4096 characters; a longer brief goes to a file in the job's receipt directory.
  const nodePrompt = async (run, node, job) => {
    const full = buildNodePrompt(run, node, job);
    if (full.length <= MAX_HOST_PROMPT_CHARS) return full;
    const briefPath = path.join(job.receiptDirectory, 'brief.md');
    await writeBrief(briefPath, full);
    return [
      'Toris Neon 작업 지시가 길어 파일로 전달합니다. 다른 작업 전에 아래 파일 전체를 읽고, 그 지시를 그대로 따르세요.',
      '작업 지시 파일: ' + briefPath,
      '최종 JSON 보고서 경로: ' + job.receiptPath
    ].join('\n\n');
  };
  let state = { version: 1, revision: 0, runs: [], archivedRuns: [] };
  let chain = Promise.resolve();
  let disposed = false;
  let pumpQueued = false;
  const subscriptions = [];
  const catalog = new Map();
  let lastStatusKey = null;
  const deliveryTasks = new Set(); // nonce (readiness and typing) or 'confirm:' + nonce
  const background = new Set();
  const verifySubmission = async (run, node) => {
    const submission = node.approval?.submission;
    if (!submission) return;
    if (!submission.accountId || !submission.developerId || !resolvePlayAccount) {
      throw runtimeError('conflict', 'Play 개발자 계정을 선택해 제출을 다시 승인해 주세요.');
    }
    await resolvePlayAccount(submission, { verifyAccess: true });
    if (await fingerprint(run.workspacePath) !== node.approval.sourceFingerprint) {
      throw runtimeError('conflict', '제출 승인 이후 소스가 변경됐습니다. 새 실행에서 검증과 구체적인 제출 승인을 다시 받으세요.');
    }
    await recheckBeforeSubmission(run, node, { read: (artifact) => readRelease(artifact, { workspacePath: run.workspacePath, receiptDirectory: path.join(receiptRoot, safeSegment(run.id)) }) }); // the checked build is still the file (src/releaselink.mjs)
  };
  const queue = (work) => {
    const operation = chain.then(work);
    chain = operation.catch(() => {});
    return operation;
  };
  const call = (method, params = {}, options) => {
    if (orca.host.has && !orca.host.has(method)) throw runtimeError('unknown_method', '현재 Orca에서 ' + method + ' API를 지원하지 않습니다.');
    return orca.host.call(method, params, options);
  };
  // Coalesce concurrent UI reads. Safety checks and mutations always call the
  // host directly; this cache is used only for the display catalog.
  const catalogRead = (method, force = false) => {
    const ttl = method === 'project.list' ? 5000 : method === 'workspace.list' ? 1500 : 250;
    const cached = catalog.get(method);
    if (cached?.pending) return cached.pending;
    if (!force && cached && cached.expiresAt > now()) return Promise.resolve(cached.value);
    const entry = {};
    const pending = Promise.resolve().then(() => call(method, method === 'workspace.list' ? { includeStatus: true } : {}));
    entry.pending = pending.then(value => {
      if (catalog.get(method) === entry) {
        entry.value = value;
        entry.expiresAt = now() + ttl;
        delete entry.pending;
      }
      return value;
    }, error => {
      if (catalog.get(method) === entry) catalog.delete(method);
      throw error;
    });
    catalog.set(method, entry);
    return entry.pending;
  };
  const invalidateCatalog = (...methods) => methods.forEach((method) => catalog.delete(method));
  const getRun = (runId) => {
    const run = state.runs.find((item) => item.id === runId);
    if (!run) throw runtimeError('invalid_params', '실행을 찾을 수 없습니다.');
    return run;
  };
  const replaceRun = (run) => {
    const index = state.runs.findIndex((item) => item.id === run.id);
    state.runs[index] = run;
    return run;
  };
  // Never throws unless `durable`: a failed write warns, notifies and retries (src/store.mjs) while
  // the run goes on from memory. Only an intent that must exist before acting refuses to proceed.
  const persistence = createPersistence({ storage: orca.storage, now, log: (line) => orca.log?.(line),
    notify: (title, body) => { void Promise.resolve().then(() => call('notifications.show', { title, body: body.slice(0, 900) })).catch(() => {}); },
    retry: () => { if (!disposed) void queue(() => persist()).then(() => { if (!persistence.failure()) schedulePump(); }, () => {}); } });
  const cancelMarks = createCancelMarks(orca.storage, (line) => orca.log?.(line));
  const requests = createRequestLedger(orca.storage, (line) => orca.log?.(line)); // request keys of pruned archives (src/requests.mjs)
  const expectRevision = (run, input) => { if (input.expectedRevision !== undefined && input.expectedRevision !== run.updatedAt) throw runtimeError('conflict', '실행 ' + run.id + '이(가) 요청 이후 바뀌었습니다(현재 revision ' + run.updatedAt + '). 상태를 다시 확인한 뒤 요청하세요.'); };
  const closeCancel = (run) => closeCancelled(run, { save: async () => { await persist(); return !persistence.failure(); },
    mark: (runId) => cancelMarks.write(runId, nowIso(now)), close: (terminalId) => call('terminal.close', { terminalId }),
    appendEvent: (target, text) => appendEvent(target, text, now), activeJobs, describeError: safeError });
  const persist = async ({ durable = false } = {}) => {
    state.revision += 1;
    jsonValue(state); // a value JSON cannot hold is a bug; refuse it as before
    const saved = await persistence.save(state);
    if (saved.ok) await cancelMarks.clear(state);
    else if (durable) throw Object.assign(runtimeError('action_failed', '실행 상태를 저장하지 못해 진행하지 않았습니다: ' + saved.error), { unsaved: true });
    try { orca.panels?.post('state.changed', jsonValue(projectState(state, 'summary', limits))); } catch {}
    try {
      const working = state.runs.reduce((sum, run) => sum + activeJobs(run).filter((job) => job.state === 'running').length, 0);
      const blocked = state.runs.filter((run) => run.status === 'blocked').length;
      const statusKey = working + ':' + blocked;
      if (statusKey !== lastStatusKey) {
        await call('statusBar.update', { id: 'pipeline', text: 'NEON · ' + working + ' 실행' + (blocked ? ' · ' + blocked + ' 확인' : ''), tone: blocked ? 'warning' : working ? 'accent' : 'neutral' });
        lastStatusKey = statusKey;
      }
    } catch {}
  };
  const markBlocked = (run, job, reason, uncertain = false) => {
    const original = findNode(run, job.nodeId);
    const previous = original.active || original.pendingReceipt;
    run = blockNode(run, job.nodeId, { ...(original.active?.nonce === job.nonce ? { nonce: job.nonce } : {}), reason, now: now() });
    const node = findNode(run, job.nodeId);
    node.pendingReceipt = { ...previous, ...job };
    node.runtimeMessage = reason;
    job.state = uncertain ? 'uncertain' : 'awaiting-report';
    const savedJob = (run.jobs || []).find((entry) => entry.nonce === job.nonce);
    if (savedJob) savedJob.state = job.state;
    if (uncertain) node.launchUncertain = { nonce: job.nonce, at: nowIso(now), reason };
    replaceRun(run);
    if (run.autonomous) schedulePump(); // the supervisor decides what happens next
    return run;
  };
  // An agent on a screen no prompt answers (src/agentscreen.mjs): nothing more is typed, its terminal
  // is closed so a held prompt can never run later, and the stage names the action (autonomy switches agent).
  const screenOf = (job) => readBlocker(call, { terminalId: job.terminalId, agent: job.agent }, (line) => orca.log?.(line));
  const blockOnScreen = async (run, job, blocker) => {
    let closed = false, closeError = '';
    try { closed = (await call('terminal.close', { terminalId: job.terminalId }))?.closed === true; }
    catch (error) { closeError = ' (' + safeError(error).message + ')'; }
    job.blocker = { kind: blocker.kind, agent: job.agent, ...(blocker.dialog ? { dialog: blocker.dialog } : {}) };
    markBlocked(run, job, blocker.message + (closed ? '' : ' 터미널을 닫지 못해' + closeError + ' 입력된 지시가 나중에 실행될 수 있으니 터미널을 직접 닫은 뒤 재시도하세요.'), !closed);
    // Hook review and start dialogs come before any turn; a usage limit or login can follow real work.
    const worked = closed && (!BEFORE_ANY_TURN.has(blocker.kind) || await evidenceOf(job).catch((error) => '결과 폴더를 읽지 못함 (' + safeError(error).message + ')'));
    if (closed && !worked) replaceRun(giveBack(getRun(run.id), job.nodeId, [job.nonce], '에이전트 화면(' + blocker.kind + ')에서 멈춰 작업을 시작하지 않았고 터미널을 닫았습니다.').run);
    return persist();
  };
  // Attempts that never started work do not count (src/refund.mjs); each refund is a run event.
  const evidenceOf = async (job) => workEvidence({ job, files: await listResultFiles(job) });
  const giveBack = (run, nodeId, nonces, reason, manual = false) => {
    const refund = refundAttempts(run, nodeId, nonces, { at: nowIso(now), reason, manual });
    refund.message = '시작 안 한 시도 ' + refund.count + '회를 되돌렸습니다 (' + nonces.map((nonce) => nonce.slice(0, 8)).join(', ') + '): ' + reason;
    appendEvent(refund.run, findNode(refund.run, nodeId).title + ': ' + refund.message, now, { nodeId });
    return refund;
  };
  const createReceiptDirectory = async (directory) => {
    if (ensureDirectory) return ensureDirectory(directory);
    await assertNoSymlinks(path.dirname(receiptRoot), directory, true);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await assertNoSymlinks(path.dirname(receiptRoot), directory);
  };
  const artifactDetails = async (evidence, job) => {
    if (validateArtifact) return validateArtifact(evidence, job);
    const filename = path.resolve(job.receiptDirectory, evidence.path || '');
    if (!within(job.receiptDirectory, filename) || filename === job.receiptPath) {
      throw runtimeError('invalid_params', 'artifact는 완료 JSON 외의 실행 결과 디렉터리 내부 파일이어야 합니다.');
    }
    await assertNoSymlinks(job.receiptDirectory, filename);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.size === 0 || stat.size > MAX_ARTIFACT_BYTES) {
      throw runtimeError('invalid_params', 'artifact가 없거나 비어 있거나 256 MiB를 초과합니다.');
    }
    return { kind: 'artifact', path: filename, size: stat.size, sha256: await digestFile(filename), ...(evidence.label ? { label: evidence.label } : {}) };
  };
  // A passing report can follow a failed turn only if a later turn wrote it. Records stored before
  // turns were tracked (no failedAt) kept their first failure forever, so their outcome may describe
  // an older turn; callers reach them only once the live agent is idle, and the report decides.
  const writtenByLaterTurn = async (job) => {
    if (job.failedAt === undefined) return true;
    let writtenAt = null;
    try { writtenAt = await receiptWrittenAt(job.receiptPath); } catch { writtenAt = null; } // unknown time keeps the refusal
    return Number.isFinite(writtenAt) && writtenAt > job.failedAt + RECEIPT_TURN_MARGIN_MS;
  };
  // A report refused for its form: the same agent corrects only the report (src/reportfix.mjs).
  const readGit = async (dir) => { try { return gitState ? await gitState(dir) : null; } catch (error) { throw runtimeError('conflict', 'git 상태를 읽지 못해 커밋 여부를 확인할 수 없습니다: ' + safeError(error).message); } }; // never fails open
  const requestReportFix = async (run, job, reason, { commit = false } = {}) => {
    const count = job.reportFixes ?? 0;
    if (count >= MAX_REPORT_FIXES || job.promptRecovery?.state !== 'sent' || run.status === 'paused' || !job.terminalId) return false;
    let at = null;
    try { at = await receiptWrittenAt(job.receiptPath); } catch { at = null; }
    job.reportRejectedAt = Number.isFinite(at) ? at : now();
    job.reportFix = { reason: String(reason).slice(0, 900), at: nowIso(now), ...(commit ? { commit: true } : {}) };
    const node = findNode(run, job.nodeId);
    node.runtimeMessage = '보고서 형식이 받아들여지지 않았습니다: ' + reason + ' 작업은 그대로 두고 같은 에이전트에게 보고서만 고치도록 요청합니다 (' + (count + 1) + '/' + MAX_REPORT_FIXES + ').';
    appendEvent(run, node.title + ': ' + node.runtimeMessage, now, { nodeId: node.id, nonce: job.nonce });
    track('continue:' + job.nonce, job.nonce, async () => {
      await sleep(REPORT_FIX_DELAY_MS);
      await queue(() => continueTurn(run.id, job.nonce, 'report'));
    });
    return true;
  };
  const acceptReceipt = async (run, job, outcome) => {
    if (!matchingNodeJob(run, job)) return false;
    let report;
    try {
      try { report = await readReceipt(job.receiptPath, job.receiptDirectory); }
      catch (error) { throw error.code === 'ENOENT' ? Object.assign(error, { missingReceipt: true }) : error; }
      for (const field of ['runId', 'nodeId', 'nonce', 'phase', 'attempt']) {
        if (report?.[field] !== job[field]) throw formError('완료 보고서의 ' + field + ' 식별자가 현재 배정과 다릅니다 (보고서: ' + JSON.stringify(report?.[field] ?? null) + ', 배정: ' + JSON.stringify(job[field]) + ').');
      }
      if (FAILED_AGENT_OUTCOMES.has(outcome) && report.outcome === 'passed' && !(await writtenByLaterTurn(job))) {
        throw runtimeError('invalid_params', '에이전트 종료 상태와 성공 보고서가 일치하지 않습니다.');
      }
      if (!Array.isArray(report.evidence) || report.evidence.length > 64) {
        throw formError('검증 evidence는 최대 64개 배열이어야 합니다.');
      }
      const artifacts = [];
      for (const evidence of report.evidence) {
        if (evidence.kind !== 'artifact') continue;
        try { artifacts.push(await artifactDetails(evidence, job)); }
        catch (error) { throw formError('artifact ' + String(evidence.path) + ': ' + (error.code === 'ENOENT' ? '파일이 없습니다.' : safeError(error).message)); }
      }
      let index = 0; // each artifact item keeps the hash taken here (src/artifacts.mjs shows a changed file as 변경됨)
      report = { ...report, evidence: report.evidence.map((item) => item.kind === 'artifact' ? { ...item, sha256: artifacts[index++].sha256 } : item) };
      if (report.outcome === 'passed' && artifacts.length === 0) {
        throw formError('성공 보고서에는 실제 검증 artifact가 한 개 이상 필요합니다.');
      }
      if (job.phase === 'review' && report.outcome === 'passed') {
        if (!job.sourceFingerprint || report.sourceFingerprint !== job.sourceFingerprint) {
          throw runtimeError('conflict', '검토 보고서가 배정된 소스 버전과 다릅니다.');
        }
        if (await fingerprint(run.workspacePath) !== job.sourceFingerprint) {
          throw runtimeError('conflict', '검토 도중 소스가 변경됐습니다. 현재 소스를 다시 검증하세요.');
        }
      }
      const problem = sourceProblem({ job, write: findNode(run, job.nodeId).write, report, state: report.outcome === 'passed' && (job.startHead || job.sourceCommit) ? await readGit(run.workspacePath) : null });
      if (problem?.kind === 'commit') throw Object.assign(formError(problem.message), { commitRequired: true }); // written source must be committed (src/commitcheck.mjs)
      if (problem) throw runtimeError('conflict', problem.message);
      const binary = job.phase === 'work' ? await recordReleaseBinary(run, findNode(run, job.nodeId), report, { read: (artifact) => readRelease(artifact, { workspacePath: run.workspacePath, receiptDirectory: job.receiptDirectory }), at: nowIso(now) }) : null;
      const node = findNode(run, job.nodeId);
      if (!node.active) {
        node.active = { ...node.pendingReceipt, ...job };
        node.status = job.phase === 'review' ? 'review' : 'running';
      }
      delete node.pendingReceipt;
      delete node.launchUncertain;
      run = applyReport(run, job.nodeId, report, { now: now() });
      const updatedNode = findNode(run, job.nodeId);
      updatedNode.receipt = { path: job.receiptPath, at: nowIso(now), phase: job.phase, artifacts };
      if (binary && updatedNode.report?.releaseLink) updatedNode.report.releaseLink.binary = binary; // what Neon read from the file itself
      updatedNode.runtimeMessage = '';
      const storedJob = (run.jobs || []).find((entry) => entry.nonce === job.nonce);
      if (storedJob) {
        storedJob.state = 'complete';
        storedJob.completedAt = nowIso(now);
        storedJob.outcome = updatedNode.history.at(-1)?.outcome ?? report.outcome; // a review failed on a defect follow-up (src/followups.mjs)
      }
      replaceRun(run);
      appendEvent(run, node.title + ' ' + (job.phase === 'review' ? '검토' : '작업') + ': ' + (storedJob?.outcome ?? report.outcome), now, { nodeId: job.nodeId });
      return true;
    } catch (error) {
      if (error.missingReceipt && job.blocker) return false; // already stopped with its cause
      const blocker = error.missingReceipt ? await screenOf(job) : null;
      if (blocker) { await blockOnScreen(run, job, blocker); return false; }
      const message = !error.missingReceipt ? safeError(error).message
        : FAILED_AGENT_OUTCOMES.has(job.agentOutcome) && job.promptSeen ? failedTurnMessage(job, '원인을 해결한 뒤 터미널에서 이어서 진행하고 상태 동기화하거나 이 단계를 재시도하세요.')
        : job.promptSeen ? '에이전트가 종료됐지만 검증 보고서가 없습니다. 보고서를 저장한 뒤 새로고침하거나 이 단계를 재시도하세요.'
          : '에이전트가 작업을 시작한 기록이 없습니다. 작업 지시가 전달되지 않았을 수 있으니 터미널을 확인한 뒤 이 단계를 재시도하세요.';
      if (isReportFormError(error) && await requestReportFix(run, job, message, { commit: error.commitRequired })) return false;
      markBlocked(run, job, message);
      return false;
    }
  };
  const listAgents = async (workspaceId) => (await call('agents.list', { workspaceId })).agents || [];
  const reconcile = async (run, explicit = false) => {
    if (['cancelled', 'completed'].includes(run.status) || !run.workspaceId || !activeJobs(run).length) return run;
    let agents;
    try { agents = await listAgents(run.workspaceId); }
    catch (error) {
      appendEvent(run, '에이전트 상태 조회 실패: ' + safeError(error).message, now);
      return run;
    }
    for (const originalJob of [...activeJobs(run)]) {
      run = getRun(run.id);
      const job = (run.jobs || []).find((entry) => entry.nonce === originalJob.nonce);
      if (!job || !matchingNodeJob(run, job)) continue;
      if (job.promptRecovery?.state === 'sending') { // the worker restarted mid-typing: settle it from evidence (src/sending.mjs)
        const evidence = sendingEvidence({ job, agent: agents.find((entry) => entry.terminalId === job.terminalId), receipt: await receiptPresent(job) });
        if (!evidence) {
          job.promptRecovery.state = 'uncertain';
          job.promptRecovery.reason = '재시작 전에 저장된 프롬프트 전달 요청의 결과를 확인할 수 없습니다. 자동 재전송하지 않습니다.';
          markBlocked(run, job, job.promptRecovery.reason, true);
          continue;
        }
        Object.assign(job.promptRecovery, { state: 'sent', recoveredFrom: evidence });
        job.promptSeen = true;
        appendEvent(run, findNode(run, job.nodeId).title + ': 재시작 전에 입력 중이던 작업 지시가 전달됐음을 확인했습니다 (근거: ' + evidence + ').', now, { nodeId: job.nodeId, nonce: job.nonce });
      }
      if (['', 'confirm:', 'continue:'].some((key) => deliveryTasks.has(key + job.nonce))) continue; // a delivery task decides
      if (job.selfDelivery && !job.promptRecovery) continue; // nothing typed yet; the scheduler resumes delivery
      if (!job.terminalId) {
        markBlocked(run, job, '실행 요청의 응답이 불명확합니다. Orca 터미널을 확인하기 전에는 다시 배정하지 않습니다.', true);
        continue;
      }
      const agent = agents.find((entry) => entry.terminalId === job.terminalId);
      if (agent?.sessionId) job.sessionId = agent.sessionId;
      if (agent && agent.state !== 'done') {
        job.agentState = agent.state;
        if (['working', 'blocked'].includes(agent.state) && (!job.selfDelivery || job.promptRecovery)) job.promptSeen = true;
        if (job.state !== 'uncertain') job.state = 'running';
        continue;
      }
      // Typed seconds before a restart, no turn seen yet: the delivery check decides, as it would have.
      if (agent && job.selfDelivery && job.promptRecovery?.state === 'sent' && !job.promptSeen && !(await receiptPresent(job))) continue;
      if (agent?.state === 'done' || explicit) {
        await acceptReceipt(run, job, job.agentOutcome);
      } else {
        markBlocked(run, job, '기존 에이전트 터미널을 찾을 수 없습니다. 새로고침으로 결과를 확인하거나 명시적으로 재시도하세요.');
      }
    }
    return getRun(run.id);
  };
  const launchOne = async (run, action) => {
    const node = findNode(run, action.nodeId);
    const nonce = id();
    run = claimNode(run, node.id, { phase: action.phase, nonce, now: now() });
    replaceRun(run);
    const claimed = findNode(run, node.id);
    const attempt = claimed.active?.attempt ?? (action.phase === 'review' ? claimed.reviewAttempts : claimed.attempts);
    const directory = path.join(receiptRoot, safeSegment(run.id), safeSegment(node.id), safeSegment(String(attempt) + '-' + action.phase + '-' + nonce));
    const job = {
      runId: run.id, nodeId: node.id, nonce, phase: action.phase, attempt,
      agent: action.agent, workspaceId: run.workspaceId, terminalId: null,
      receiptDirectory: directory, receiptPath: path.join(directory, 'result.json'),
      startedAt: nowIso(now), state: 'launching', ...(stageBudget(node.id, action.phase) ? { budgetMinutes: stageBudget(node.id, action.phase) } : {})
    };
    run.jobs ||= [];
    run.jobs.push(job);
    claimed.active = { ...claimed.active, ...job };
    let hostRequested = false;
    try {
      if (action.phase === 'work') await verifySubmission(run, claimed);
      await createReceiptDirectory(directory);
      await adviseEcc(run, claimed, job);
      await adviseVisual(run, claimed, job);
      const git = claimed.write || action.phase === 'review' ? await readGit(run.workspacePath) : null;
      if (git && action.phase === 'work') job.startHead = git.head;
      if (action.phase === 'review') {
        claimed.active.sourceFingerprint = job.sourceFingerprint = await fingerprint(run.workspacePath);
        if (git) job.sourceCommit = git.head;
      }
      Object.assign(job, await parentEvidenceOf(run, () => job.sourceFingerprint ?? fingerprint(run.workspacePath))); // a follow-up run's parent evidence, fresh or stale (src/reuse.mjs)
      await persist({ durable: true }); // The nonce and intent must exist before the host can launch.
      hostRequested = true;
      // Never pass the prompt: Orca would type it too early, and twice once it fixes that.
      const expected = expectLaunchSettings(run, claimed, action);
      let launched;
      try { launched = await call('agent.launch', { workspaceId: run.workspaceId, agent: action.agent }); }
      finally { recordLaunchSettings(run, claimed, job, expected); }
      if (!launched?.terminalId) throw runtimeError('action_failed', 'Orca가 실행 터미널 ID를 반환하지 않았습니다.');
      job.terminalId = launched.terminalId;
      job.state = 'running';
      job.selfDelivery = true;
      run = recordLaunch(run, node.id, { nonce, terminalId: launched.terminalId, workspaceId: run.workspaceId, now: now() });
      replaceRun(run);
      await persist();
      startDelivery(run.id, nonce);
    } catch (error) {
      if (error.unsaved) { // nothing launched: undo the claim; the pump resumes once a save succeeds
        run = releaseClaim(getRun(run.id), node.id, { nonce, reason: error.message, now: now() });
        run.jobs = run.jobs.filter((entry) => entry.nonce !== nonce);
        replaceRun(run);
        return false;
      }
      const ambiguous = hostRequested && !['capability_denied', 'unknown_method', 'invalid_params', 'consent_required', 'not_permitted'].includes(error.code);
      run = markBlocked(getRun(run.id), job, '배정 실패: ' + safeError(error).message, ambiguous);
      if (!ambiguous) {
        const saved = run.jobs.find((entry) => entry.nonce === job.nonce);
        if (saved) saved.state = 'not-started';
      }
      appendEvent(run, '배정 실패 — 자동 재실행하지 않음', now, { nodeId: node.id });
      await persist();
    }
  };
  const receiptPresent = async (job) => {
    try { await readReceipt(job.receiptPath, job.receiptDirectory); return true; }
    catch (error) { return error.code !== 'ENOENT'; } // acceptReceipt reports a malformed receipt
  };
  const currentDeliveryJob = (runId, nonce) => {
    const run = state.runs.find((item) => item.id === runId);
    const job = run && activeJobs(run).find((entry) => entry.nonce === nonce);
    if (!job || ['cancelled', 'completed'].includes(run.status) || findNode(run, job.nodeId).active?.nonce !== nonce) return {};
    return { run, job };
  };
  const track = (key, nonce, work) => {
    if (deliveryTasks.has(key) || disposed) return;
    deliveryTasks.add(key);
    const task = Promise.resolve().then(work)
      .catch((error) => queue(() => failDelivery(nonce, error)))
      .catch((error) => orca.log?.('Toris Neon delivery: ' + safeError(error).message))
      .finally(() => { deliveryTasks.delete(key); background.delete(task); });
    background.add(task);
  };
  const failDelivery = async (nonce, error) => {
    const run = state.runs.find((item) => (item.jobs || []).some((job) => job.nonce === nonce));
    const job = run && activeJobs(run).find((entry) => entry.nonce === nonce);
    if (!job || !matchingNodeJob(run, job)) throw error;
    if (error?.unsaved) return; // nothing typed and nothing recorded: the pump delivers once a save succeeds
    // Once an intent exists, the prompt may have been typed: never offer a blind resend.
    markBlocked(run, job, '작업 지시 전달을 처리하지 못했습니다: ' + safeError(error).message + '. 터미널을 확인한 뒤 이 단계를 재시도하세요.', Boolean(job.promptRecovery));
    await persist();
  };
  // Ready means the agent in that terminal reported in: a status event or an agents.list row.
  const awaitReady = async (runId, nonce) => {
    for (let poll = 0; poll < READY_POLLS && !disposed; poll++) {
      const { run, job } = currentDeliveryJob(runId, nonce);
      if (!job || job.promptRecovery) return null;
      if (job.readyAt) return true;
      try {
        if ((await listAgents(run.workspaceId)).some((agent) => agent.terminalId === job.terminalId)) return true;
      } catch (error) {
        orca.log?.('Toris Neon readiness read failed, polling again: ' + safeError(error).message);
      }
      await sleep(READY_POLL_MS);
    }
    return false;
  };
  const startDelivery = (runId, nonce) => track(nonce, nonce, async () => {
    const ready = await awaitReady(runId, nonce);
    if (ready !== null) await queue(() => (ready ? deliverWhenReady(runId, nonce) : abandonUnready(runId, nonce)));
  });
  const startConfirmation = (runId, nonce) => track('confirm:' + nonce, nonce, async () => {
    await sleep(PROMPT_CONFIRM_MS);
    await queue(() => confirmDelivery(runId, nonce));
  });
  const focusJobTerminal = async (run, job) => { // src/delivery.mjs; throws before anything is typed
    await focusTerminal({ call, sleep, workspaceId: run.workspaceId, terminalId: job.terminalId, describe: (error) => safeError(error).message });
    job.focusedAt = nowIso(now);
  };
  /**
   * The single way a prompt is typed, for automatic delivery and manual recovery alike: open
   * the run's workspace, focus the job's terminal, persist a one-shot intent, type once.
   * Throws only before the intent exists, when nothing has been typed; afterwards it records
   * sent, rejected or uncertain and returns that record. Nothing here ever types twice.
   */
  const sendJobPrompt = async (run, node, job, { manual = false, continuation = false } = {}) => {
    if (job.phase === 'work') await verifySubmission(run, node);
    await focusJobTerminal(run, job);
    if (job.phase === 'review' && (!job.sourceFingerprint || await fingerprint(run.workspacePath) !== job.sourceFingerprint)) {
      throw runtimeError('conflict', '검토 배정 이후 소스가 변경됐습니다. 이전 검토 프롬프트를 전달하지 않았습니다.');
    }
    const blocker = await screenOf(job); // never type into a screen no prompt answers (hook review toggles trust)
    if (blocker) throw Object.assign(runtimeError('conflict', blocker.message), { notSent: true, blocker });
    // A continuation asks the agent that already received and started this assignment to finish it
    // after its turn died. It is not the assignment, so it has its own record and the one-shot
    // promptRecovery (the never-resent assignment) stays untouched.
    const decision = continuation === 'decision';
    const fix = continuation === 'report';
    if (!continuation && job.parentEvidence) job.parentEvidence = await recheckParentEvidence(job, () => fingerprint(run.workspacePath)); // reuse only what is still fresh now (src/reuse.mjs)
    const text = decision ? DECIDE_PROMPT : fix ? reportFixPrompt(job.reportFix.reason, job.receiptPath, job.reportFixes, { commit: job.reportFix.commit }) : continuation ? CONTINUE_PROMPT : await nodePrompt(run, node, job);
    const record = { state: 'sending', at: nowIso(now), terminalId: job.terminalId,
      ...(manual ? { acknowledgedEmpty: true } : {}), ...(continuation ? { count: job.continuations } : {}) };
    if (continuation) job.continuation = record;
    else job.promptRecovery = record;
    appendEvent(run, node.title + (decision ? ': 사람 대신 스스로 결정하고 마치도록 요청합니다 (' + job.decisionNudges + '/' + AUTONOMY_LIMITS.decisionNudgesPerJob + ').'
      : fix ? ': 같은 에이전트에게 보고서만 고치도록 요청합니다 (' + job.reportFixes + '/' + MAX_REPORT_FIXES + ').'
      : continuation ? ': 같은 에이전트에게 중단된 작업을 이어서 완료하도록 요청합니다 (' + job.continuations + '/' + MAX_CONTINUATIONS + ').'
      : manual ? '의 빈 터미널에 기존 프롬프트 전달 복구를 요청했습니다.' : ' 에이전트 터미널을 열고 작업 지시를 전달합니다.'), now, { nodeId: node.id, nonce: job.nonce, terminalId: job.terminalId });
    replaceRun(run);
    try { await persist({ durable: true }); } // One durable intent per nonce (or per continuation), before any typing.
    catch (error) { if (continuation) delete job.continuation; else delete job.promptRecovery; throw error; } // nothing typed
    let result;
    // Errors Orca throws before writing (src/delivery.mjs) are retried after focusing again; nothing was typed.
    for (let attempt = 0; result === undefined; attempt++) {
      try { result = (await call('terminal.sendText', { terminalId: job.terminalId, text, enter: true })) ?? null; break; }
      catch (error) {
        const verdict = classifySendError(error);
        if (verdict.sent !== false) { result = { error }; break; }
        const delay = verdict.retry ? SEND_RETRY_DELAYS_MS[attempt] : undefined;
        if (delay !== undefined) { appendEvent(getRun(run.id), node.title + ': Orca가 입력 전에 거부했습니다 (' + verdict.id + '). 아무것도 입력되지 않았으므로 ' + Math.round(delay / 1000) + '초 뒤 터미널을 다시 열고 다시 시도합니다 (' + (attempt + 1) + '/' + SEND_RETRY_DELAYS_MS.length + ').', now, { nodeId: node.id, nonce: job.nonce });
          await sleep(delay);
          try { await focusJobTerminal(run, job); continue; } catch (focusError) { error = focusError; } }
        if (continuation) delete job.continuation; else delete job.promptRecovery; // never typed: no record of a send
        await persist();
        throw Object.assign(runtimeError('action_failed', 'Orca가 입력 전에 작업 지시 전달을 거부했습니다 (' + (verdict.id ?? safeError(error).message) + '). 아무것도 입력되지 않았습니다.'), { notSent: true });
      }
    }
    if (result?.error) {
      const error = result.error;
      record.state = 'uncertain';
      record.reason = '프롬프트 전달 결과가 불명확합니다: ' + safeError(error).message + '. 자동으로 다시 보내지 않습니다.';
      appendEvent(markBlocked(getRun(run.id), job, record.reason, true), '전달 결과가 불명확해 자동 재전송을 중단했습니다.', now, { nodeId: node.id, nonce: job.nonce });
      await persist();
      return record;
    }
    if (result?.accepted !== true) {
      record.state = 'rejected';
      record.reason = 'Orca가 프롬프트 전달을 수락하지 않았습니다. 자동 또는 반복 전달하지 않습니다.';
      appendEvent(markBlocked(getRun(run.id), job, record.reason), record.reason, now, { nodeId: node.id });
      await persist();
      return record;
    }
    record.state = 'sent';
    record.acceptedAt = nowIso(now);
    const current = getRun(run.id);
    findNode(current, node.id).runtimeMessage = manual ? '프롬프트 전달 요청이 수락됐습니다. 완료 보고서로 실제 결과를 확인합니다.'
      : fix ? '같은 에이전트에게 보고서만 고치도록 요청했습니다 (' + job.reportFixes + '/' + MAX_REPORT_FIXES + '): ' + job.reportFix.reason : '';
    appendEvent(current, node.title + (continuation ? ': 이어서 완료하도록 요청을 전달했습니다.' : manual ? '의 기존 배정 프롬프트 전달 요청이 수락됐습니다.' : ' 에이전트 터미널을 열고 작업 지시를 전달했습니다.'), now, { nodeId: node.id, nonce: job.nonce });
    await persist();
    if (!continuation) startConfirmation(run.id, job.nonce);
    return record;
  };
  const failedTurnMessage = (job, next) => '에이전트의 턴이 오류(' + job.agentOutcome + ')로 끝났고 보고서가 없습니다. ' + next;
  // The prompt arrived and a turn of the stage agent ended with 'failure' and no report.
  const handleFailedTurn = (run, job) => {
    const node = findNode(run, job.nodeId);
    const count = job.continuations ?? 0;
    if (run.status === 'paused') return markBlocked(run, job, failedTurnMessage(job, '실행이 일시 정지 상태라 이어서 진행하도록 요청하지 않았습니다. 터미널에서 이어서 진행하거나 재개 후 이 단계를 재시도하세요.'));
    // Only a known delivery may be continued; an uncertain one is never followed by more typing.
    if (job.promptRecovery?.state !== 'sent') return markBlocked(run, job, failedTurnMessage(job, '작업 지시 전달 결과가 확실하지 않아 이어서 진행하도록 요청하지 않았습니다.'));
    if (count >= MAX_CONTINUATIONS) {
      return markBlocked(run, job, '에이전트의 턴이 오류(' + job.agentOutcome + ')로 ' + (count + 1) + '번 끝났습니다. 같은 에이전트에게 ' + count +
        '번 이어서 진행하도록 요청했지만 보고서를 저장하지 못했습니다. 네트워크·계정 상태를 확인한 뒤 이 단계를 재시도하세요.');
    }
    const delay = CONTINUE_DELAYS_MS[count];
    node.runtimeMessage = '에이전트 턴이 오류로 끝났습니다. ' + Math.round(delay / 1000) + '초 뒤 같은 에이전트에게 이어서 완료하도록 요청합니다 (' + (count + 1) + '/' + MAX_CONTINUATIONS + ').';
    appendEvent(run, node.title + ': ' + node.runtimeMessage, now, { nodeId: node.id, nonce: job.nonce });
    track('continue:' + job.nonce, job.nonce, async () => {
      await sleep(delay);
      await queue(() => continueTurn(run.id, job.nonce));
    });
  };
  const continueTurn = async (runId, nonce, kind = 'error') => {
    if (disposed) return;
    const { run, job } = currentDeliveryJob(runId, nonce);
    // A newer turn already started or ended differently: nothing to continue.
    if (!job || job.promptRecovery?.state !== 'sent') return;
    if (kind === 'error' ? job.agentOutcome !== 'failure' : kind === 'decision' && (FAILED_AGENT_OUTCOMES.has(job.agentOutcome) || job.agentState !== 'done')) return;
    if (run.status === 'paused') {
      markBlocked(run, job, failedTurnMessage(job, '실행이 일시 정지 상태라 이어서 진행하도록 요청하지 않았습니다.'));
      return persist();
    }
    if (kind !== 'report' && await receiptPresent(job)) {
      await acceptReceipt(run, job, job.agentOutcome);
      await persist();
      return schedulePump();
    }
    let agent;
    try { agent = (await listAgents(run.workspaceId)).find((entry) => entry.terminalId === job.terminalId); }
    catch (error) {
      markBlocked(run, job, failedTurnMessage(job, 'Orca 에이전트 상태를 읽지 못해 이어서 진행하도록 요청하지 않았습니다: ' + safeError(error).message));
      return persist();
    }
    if (!agent) {
      markBlocked(run, job, failedTurnMessage(job, '에이전트 터미널이 닫혀 이어서 진행할 수 없습니다. 이 단계를 재시도하세요.'));
      return persist();
    }
    if (kind === 'report' && ['waiting', 'blocked'].includes(agent.state)) { // never type into a prompt or permission dialog
      markBlocked(run, job, job.reportFix.reason + ' 에이전트가 입력을 기다리고 있어 보고서 수정을 요청하지 않았습니다.');
      return persist();
    }
    if (kind !== 'report' && ['working', 'blocked'].includes(agent.state)) return; // it carried on by itself
    if (kind === 'decision') job.decisionNudges = (job.decisionNudges ?? 0) + 1;
    else if (kind === 'report') job.reportFixes = (job.reportFixes ?? 0) + 1;
    else job.continuations = (job.continuations ?? 0) + 1;
    try { await sendJobPrompt(run, findNode(run, job.nodeId), job, { continuation: kind === 'error' ? true : kind }); }
    catch (error) {
      if (error.blocker) return blockOnScreen(getRun(runId), job, error.blocker);
      markBlocked(getRun(runId), job, failedTurnMessage(job, '이어서 진행 요청을 입력하지 못했습니다: ' + safeError(error).message));
      await persist();
    }
  };
  const deliverWhenReady = async (runId, nonce) => {
    if (disposed) return;
    const { run, job } = currentDeliveryJob(runId, nonce);
    if (!job || job.promptRecovery) return;
    try { await sendJobPrompt(run, findNode(run, job.nodeId), job); }
    catch (error) {
      if (error.blocker) return blockOnScreen(getRun(runId), job, error.blocker);
      if (error.notSent) return abandonUnready(runId, nonce, error.message); // like an undelivered prompt
      if (job.promptRecovery) throw error;
      markBlocked(getRun(runId), job, '작업 지시를 입력하지 않았습니다: ' + safeError(error).message + ' 터미널을 확인한 뒤 지시 전달 또는 재시도를 선택하세요.');
      await persist();
    }
  };
  // Nothing was typed into a terminal whose agent never reported in, so closing it and
  // launching again cannot duplicate work.
  const abandonUnready = async (runId, nonce, refused = null, screened = false) => {
    if (disposed) return;
    const { run, job } = currentDeliveryJob(runId, nonce);
    if (!job || job.promptRecovery) return;
    if (job.readyAt && !refused) return deliverWhenReady(runId, nonce);
    if (!refused && !screened) { // a start dialog holds the agent before it reports in: no blind relaunch
      const blocker = await screenOf(job), fresh = currentDeliveryJob(runId, nonce); // the run may have moved during the read
      if (blocker && !disposed && fresh.job && !fresh.job.promptRecovery) return blockOnScreen(fresh.run, fresh.job, blocker);
      return abandonUnready(runId, nonce, refused, true);
    }
    let closed = false, closeError = '';
    try { closed = (await call('terminal.close', { terminalId: job.terminalId }))?.closed === true; }
    catch (error) { closeError = ' (' + safeError(error).message + ')'; }
    if (!closed) {
      markBlocked(run, job, (refused ?? '에이전트가 준비되지 않아 작업 지시를 입력하지 않았습니다.') + ' 터미널을 닫지 못해' + closeError + ' 자동으로 다시 배정하지 않았습니다. 터미널을 닫은 뒤 이 단계를 다시 시도하세요.');
      return persist();
    }
    const retries = findNode(run, job.nodeId).deliveryRetries ?? 0;
    let next = releaseClaim(run, job.nodeId, { nonce: job.nonce, reason: (refused ? refused + ' ' : '에이전트가 준비되지 않아 ') + '터미널을 닫고 다시 배정합니다.', now: now() });
    const node = findNode(next, job.nodeId);
    node.deliveryRetries = retries + 1;
    node.runtimeMessage = '';
    const saved = next.jobs.find((entry) => entry.nonce === job.nonce);
    if (saved) saved.state = 'undelivered';
    if (retries >= MAX_PROMPT_DELIVERY_RETRIES) {
      next = blockNode(next, job.nodeId, { reason: (refused ? '작업 지시 입력이 ' + (retries + 1) + '번 연속 입력 전에 거부됐습니다 (' + refused + '). ' : '에이전트가 ' + (retries + 1) + '번 연속 준비되지 않아 작업 지시를 입력하지 못했습니다. ') + UNREADY_RETRY_SAFE, now: now() });
    }
    replaceRun(next);
    await persist();
    schedulePump();
  };
  // A typed prompt starts a turn. Without one the prompt may still be in the terminal, so the
  // stage is blocked as uncertain and nothing is resent automatically.
  const confirmDelivery = async (runId, nonce) => {
    if (disposed) return;
    const { run, job } = currentDeliveryJob(runId, nonce);
    if (!job || job.promptSeen || job.promptRecovery?.state !== 'sent') return;
    if (await receiptPresent(job)) {
      await acceptReceipt(run, job, job.agentOutcome);
      await persist();
      return schedulePump();
    }
    let agent;
    try { agent = (await listAgents(run.workspaceId)).find((entry) => entry.terminalId === job.terminalId); }
    catch (error) {
      markBlocked(run, job, '작업 지시 후 에이전트 상태를 확인하지 못했습니다: ' + safeError(error).message + '. 자동으로 다시 보내지 않습니다. 터미널을 확인한 뒤 재시도하세요.', true);
      return persist();
    }
    if (['working', 'blocked'].includes(agent?.state)) {
      job.promptSeen = true;
      delete findNode(run, job.nodeId).deliveryRetries;
      return persist();
    }
    const blocker = await screenOf(job); // typed into a modal: closing the terminal keeps it from ever running
    if (blocker) return blockOnScreen(run, job, blocker);
    markBlocked(run, job, '작업 지시를 입력했지만 에이전트가 작업을 시작했는지 확인되지 않았습니다. 자동으로 다시 보내지 않습니다. 터미널을 확인한 뒤 재시도하세요.', true);
    return persist();
  };
  // Shared by nodes.retry and the autonomous supervisor: run is a working copy; nothing is stored here.
  const retryStage = async (run, nodeId, { acknowledgeUncertain = false, stopPrevious = false } = {}) => {
    const node = findNode(run, nodeId);
    const previousJobs = activeJobs(run).filter((job) => job.nodeId === node.id);
    if (node.launchUncertain && !acknowledgeUncertain) {
      throw runtimeError('conflict', '이전 배정의 시작 여부가 불명확합니다. Orca 터미널을 확인한 뒤 acknowledgeUncertain=true로 명시적으로 재시도하세요.');
    }
    const candidate = retryNode(run, nodeId, { now: now() });
    const agents = previousJobs.some((job) => job.terminalId) ? await listAgents(run.workspaceId) : [];
    for (const job of previousJobs) {
      if (job.terminalId) {
        const running = agents.find((agent) => agent.terminalId === job.terminalId && agent.state !== 'done');
        if (running && !stopPrevious) throw runtimeError('conflict', '이전 에이전트가 아직 실행 중입니다. 먼저 종료하거나 stopPrevious=true로 재시도하세요.');
        if (running) {
          const closed = await call('terminal.close', { terminalId: job.terminalId });
          if (closed?.closed !== true) throw runtimeError('action_failed', '이전 에이전트 터미널의 종료를 확인하지 못했습니다. 재시도 작업을 시작하지 않았습니다.');
        }
      }
      const previous = candidate.jobs.find((entry) => entry.nonce === job.nonce);
      if (previous) previous.state = 'superseded';
    }
    const retried = findNode(candidate, nodeId);
    delete retried.pendingReceipt;
    delete retried.launchUncertain;
    delete retried.deliveryRetries;
    return candidate;
  };
  const supervisor = createSupervisor({
    getRun, replaceRun, retryStage: (run, nodeId) => retryStage(run, nodeId), now, allJobs: () => state.runs.flatMap((item) => item.jobs ?? []),
    appendEvent: (run, text, extra) => appendEvent(run, text, now, extra),
    notify: (title, body) => { void Promise.resolve().then(() => call('notifications.show', { title, body: body.slice(0, 900) })).catch((error) => orca.log?.('Toris Neon notification: ' + safeError(error).message)); }
  });
  let launchCursor = 0, limits = GLOBAL_LIMITS; // Neon-wide limits, refreshed from the settings on each pump
  const pump = async () => {
    if (disposed) return;
    // A cancel kept only in memory closes its agents once storage works again (src/cancel.mjs).
    for (const run of state.runs.filter((item) => item.cancelUnsaved && !persistence.failure())) await closeCancel(run);
    for (const entry of [...state.runs]) {
      let run = getRun(entry.id);
      if (run.autonomous && run.started && await supervisor.supervise(run.id)) {
        await persist();
        run = getRun(run.id);
      }
      if (!run.started || !['ready', 'running'].includes(run.status) || !run.workspaceId || !run.workspacePath) continue;
      // Deliveries interrupted by a worker restart: nothing typed yet, or typed but unconfirmed.
      for (const job of activeJobs(run)) {
        if (!job.selfDelivery || job.state !== 'running' || !job.terminalId) continue;
        if (!job.promptRecovery) startDelivery(run.id, job.nonce);
        else if (job.promptRecovery.state === 'sent' && !job.promptSeen) startConfirmation(run.id, job.nonce);
      }
    }
    limits = await readLimits(orca.settings); // settings maxActiveJobs/maxHeavyJobs; runs take turns (src/scheduler.mjs)
    for (let guard = 0; guard < 50 && !disposed; guard++) {
      const pick = nextLaunch(state.runs, { cursor: launchCursor, limits });
      if (!pick) break;
      launchCursor = pick.cursor;
      if (await launchOne(getRun(pick.runId), pick.action) === false) break;
    }
  };
  const schedulePump = () => {
    if (pumpQueued || disposed) return;
    pumpQueued = true;
    void queue(async () => {
      pumpQueued = false;
      await pump();
    }).catch((error) => { orca.log?.('Toris Neon scheduler: ' + safeError(error).message); });
  };
  const validateWorkspace = async (workspaceId, projectId) => {
    const { workspaces = [] } = await call('workspace.list', {});
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace || (projectId && workspace.projectId !== projectId)) {
      throw runtimeError('invalid_params', '선택한 프로젝트의 작업 공간을 찾을 수 없습니다.');
    }
    if (!isLocal(workspace)) throw runtimeError('not_permitted', '원격 작업 공간은 완료 파일을 로컬에서 검증할 수 없습니다. 로컬 프로젝트를 선택하세요.');
    if (!workspace.path || !path.isAbsolute(workspace.path)) throw runtimeError('invalid_params', '작업 공간의 절대 경로가 필요합니다.');
    return workspace;
  };
  const ensureWorkspace = async (run) => {
    if (run.workspaceId) {
      const workspace = await validateWorkspace(run.workspaceId, run.projectId);
      run.workspacePath = workspace.path;
      return run;
    }
    const { projects = [] } = await call('project.list', {});
    const project = projects.find((item) => item.id === run.projectId);
    if (!project || project.kind !== 'git') throw runtimeError('invalid_params', 'Orca에 등록된 Git 프로젝트를 선택하세요.');
    if (!isLocal(project)) throw runtimeError('not_permitted', '현재 결과 검증은 로컬 Git 프로젝트만 지원합니다.');
    await preflightRepository(run, project);
    if (run.workspaceCreation?.state === 'uncertain' || run.workspaceCreation?.state === 'creating') {
      const matches = await reservedWorkspaces(run);
      if (matches.length === 1 && isLocal(matches[0])) {
        run.workspaceId = matches[0].id;
        run.workspacePath = matches[0].path;
        run.workspaceCreation.state = 'created';
        appendEvent(run, '기존 생성 작업 공간을 복구했습니다.', now);
        return run;
      }
      if (matches.length > 0) throw runtimeError('conflict', '작업 공간 생성 응답이 불명확합니다. Orca에서 기존 생성 결과를 확인하세요. 중복 생성하지 않았습니다.');
      // Unlisted is not absent: create again only once the first is proven gone (src/wscreate.mjs).
      const refusal = await recreateRefusal({ trace: () => workspaceTrace(project.path, run.workspaceCreation.name), since: (run.workspaceCreation.uncertainAt ??= run.workspaceCreation.at ?? nowIso(now)), now: now() });
      if (refusal) throw runtimeError('conflict', refusal);
    }
    const name = 'neon-' + run.id.slice(-12);
    run.workspaceCreation = { state: 'creating', name, at: nowIso(now) };
    await persist();
    try {
      const result = await call('workspace.create', {
        projectId: run.projectId, name,
        ...(run.baseBranch ? { baseBranch: run.baseBranch } : {}), open: false
      });
      if (!result.workspaceId) throw runtimeError('action_failed', '새 작업 공간 ID를 받지 못했습니다.');
      run.workspaceId = result.workspaceId;
      run.workspaceCreation.state = 'created';
      run.runtimeMessage = '';
      await persist();
      const workspace = await validateWorkspace(run.workspaceId, run.projectId);
      run.workspacePath = workspace.path;
      return run;
    } catch (error) {
      if (run.workspaceId) {
        run.workspaceCreation.state = 'created';
        run.status = 'blocked';
        run.runtimeMessage = safeError(error).message;
        await persist();
        throw error;
      }
      throw await recordCreateFailure(run, error);
    }
  };
  const reservedWorkspaces = async (run) => {
    const { workspaces = [] } = await call('workspace.list', {});
    return workspaces.filter((item) => item.projectId === run.projectId && item.name === run.workspaceCreation.name);
  };
  // Orca maps the real cause of a failed create to "Orca could not complete this action" and
  // keeps it in its log, so the plugin checks the repository itself before asking.
  const preflightRepository = async (run, project) => {
    let repository;
    try { repository = await inspectRepository(project.path, run.baseBranch); }
    catch (error) {
      appendEvent(run, '저장소 사전 확인을 건너뛰고 Orca에 생성을 요청합니다: ' + safeError(error).message, now);
      return;
    }
    const message = preflightMessage(repository, run.baseBranch);
    if (!message) return;
    run.runtimeMessage = message;
    appendEvent(run, '작업 공간 생성 전 확인: ' + message, now);
    await persist();
    throw runtimeError('invalid_params', message);
  };
  // A create that rejected definitively and left no workspace of the reserved name is retryable
  // with the same start button; only a create that may have landed offers attachment.
  const recordCreateFailure = async (run, error) => {
    const reason = safeError(error);
    let matches = null, listFailure = '';
    try { matches = await reservedWorkspaces(run); }
    catch (listError) { listFailure = ' 작업 공간 목록도 확인하지 못했습니다: ' + safeError(listError).message + '.'; }
    const definite = matches?.length === 0 && !AMBIGUOUS_HOST_CODES.has(reason.code);
    Object.assign(run.workspaceCreation, { state: definite ? 'failed' : 'uncertain', uncertainAt: nowIso(now) });
    run.status = 'blocked';
    run.runtimeMessage = definite
      ? 'Orca가 작업 공간을 만들지 못했습니다 (' + reason.code + ': ' + reason.message + '). 만들어진 작업 공간은 없으므로 원인을 해결한 뒤 같은 시작 버튼으로 다시 시도하세요. 자세한 원인은 Orca 플러그인 로그에 있습니다.'
      : '작업 공간 생성 응답이 불명확합니다 (' + reason.code + ': ' + reason.message + ').' + listFailure + ' Orca에서 ' + run.workspaceCreation.name + ' 작업 공간이 만들어졌는지 확인하세요.';
    appendEvent(run, run.runtimeMessage, now);
    await persist();
    return definite ? runtimeError(reason.code, run.runtimeMessage) : error;
  };

  const handlers = {
    'state.get': async (input = {}) => {
      // Read-only views must remain responsive while a serialized host launch is
      // pending. Every visible launch intent has already been reserved in state.
      const names = ['project.list', 'workspace.list', 'workspace.readContext', 'agents.list'];
      const results = await Promise.allSettled(names.map((name) => catalogRead(name, input.forceHost === true)));
      const value = (index, key, fallback) => results[index].status === 'fulfilled' ? (key ? results[index].value?.[key] ?? fallback : results[index].value) : fallback;
      return {
        ...projectState(state, input.view, limits), projects: value(0, 'projects', []), workspaces: value(1, 'workspaces', []),
        context: value(2, null, null), agents: value(3, 'agents', []), providers: PROVIDERS, eccAgents: await eccChoices(),
        autonomyLimits: AUTONOMY_LIMITS,
        launchOptions: { efforts: EFFORTS, visualStages: VISUAL_STAGES, visualDefault: VISUAL_DEFAULT },
        warnings: [...results.flatMap((result, index) => result.status === 'rejected' ? [names[index] + ': ' + safeError(result.reason).message] : []),
          ...(persistence.failure() ? ['실행 상태를 저장하지 못했습니다 (' + persistence.failure().attempts + '회): ' + persistence.failure().message + '. 메모리에서 계속 진행하며 자동으로 다시 저장합니다.'] : [])]
      };
    },
    'artifacts.read': artifactReader({ runs: () => [...state.runs, ...state.archivedRuns], receiptRoot }), // lazy, one file, never pushed
    'runs.get': async (input = {}) => [...state.runs, ...state.archivedRuns].find(entry => entry.id === input.runId) ??
      (() => { throw runtimeError('invalid_params', '실행을 찾을 수 없습니다.'); })(),
    'runs.create': (input = {}) => queue(async () => {
      const key = requestKey(input); // the same requestId or diagnosis candidate returns the run it already made
      const existing = key && [...state.runs, ...state.archivedRuns, ...requests.list()].find((item) => item.requestId === key && (key.startsWith('req:') || item.status !== 'cancelled'));
      if (existing?.pruned) throw runtimeError('conflict', '이 요청은 이미 실행 ' + existing.id + '(' + existing.status + ')을(를) 만들었고, 그 기록은 보관 한도로 정리됐습니다. 다시 만들지 않습니다. 새 요청이면 새 requestId를 쓰세요.');
      if (existing) return clone(existing);
      if (state.runs.length >= MAX_RUNS) throw runtimeError('too_large', '최대 40개 실행을 보관합니다. 기존 실행을 완료한 뒤 보관 정리를 진행하세요.');
      const plan = await planRunInput(input, { call, inspectRepository, readPlayApp, settings: orca.settings, runs: [...state.runs, ...state.archivedRuns] });
      const { goal, projectId } = plan;
      const run = createRun({
        id: id(), goal, projectId, assignments: input.assignments || {},
        maxConcurrency: input.maxConcurrency ?? 2, maxAttempts: input.maxAttempts ?? 3,
        maxRepairLoops: input.maxRepairLoops ?? 3,
        nodes: plan.nodes, now: now()
      });
      Object.assign(run, plan.extra, key ? { requestId: key } : {});
      run.isolate = input.isolate !== false;
      run.autonomous = input.autonomous !== false; // new runs go on without a person unless asked
      if (input.baseBranch) {
        run.baseBranch = requireString(input.baseBranch, '기준 브랜치', 128);
        if (!/^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/.test(run.baseBranch)) throw runtimeError('invalid_params', '기준 브랜치 이름이 올바르지 않습니다.');
      }
      if (!run.isolate) {
        const workspace = await validateWorkspace(requireString(input.workspaceId, '기존 작업 공간', 256), projectId);
        run.workspaceId = workspace.id;
        run.workspacePath = workspace.path;
      }
      run.jobs = [];
      run.started = false;
      appendEvent(run, '실행 계획을 생성했습니다. 시작하면 실제 에이전트가 배정됩니다.', now);
      state.runs.push(run);
      await persist();
      return clone(run);
    }),
    'runs.attachWorkspace': (input) => queue(async () => {
      let run = clone(getRun(input.runId));
      if (run.workspaceId || run.workspaceCreation?.state !== 'uncertain' || (run.jobs || []).length) {
        throw runtimeError('conflict', '시작 결과가 불명확한 작업 공간 생성만 기존 공간에 연결할 수 있습니다. 배정된 작업이 없어야 합니다.');
      }
      if (['completed', 'cancelled'].includes(run.status)) throw runtimeError('conflict', '종료된 실행에는 작업 공간을 연결할 수 없습니다.');
      const workspace = await validateWorkspace(requireString(input.workspaceId, '복구 작업 공간', 256), run.projectId);
      const { projects = [] } = await call('project.list', {});
      const project = projects.find((item) => item.id === run.projectId);
      if (workspace.name !== run.workspaceCreation.name || !project || workspace.path === project.path) {
        throw runtimeError('conflict', '예약된 이름(' + run.workspaceCreation.name + ')으로 만들어진 작업 공간만 연결할 수 있습니다. 프로젝트 원본 체크아웃이나 다른 공간에서는 실행하지 않습니다.');
      }
      run.workspaceId = workspace.id;
      run.workspacePath = workspace.path;
      run.workspaceCreation = {
        ...run.workspaceCreation, state: 'created', confirmedAt: nowIso(now),
        confirmedWorkspaceId: workspace.id, recovery: 'user-attachment'
      };
      run.started = false;
      run.runtimeMessage = '';
      run = pauseRun(run, { now: now(), reason: '사용자가 확인한 기존 작업 공간을 연결했습니다. 재개를 누르기 전에는 에이전트를 배정하지 않습니다.' });
      appendEvent(run, '불명확한 생성 요청을 기존 작업 공간으로 복구했습니다: ' + workspace.name, now, { workspaceId: workspace.id });
      replaceRun(run); await persist(); return clone(run);
    }),
    'runs.archive': (input) => queue(async () => {
      const run = getRun(input.runId);
      if (!['completed', 'cancelled'].includes(run.status) || activeJobs(run).length || (run.stopFailures || []).length || run.nodes.some((node) => node.active)) {
        throw runtimeError('conflict', '완료 또는 취소된 실행 중 활성 작업과 터미널 종료 오류가 없는 실행만 보관할 수 있습니다.');
      }
      const full = clone(run);
      appendEvent(full, '완료된 실행을 보관했습니다. 보고서 원문은 실행 결과 폴더에 남아 있습니다.', now);
      const archivedRun = archiveRun(full, nowIso(now)); // trimmed; the oldest archives go once their byte budget is spent
      const { kept, dropped } = retainArchives([...state.archivedRuns, archivedRun]);
      state.archivedRuns = kept;
      state.runs = state.runs.filter((entry) => entry.id !== run.id);
      await persist();
      await requests.remember(dropped, nowIso(now)); // a late redelivery of their requests must not make a second run
      return { archived: true, runId: run.id, archivedRun: clone(archivedRun) };
    }),
    'runs.start': (input) => queue(async () => {
      let run = getRun(input.runId); expectRevision(run, input); // inside the queue: nothing changes it between check and start
      if (run.status === 'cancelled' || run.status === 'completed') throw runtimeError('conflict', '종료된 실행은 다시 시작할 수 없습니다.');
      run = await ensureWorkspace(run);
      replaceRun(run);
      run = resumeRun(run, { now: now() });
      run.started = true;
      replaceRun(run);
      await persist();
      schedulePump();
      return clone(run);
    }),
    'runs.pause': (input) => queue(async () => {
      const run = pauseRun(getRun(input.runId), { now: now(), reason: '새 배정 일시 중지. 이미 실행 중인 에이전트는 계속 진행합니다.' });
      replaceRun(run); await persist(); return clone(run);
    }),
    'runs.resume': (input) => queue(async () => {
      let run = getRun(input.runId); expectRevision(run, input);
      if (run.status === 'cancelled' || run.status === 'completed') throw runtimeError('conflict', '종료된 실행은 재개할 수 없습니다.');
      run = await ensureWorkspace(run);
      run = await reconcile(run, true);
      run = resumeRun(run, { now: now() });
      run.started = true;
      replaceRun(run); await persist(); schedulePump(); return clone(run);
    }),
    'runs.refresh': (input) => queue(async () => {
      const current = getRun(input.runId);
      if (['cancelled', 'completed'].includes(current.status)) return clone(current);
      let run = await reconcile(current, true);
      replaceRun(run); await persist(); schedulePump(); return clone(run);
    }),
    'runs.approve': (input) => queue(async () => {
      const note = requireString(input.note || '사용자가 패널에서 단계 결과를 확인하고 승인했습니다.', '승인 근거', 2000);
      const original = getRun(input.runId);
      const scope = await approvalScope(original, input, { resolvePlayAccount, fingerprint }); // submission or product catalog (src/approval.mjs)
      const run = approveNode(original, input.nodeId, { note, now: now() });
      if (Object.keys(scope).length) findNode(run, input.nodeId).approval = { ...findNode(run, input.nodeId).approval, ...scope };
      if (scope.productCatalog) delete run.autonomy?.stopped; // the person acted on what autonomy stopped for
      replaceRun(run); await persist(); schedulePump(); return clone(run);
    }),
    'runs.updateAssignments': (input) => queue(async () => {
      const run = applyAssignments(clone(getRun(input.runId)), input.assignments); // src/assignments.mjs
      appendEvent(run, '단계별 에이전트 배정을 변경했습니다.', now);
      replaceRun(run); await persist(); return clone(run);
    }),
    // The person says an avoided agent works again: stages not yet started go back to it (src/fallback.mjs).
    'runs.restoreAgent': (input) => queue(async () => {
      const run = clone(getRun(input.runId));
      if (typeof input.agent !== 'string' || !Object.hasOwn(run.avoided ?? {}, input.agent)) throw runtimeError('conflict', '이 실행이 피하고 있는 에이전트가 아닙니다.');
      const restored = restoreAgent(run, input.agent, { at: nowIso(now), why: '사용자가 다시 쓰기로 함' });
      appendEvent(run, input.agent + '를 다시 씁니다. 아직 시작하지 않은 단계를 원래 배정으로 되돌렸습니다' + (restored.length ? ': ' + restored.join(', ') : ' (되돌릴 단계 없음)') + '.', now);
      replaceRun(run); await persist(); schedulePump(); return clone(run);
    }),
    // 여기까지만: skip the release stages nobody started (src/scope.mjs); the run completes once test passes.
    'runs.skipRelease': (input) => queue(async () => {
      const run = skipReleaseStages(clone(getRun(input.runId)), { now: nowIso(now) });
      replaceRun(run); await persist(); schedulePump(); return clone(run);
    }),
    'nodes.deliverPrompt': (input) => queue(async () => {
      if (input.acknowledgeUnsent !== true) {
        throw runtimeError('invalid_params', '해당 터미널이 비어 있고 아직 프롬프트가 전달되지 않았음을 직접 확인해야 합니다.');
      }
      let run = clone(getRun(input.runId));
      if (['completed', 'cancelled'].includes(run.status)) throw runtimeError('conflict', '종료된 실행에는 프롬프트를 전달할 수 없습니다.');
      const node = findNode(run, input.nodeId);
      checkExpectedNonce(node, input.expectedNonce);
      const job = (run.jobs || []).find((entry) => entry.nonce === node.pendingReceipt?.nonce);
      if (node.status !== 'blocked' || node.active || !node.pendingReceipt || !job?.terminalId ||
          job.state !== 'awaiting-report' || job.nodeId !== node.id || job.workspaceId !== run.workspaceId) {
        throw runtimeError('conflict', '보고서 대기 중인 중단 단계의 기존 소유 터미널만 전달 복구할 수 있습니다.');
      }
      if (job.promptRecovery) throw runtimeError('conflict', '이 배정의 프롬프트 전달 복구는 이미 요청했습니다. 결과가 불명확해도 재전송하지 않습니다.');
      // A session id is not evidence of a prompt (Claude reports one when idle and ready); a turn is.
      if (job.promptSeen) throw runtimeError('conflict', '이미 작업을 시작한 기록이 있는 배정에는 프롬프트를 다시 전달할 수 없습니다.');
      try {
        await readReceipt(job.receiptPath, job.receiptDirectory);
        throw runtimeError('conflict', '결과 보고서가 이미 있습니다. 전달 복구 대신 새로고침으로 결과를 확인하세요.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const agents = await listAgents(run.workspaceId);
      const agent = agents.find((entry) => entry.terminalId === job.terminalId);
      if (!agent || agent.agent !== job.agent || !['done', 'waiting'].includes(agent.state)) {
        throw runtimeError('conflict', '같은 종류의 빈 에이전트가 대기/종료 상태인 경우만 복구할 수 있습니다. 진행 중인 작업에는 전송하지 않습니다.');
      }
      // Reserve the stage again in this copy; sendJobPrompt stores it with the one-shot intent.
      job.state = 'running';
      node.active = { ...node.pendingReceipt, ...job };
      node.status = job.phase === 'review' ? 'review' : 'running';
      node.failureReason = null;
      node.runtimeMessage = '확인된 빈 터미널에 기존 배정 프롬프트를 한 번 전달합니다.';
      delete node.pendingReceipt;
      delete node.launchUncertain;
      if (run.status !== 'paused') run.status = 'running';
      const record = await sendJobPrompt(run, node, job, { manual: true });
      if (record.state !== 'sent') throw runtimeError('action_failed', record.reason);
      return clone(getRun(run.id));
    }),
    'nodes.retry': (input) => queue(async () => {
      let original = clone(getRun(input.runId));
      checkExpectedNonce(findNode(original, input.nodeId), input.expectedNonce);
      const plan = await planManualRefund(original, input.nodeId, { evidenceOf }); // a stage at its limit, once (src/refund.mjs)
      const refund = plan?.nonces ? giveBack(original, input.nodeId, plan.nonces, NO_WORK, true) : null;
      let run;
      try { run = await retryStage(refund?.run ?? original, input.nodeId, { acknowledgeUncertain: input.acknowledgeUncertain === true, stopPrevious: input.stopPrevious === true }); }
      catch (error) { throw error.code === 'attempt_limit' && plan?.refused ? runtimeError('attempt_limit', error.message + ' ' + plan.refused) : error; }
      replaceRun(run); await persist(); schedulePump();
      return { ...clone(run), ...(refund ? { attemptRefund: { count: refund.count, message: refund.message } } : {}) };
    }),
    'runs.setAutonomous': (input) => queue(async () => {
      if (typeof input?.enabled !== 'boolean') throw runtimeError('invalid_params', 'enabled 값은 true 또는 false여야 합니다.');
      const run = clone(getRun(input.runId));
      run.autonomous = input.enabled;
      if (input.enabled) delete run.autonomy?.stopped;
      appendEvent(run, input.enabled ? '자율 진행을 켰습니다. 사람 없이 재시도·승인·재개를 진행합니다(외부 제출 제외).' : '자율 진행을 껐습니다. 멈춘 단계는 사용자가 처리합니다.', now);
      replaceRun(run); await persist(); schedulePump(); return clone(run);
    }),
    'runs.setTerminalCleanup': (input) => queue(async () => {
      if (typeof input?.enabled !== 'boolean') throw runtimeError('invalid_params', 'enabled 값은 true 또는 false여야 합니다.');
      const run = { ...clone(getRun(input.runId)), closeFinishedTerminals: input.enabled };
      appendEvent(run, input.enabled ? '끝난 작업의 에이전트 터미널을 자동으로 닫습니다(세션은 다시 열 수 있습니다).' : '끝난 작업의 에이전트 터미널을 열어 둡니다.', now);
      replaceRun(run); await persist(); return clone(run);
    }),
    'runs.cancel': (input) => queue(async () => {
      let run = getRun(input.runId);
      if (run.status === 'completed' || (run.status === 'cancelled' && !activeJobs(run).length && !(run.stopFailures || []).length)) return clone(run);
      run = replaceRun(cancelRun(run, { now: now(), reason: '사용자가 실행을 취소했습니다.' })); // no new stage from here on
      return clone(await closeCancel(run)); // the intent is durable before any terminal closes (src/cancel.mjs)
    }),
    'jobs.releaseUncertain': (input = {}) => queue(async () => { // a person confirmed no agent runs for it (src/slotrelease.mjs)
      const { run, message, nodeId } = releaseUncertainJob(getRun(input.runId), { ...input, at: nowIso(now) });
      appendEvent(run, message, now, { nodeId }); replaceRun(run); await persist(); schedulePump(); return clone(run);
    }),
    'terminals.focus': async (input) => {
      const owned = state.runs.some((run) => run.jobs?.some((job) => job.terminalId === input.terminalId));
      if (!owned) throw runtimeError('invalid_params', '이 플러그인이 배정한 터미널만 열 수 있습니다.');
      return call('terminal.focus', { terminalId: input.terminalId });
    },
    'workspace.open': async (input) => {
      await validateWorkspace(input.workspaceId);
      return call('workspace.open', { workspaceId: input.workspaceId });
    }
  };

  // One agent status: an Orca event, or one the periodic watch read from agents.list.
  async function onAgentStatus(event) {
    invalidateCatalog('agents.list', 'workspace.list', 'workspace.readContext');
    if (!event || typeof event.terminalId !== 'string' || !['working', 'blocked', 'waiting', 'done'].includes(event.state)) return;
    let changed = false;
    for (const original of [...state.runs]) {
      let run = getRun(original.id);
      if (['cancelled', 'completed'].includes(run.status)) continue;
      const job = activeJobs(run).find((candidate) => candidate.terminalId && candidate.terminalId === event.terminalId);
      if (!job || !matchingNodeJob(run, job)) continue;
      const receivedAt = Number.isFinite(event.receivedAt) ? event.receivedAt
        : Number.isFinite(event.mainAgent?.stateStartedAt) ? event.mainAgent.stateStartedAt : null;
      if (receivedAt !== null && (receivedAt < Date.parse(job.startedAt) ||
          receivedAt < (job.lastAgentEventAt ?? -Infinity))) continue;
      const sessionId = typeof event.sessionId === 'string' && event.sessionId ? event.sessionId : job.sessionId;
      const incomingOutcome = typeof event.mainAgent?.outcome === 'string' ? event.mainAgent.outcome : undefined;
      // An outcome belongs to one turn: 'working' starts a new turn and clears it, the newest
      // finished turn replaces it, and an outcome-less status keeps the last one.
      const newTurn = event.state === 'working';
      const outcome = newTurn ? undefined : incomingOutcome ?? job.agentOutcome;
      const semanticChange = job.agentState !== event.state || job.sessionId !== sessionId || job.agentOutcome !== outcome;
      if (receivedAt !== null) job.lastAgentEventAt = receivedAt;
      if (!semanticChange) continue;
      if (sessionId !== undefined) job.sessionId = sessionId;
      job.agentState = event.state;
      // Any report from the terminal's agent means it is up and can be typed into.
      if (job.selfDelivery && !job.readyAt) job.readyAt = nowIso(now);
      // Before the plugin types the prompt, no state or outcome can be about this job.
      const typed = !job.selfDelivery || Boolean(job.promptRecovery);
      if (typed) {
        if (outcome === undefined) delete job.agentOutcome;
        else job.agentOutcome = outcome;
        if (incomingOutcome !== undefined && !newTurn) {
          if (FAILED_AGENT_OUTCOMES.has(incomingOutcome)) job.failedAt = receivedAt ?? now();
          else delete job.continuations; // a turn that ended well is progress
        }
      }
      // Only a prompt starts a turn: working, blocked or a turn outcome prove it arrived.
      if (typed && (['working', 'blocked'].includes(event.state) || outcome !== undefined)) {
        job.promptSeen = true;
        delete findNode(run, job.nodeId).deliveryRetries;
      }
      changed = true;
      if (run.autonomous && typed && event.state === 'blocked') {
        supervisor.notifyOnce(run, 'permission:' + job.nonce, 'Toris Neon: 에이전트가 확인을 기다립니다',
          findNode(run, job.nodeId).title + ' 에이전트가 권한·로그인 확인 화면에서 멈췄습니다. 플러그인이 대신 답할 수 없으니 터미널을 확인하세요.');
      }
      // An idle done before typing is the ready signal, not a finished job.
      if (event.state !== 'done' || !typed) continue;
      // Typed but no turn seen yet: the confirmation check decides unless a receipt exists.
      if (job.selfDelivery && !job.promptSeen && !(await receiptPresent(job))) continue;
      if (job.agentOutcome === 'failure' && job.promptSeen && findNode(run, job.nodeId).active?.nonce === job.nonce &&
          !(await receiptPresent(job))) {
        handleFailedTurn(run, job);
        continue;
      }
      // Autonomous: a clean turn without a report usually ended on a question; nobody will answer it.
      if (run.autonomous && job.promptSeen && !FAILED_AGENT_OUTCOMES.has(job.agentOutcome) && findNode(run, job.nodeId).active?.nonce === job.nonce &&
          (job.decisionNudges ?? 0) < AUTONOMY_LIMITS.decisionNudgesPerJob && !(await receiptPresent(job))) {
        findNode(run, job.nodeId).runtimeMessage = '에이전트가 보고서 없이 턴을 마쳤습니다. 스스로 결정하고 마치도록 요청합니다.';
        track('continue:' + job.nonce, job.nonce, async () => {
          await sleep(DECISION_NUDGE_DELAY_MS);
          await queue(() => continueTurn(run.id, job.nonce, 'decision'));
        });
        continue;
      }
      await acceptReceipt(run, job, job.agentOutcome);
    }
    if (changed) { await persist(); schedulePump(); }
  }
  // A missed 'done' event must not strand a run: every couple of minutes, jobs that were typed and
  // are still current are compared with agents.list and their receipt (src/watch.mjs).
  const applyWatch = async (runId, actions) => {
    for (const action of actions) {
      const run = state.runs.find((item) => item.id === runId);
      const job = run && activeJobs(run).find((entry) => entry.nonce === action.nonce);
      if (!job || !matchingNodeJob(run, job)) continue;
      if (action.kind === 'status') { await onAgentStatus(action.event); continue; }
      const node = findNode(run, job.nodeId);
      if (action.kind === 'report') {
        orca.log?.('Toris Neon watch: ' + node.title + ' 보고서를 상태 이벤트 없이 찾아 반영합니다.');
        await acceptReceipt(run, job, job.agentOutcome);
      } else if (action.kind === 'idle') { // an ended turn nobody followed up: the same path as a done
        if (run.autonomous && (job.decisionNudges ?? 0) < AUTONOMY_LIMITS.decisionNudgesPerJob) await continueTurn(run.id, job.nonce, 'decision');
        else await acceptReceipt(run, job, job.agentOutcome);
      } else {
        const body = node.title + ' 에이전트가 ' + action.idleMinutes + '분째 ' + (action.state === 'blocked' ? '권한·로그인 확인' : '입력이나 권한 확인') + '을 기다립니다. 플러그인이 대신 답할 수 없으니 터미널을 확인하세요.';
        if (!supervisor.notifyOnce(run, 'permission:' + job.nonce, 'Toris Neon: 에이전트가 확인을 기다립니다', body)) continue;
        node.runtimeMessage = body;
        appendEvent(run, body, now, { nodeId: node.id });
      }
      await persist();
      schedulePump();
    }
  };
  // Token usage rides the same timer: one agent.listSessions per active workspace (src/usage.mjs).
  const watch = createJobWatch({ afterPass: runtimeUsageSync({ host: orca.host, runs: () => [...state.runs, ...state.archivedRuns], queue, persist, at: () => nowIso(now), log: (line) => orca.log?.(line) }),
    now, log: (line) => orca.log?.(line), listAgents: (workspaceId) => listAgents(workspaceId),
    receiptAt: async (job) => { if (!(await receiptPresent(job))) return false; try { return await receiptWrittenAt(job.receiptPath); } catch { return null; } },
    apply: (runId, actions) => queue(() => applyWatch(runId, actions)),
    watched: () => state.runs.filter((run) => !['cancelled', 'completed'].includes(run.status)).map((run) => ({
      runId: run.id, workspaceId: run.workspaceId,
      jobs: activeJobs(run).filter((job) => job.state === 'running' && job.terminalId && findNode(run, job.nodeId).active?.nonce === job.nonce &&
        (!job.selfDelivery || job.promptRecovery?.state === 'sent') && !['', 'confirm:', 'continue:'].some((key) => deliveryTasks.has(key + job.nonce)))
    }))
  });

  // Finished jobs' terminals close after a grace period (src/cleanup.mjs); sessions stay resumable.
  const recordCleanup = cleanupRecorder({ log: (line) => orca.log?.(line), at: () => nowIso(now), where: (run, job) => (findNode(run, job.nodeId)?.title ?? job.nodeId) + ' ' + (job.phase === 'review' ? '검토' : '작업'),
    appendEvent: (run, text, extra) => appendEvent(run, text, now, extra) });
  const cleanup = createTerminalCleanup({ now, runs: () => state.runs, record: recordCleanup, close: (terminalId) => call('terminal.close', { terminalId }),
    listTerminals: (workspaceId) => call('terminal.list', { workspaceId }), listAgents: (workspaceId) => listAgents(workspaceId) });
  const runCleanup = async (startup = false) => {
    const summary = await cleanup.sweep();
    if (startup && describeSweep(summary)) orca.log?.('Toris Neon cleanup: 시작 점검 — ' + describeSweep(summary));
    if (['closed', 'gone', 'kept', 'failed'].some((key) => summary[key].length)) await persist();
    return summary;
  };
  let cleanupTimer = null;

  async function initialize() {
    const loaded = await persistence.load(); // an unreadable layout throws here; nothing is overwritten
    state = loaded.state;
    await requests.load();
    for (const runId of await cancelMarks.apply(state, now())) orca.log?.('Toris Neon storage: 재시작 전에 저장하지 못한 실행 ' + runId + '의 취소를 적용했습니다.');
    state.build = buildInfo ? { ...buildInfo, label: buildLabel(buildInfo) } : null;
    const migration = loaded.migration;
    if (migration) orca.log?.('Toris Neon storage: ' + (migration.ok
      ? '이전 단일 값(' + migration.before + '바이트)을 실행별 값으로 옮기고 확인한 뒤 삭제했습니다: 실행 ' + migration.runs + '개, 보관 ' + migration.archived + '개 (' + migration.after + '바이트)' + (migration.droppedArchives ? ', 오래된 보관 ' + migration.droppedArchives + '개 정리' : '') + '.'
      : '실행별 값으로 옮기지 못해 이전 단일 값을 그대로 두고 그 내용으로 계속합니다: ' + migration.error));
    for (const problem of loaded.problems) orca.log?.('Toris Neon storage: ' + problem);
    await queue(async () => {
      for (const entry of [...state.runs]) {
        if (activeJobs(getRun(entry.id)).length) await reconcile(getRun(entry.id), true);
        // Pause after the startup check: it may have made a blocked run runnable again.
        const run = getRun(entry.id);
        // Autonomous runs continue on their own once reconciled; the scheduler never relaunches a live job.
        if (!run.autonomous && ['running', 'ready'].includes(run.status) && (run.workspaceId || activeJobs(run).length)) {
          replaceRun(pauseRun(run, { now: now(), reason: '작업자가 다시 시작되었습니다. 활성 에이전트는 유지되며 재개를 누르면 다음 단계를 배정합니다.' }));
        }
      }
      await persist();
    });
    if (state.runs.some((run) => run.autonomous)) schedulePump();
    if (orca.events?.on) {
      subscriptions.push(orca.events.on('agent.status.changed', (event) => queue(() => onAgentStatus(event))
        .catch((error) => orca.log?.('Toris Neon event: ' + safeError(error).message))));
      subscriptions.push(orca.events.on('workspace.changed', () => {
        invalidateCatalog('project.list', 'workspace.list', 'workspace.readContext', 'agents.list');
      }));
    }
    watch.start(watchIntervalMs);
    // Closing many terminals takes seconds; Orca stops a worker not ready within 10 s, so never wait here.
    void queue(() => runCleanup(true)).catch((error) => orca.log?.('Toris Neon cleanup: ' + safeError(error).message));
    if (cleanupIntervalMs > 0) cleanupTimer = setInterval(() => { void queue(() => runCleanup()).catch((error) => orca.log?.('Toris Neon cleanup: ' + safeError(error).message)); }, cleanupIntervalMs);
    cleanupTimer?.unref?.();
    return api;
  }
  const api = {
    initialize, receiptRoot, prunedRequests: () => requests.list(),
    handlers: Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (input) => jsonValue(await handler(input))])),
    getState: (input = {}) => jsonValue(projectState(state, input.view, limits)),
    drain: async () => {
      let pending;
      do { pending = chain; await pending; await Promise.all([...background]); } while (pending !== chain || background.size);
    },
    dispose: () => { disposed = true; watch.stop(); clearInterval(cleanupTimer); persistence.dispose(); for (const subscription of subscriptions) subscription?.dispose?.(); },
    watchTick: () => watch.tick(),
    cleanupTick: () => queue(() => runCleanup()),
    flush: () => chain
  };
  return api;
}
