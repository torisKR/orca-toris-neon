import { promises as fs, constants as FS_CONSTANTS, createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createRun, nextActions, claimNode, recordLaunch, applyReport, approveNode,
  pauseRun, resumeRun, retryNode, blockNode, cancelRun
} from './engine.mjs';

const execFileAsync = promisify(execFile);
const STORE_KEY = 'toris-neon.runtime.v1';
const MAX_RECEIPT_BYTES = 256 * 1024;
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_RUNS = 40;
const MAX_ARCHIVED_RUNS = 200;
const STAGE_BRIEFS = {
  research: '목표 사용자, 문제, 경쟁 앱, 차별점, 수익화 가설과 근거를 조사하고 research.md를 작성하세요. 추정과 확인 사실을 구분하고 현재 정보에는 출처를 남기세요.',
  brief: '조사 결과로 MVP 요구사항, 사용자 여정, 기능별 수용 조건, 비기능 요구사항, 제외 범위를 확정한 brief.md를 작성하세요.',
  architecture: '실제 저장소를 읽고 기존 Kotlin/Compose·Flutter·기타 스택을 존중하며 화면·상태·데이터·API·인증·오프라인·테스트 구조와 구현 순서를 설계하세요.',
  design: 'MVP 화면 흐름, 각 화면의 레이아웃·상태·접근성·피드백, 일관된 색상·간격·타이포그래피와 에셋 명세를 산출하세요. 개발자가 구현할 수 있는 구체적인 명세가 필요합니다.',
  assets: '승인된 화면/에셋 명세에 맞는 실제 앱 에셋을 만들고 소스에 연결하세요. 사용한 생성/편집 스킬과 라이선스, 파일 크기·해상도·투명도 검증을 기록하세요.',
  build: '명세와 기존 프로젝트 규칙에 따라 작동하는 앱을 구현하세요. 임시 버튼·가짜 데이터·미구현 TODO로 완료하지 마세요. 실패 feedback이 있으면 재현하고 최소 수정 후 관련 테스트를 실행하세요.',
  test: '저장소에 맞는 실제 빌드·단위/통합 테스트와 핵심 사용자 흐름을 검증하세요. 코드를 직접 수정하지 말고 실패를 재현 명령·로그·기대/실제 결과와 함께 failed로 보고해 구현 단계가 고치게 하세요.',
  policy: '현재 소스의 AndroidManifest, SDK, 광고·결제·인증·개인정보·계정 삭제와 데이터 흐름을 점검하세요. 최신 공식 Play 정책 근거와 확인 날짜를 쓰고, 실제 Console 확인이 없으면 검토/승인 상태를 추정하지 마세요.',
  listing: '검증된 실제 앱 기능에 맞는 한국어/영어 스토어 설명, 스크린샷 촬영 목록, 변경 로그, 개인정보·지원 링크 점검과 출시 체크리스트를 만드세요. 존재하지 않는 기능이나 지표를 쓰지 마세요.',
  internal: '현재 검증된 앱의 내부 테스트용 빌드/설치 안내·아티팩트·버전·패키지 정보를 준비하고 재현 가능한 로그를 남기세요.',
  release: '최종 빌드와 정책·스토어 자료·내부 테스트 결과를 대조해 출시 준비 상태, 남은 차단 사유와 되돌리기 계획을 검토하세요.'
};
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
function safeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'action_failed',
    message: String(error?.message || '요청을 완료하지 못했습니다.')
      .replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/g, '[redacted]')
      .replace(/(Bearer\s+|(?:access_token|private_key|client_secret)\s*[:=]\s*)[^\s,]+/gi, '$1[redacted]')
      .slice(0, 1200)
  };
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
function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
async function assertNoSymlinks(base, target, allowMissing = false) {
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw runtimeError('invalid_params', '결과 파일이 실행 디렉터리 밖에 있습니다.');
  }
  let current = base;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw runtimeError('invalid_params', '결과 경로에 심볼릭 링크를 사용할 수 없습니다.');
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return;
      throw error;
    }
  }
}
async function boundedJson(filename, base) {
  await assertNoSymlinks(base, filename);
  const file = await fs.open(filename, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) {
      throw runtimeError('invalid_params', '완료 보고서는 256 KiB 이하의 일반 JSON 파일이어야 합니다.');
    }
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}
async function digestFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename, { flags: FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0) })) {
    hash.update(chunk);
  }
  return hash.digest('hex');
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
    git(['ls-files', '--stage', '-z'])
  ]);
  const failed = reads.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  const [head, tracked, names, indexEntries] = reads.map(result => result.value);
  if (indexEntries.split('\0').some((entry) => /^(120000|160000) /.test(entry))) {
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

function findNode(run, id) {
  const node = run.nodes.find((item) => item.id === id);
  if (!node) throw runtimeError('invalid_params', '실행에 해당 단계가 없습니다.');
  return node;
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
function candidateReceipt(job) {
  return {
    runId: job.runId, nodeId: job.nodeId, nonce: job.nonce,
    attempt: job.attempt, phase: job.phase, outcome: 'passed',
    summary: '실제 수행 결과와 남은 제한을 기록',
    evidence: [
      { kind: 'command', command: '실제로 실행한 검증 명령', exitCode: 0 },
      { kind: 'artifact', path: path.join(job.receiptDirectory, 'verification.md') }
    ],
    ...(job.phase === 'review' ? { sourceFingerprint: job.sourceFingerprint } : {})
  };
}
export function buildNodePrompt(run, node, job) {
  const dependencyEvidence = run.nodes.filter((item) => node.deps.includes(item.id)).map((item) => ({
    id: item.id, title: item.title, report: item.report, review: item.review,
    approval: item.approval
  }));
  const review = job.phase === 'review';
  return [
    'Toris Neon 앱 개발 워크플로의 ' + (review ? '독립 검토자' : '담당 에이전트') + '입니다.',
    '목표: ' + run.goal,
    '실행: ' + run.id + ' / 단계: ' + node.id + ' — ' + node.title,
    '프로젝트 작업 디렉터리: ' + run.workspacePath,
    '역할: ' + (node.role || node.id) + '; 담당 도구: ' + job.agent,
    '이 프로젝트의 AGENTS.md / CLAUDE.md 및 적용되는 지침을 먼저 읽으세요.',
    review
      ? '코드를 변경하지 말고 이전 작업을 독립적으로 검증하세요. 원래 에이전트의 성공 주장을 그대로 반복하지 마세요. 실제 테스트/빌드·산출물·요구사항을 확인하고 결함이 있으면 failed로 보고하세요.'
      : (node.write
        ? '이 단계에 필요한 소스 변경만 수행하세요. 다른 에이전트의 작업을 덮어쓰지 말고, 정의된 목표와 선행 결과를 따르세요.'
        : '읽기·분석·검증 단계입니다. 프로젝트 소스는 변경하지 마세요. 보고서와 검증 자료는 아래 전용 결과 디렉터리에 기록하세요.'),
    '실행 범위/완료 조건: ' + (node.instructions || node.description || STAGE_BRIEFS[node.id] || node.title),
    '선행 단계 결과:\n' + JSON.stringify(dependencyEvidence, null, 2).slice(0, 20_000),
    review ? '검토 대상 결과:\n' + JSON.stringify(node.report, null, 2).slice(0, 16_000) : '',
    '실패 이력:\n' + JSON.stringify(node.feedback || node.lastFailure || node.report?.outcome === 'failed' && node.report || null).slice(0, 5000),
    '실제로 실행하지 않은 검증을 성공으로 적지 마세요. 테스트를 생략했거나 권한/계정이 없으면 blocked와 정확한 이유를 적으세요.',
    node.approval?.submission && !review
      ? '사용자가 현재 소스와 다음 제출 대상을 명시적으로 승인했습니다: ' + JSON.stringify(node.approval.submission) + '. 기존 저장소에 이미 구성된 출시 도구를 통해 이 대상만 제출할 수 있습니다. 제출 전 실제 패키지/트랙/versionCode와 현재 아티팩트를 대조하세요. 키를 새로 만들거나 추출하지 말고, 필요한 도구/권한이 없으면 blocked로 보고하세요. 제출된 버전과 트랙의 실제 응답 증거를 파일로 남기세요. 중복 제출하지 말고, 응답이 불명확하면 blocked로 보고하세요. 승인 뒤 소스/버전을 변경하지 마세요.'
      : '실제 앱 스토어 제출/배포는 하지 마세요. 이 단계는 준비·검토 산출물을 만듭니다. 별도 대상 승인이 없는 업로드를 수행하면 안 됩니다.',
    '결제/유료 리소스 생성, 외부 메시지 전송, 자격 증명 생성·추출은 하지 마세요.',
    '기존 UI에서 명시적으로 승인된 gate 외에 승인됐다고 가정하지 마세요. 토큰·키·서비스 계정 JSON은 결과 파일에 기록하지 마세요.',
    '별도 소스 브랜치/워크트리를 만들거나 git reset/clean, 강제 push를 하지 마세요. 여러 읽기 에이전트가 같은 실행 워크트리를 사용합니다.',
    '완료 보고서 디렉터리(이미 생성됨): ' + job.receiptDirectory,
    '검증 로그/요약 산출물을 위 디렉터리에 저장하세요. evidence.artifact는 이 디렉터리 안의 실제 일반 파일이어야 합니다.',
    '최종 JSON 보고서 경로: ' + job.receiptPath,
    '아래 스키마의 식별자를 그대로 사용하세요. 결과에 따라 outcome을 passed, failed, blocked 중 하나로 설정하세요.',
    JSON.stringify(candidateReceipt(job), null, 2),
    'passed에는 비어 있지 않은 summary, 실제 evidence, 최소 한 개의 artifact가 필요합니다. 명령 실패를 숨기지 마세요.',
    review ? 'sourceFingerprint는 위 값을 그대로 포함하세요. 검토 중 소스가 달라지면 blocked로 보고하세요.' : '',
    'JSON 보고서는 다른 임시 파일에 먼저 쓴 후 위 경로로 원자적으로 교체하세요. 보고서를 저장한 뒤 작업을 종료하세요.',
    '다음 단계는 Toris Neon이 검증 후 배정합니다. 직접 다음 에이전트를 실행하지 마세요.'
  ].filter(Boolean).join('\n\n');
}

export function createRuntime({ orca, now = Date.now, receiptRoot = path.join(homedir(), '.toris-neon', 'runs'),
  fingerprint = sourceFingerprint, readReceipt = boundedJson, ensureDirectory,
  validateArtifact, id = randomUUID } = {}) {
  if (!orca?.host || !orca?.storage) throw new Error('Orca host and storage are required.');
  let state = { version: 1, runs: [], archivedRuns: [] };
  let chain = Promise.resolve();
  let disposed = false;
  let pumpQueued = false;
  const subscriptions = [];
  const queue = (work) => {
    const operation = chain.then(work);
    chain = operation.catch(() => {});
    return operation;
  };
  const call = (method, params = {}) => {
    if (orca.host.has && !orca.host.has(method)) throw runtimeError('unknown_method', '현재 Orca에서 ' + method + ' API를 지원하지 않습니다.');
    return orca.host.call(method, params);
  };
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
  const persist = async () => {
    const snapshot = jsonValue(state);
    await orca.storage.set(STORE_KEY, snapshot);
    try { orca.panels?.post('state.changed', snapshot); } catch {}
    try {
      const working = state.runs.reduce((sum, run) => sum + activeJobs(run).filter((job) => job.state === 'running').length, 0);
      const blocked = state.runs.filter((run) => run.status === 'blocked').length;
      await call('statusBar.update', { id: 'pipeline', text: 'NEON · ' + working + ' 실행' + (blocked ? ' · ' + blocked + ' 확인' : ''), tone: blocked ? 'warning' : working ? 'accent' : 'neutral' });
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
    return run;
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
    return { kind: 'artifact', path: filename, size: stat.size, sha256: await digestFile(filename) };
  };
  const acceptReceipt = async (run, job, outcome) => {
    if (!matchingNodeJob(run, job)) return false;
    let report;
    try {
      report = await readReceipt(job.receiptPath, job.receiptDirectory);
      for (const field of ['runId', 'nodeId', 'nonce', 'phase', 'attempt']) {
        if (report?.[field] !== job[field]) throw runtimeError('invalid_params', '완료 보고서의 ' + field + ' 식별자가 현재 배정과 다릅니다.');
      }
      if (['failure', 'cancellation', 'superseded', 'interruption'].includes(outcome) && report.outcome === 'passed') {
        throw runtimeError('invalid_params', '에이전트 종료 상태와 성공 보고서가 일치하지 않습니다.');
      }
      if (!Array.isArray(report.evidence) || report.evidence.length > 64) {
        throw runtimeError('invalid_params', '검증 evidence는 최대 64개 배열이어야 합니다.');
      }
      const artifacts = [];
      for (const evidence of report.evidence) {
        if (evidence.kind === 'artifact') artifacts.push(await artifactDetails(evidence, job));
      }
      if (report.outcome === 'passed' && artifacts.length === 0) {
        throw runtimeError('invalid_params', '성공 보고서에는 실제 검증 artifact가 한 개 이상 필요합니다.');
      }
      if (job.phase === 'review' && report.outcome === 'passed') {
        if (!job.sourceFingerprint || report.sourceFingerprint !== job.sourceFingerprint) {
          throw runtimeError('conflict', '검토 보고서가 배정된 소스 버전과 다릅니다.');
        }
        if (await fingerprint(run.workspacePath) !== job.sourceFingerprint) {
          throw runtimeError('conflict', '검토 도중 소스가 변경됐습니다. 현재 소스를 다시 검증하세요.');
        }
      }
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
      updatedNode.runtimeMessage = '';
      const storedJob = (run.jobs || []).find((entry) => entry.nonce === job.nonce);
      if (storedJob) {
        storedJob.state = 'complete';
        storedJob.completedAt = nowIso(now);
        storedJob.outcome = report.outcome;
      }
      replaceRun(run);
      appendEvent(run, node.title + ' ' + (job.phase === 'review' ? '검토' : '작업') + ': ' + report.outcome, now, { nodeId: job.nodeId });
      return true;
    } catch (error) {
      const message = error.code === 'ENOENT'
        ? '에이전트가 종료됐지만 검증 보고서가 없습니다. 보고서를 저장한 뒤 새로고침하거나 이 단계를 재시도하세요.'
        : safeError(error).message;
      markBlocked(run, job, message);
      return false;
    }
  };
  const listAgents = async (workspaceId) => (await call('agents.list', { workspaceId })).agents || [];
  const reconcile = async (run, explicit = false) => {
    if (!run.workspaceId || !activeJobs(run).length) return run;
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
      if (job.promptRecovery?.state === 'sending') {
        job.promptRecovery.state = 'uncertain';
        job.promptRecovery.reason = '재시작 전에 저장된 프롬프트 전달 요청의 결과를 확인할 수 없습니다. 자동 재전송하지 않습니다.';
        markBlocked(run, job, job.promptRecovery.reason, true);
        continue;
      }
      if (!job.terminalId) {
        markBlocked(run, job, '실행 요청의 응답이 불명확합니다. Orca 터미널을 확인하기 전에는 다시 배정하지 않습니다.', true);
        continue;
      }
      const agent = agents.find((entry) => entry.terminalId === job.terminalId);
      if (agent?.sessionId) job.sessionId = agent.sessionId;
      if (agent && agent.state !== 'done') {
        job.agentState = agent.state;
        if (job.state !== 'uncertain') job.state = 'running';
        continue;
      }
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
      startedAt: nowIso(now), state: 'launching'
    };
    run.jobs ||= [];
    run.jobs.push(job);
    claimed.active = { ...claimed.active, ...job };
    let hostRequested = false;
    try {
      if (claimed.approval?.submission && action.phase === 'work' &&
          await fingerprint(run.workspacePath) !== claimed.approval.sourceFingerprint) {
        throw runtimeError('conflict', '제출 승인 이후 소스가 변경됐습니다. 새 실행에서 검증과 구체적인 제출 승인을 다시 받으세요.');
      }
      await createReceiptDirectory(directory);
      if (action.phase === 'review') {
        job.sourceFingerprint = await fingerprint(run.workspacePath);
        claimed.active.sourceFingerprint = job.sourceFingerprint;
      }
      await persist(); // The nonce and intent must exist before the host can launch.
      hostRequested = true;
      const launched = await call('agent.launch', {
        workspaceId: run.workspaceId, agent: action.agent,
        prompt: buildNodePrompt(run, claimed, job)
      });
      if (!launched?.terminalId) throw runtimeError('action_failed', 'Orca가 실행 터미널 ID를 반환하지 않았습니다.');
      job.terminalId = launched.terminalId;
      job.state = 'running';
      run = recordLaunch(run, node.id, { nonce, terminalId: launched.terminalId, workspaceId: run.workspaceId, now: now() });
      replaceRun(run);
      await persist();
    } catch (error) {
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
  const pump = async () => {
    if (disposed) return;
    for (const entry of [...state.runs]) {
      let run = getRun(entry.id);
      if (!run.started || !['ready', 'running'].includes(run.status) || !run.workspaceId || !run.workspacePath) continue;
      if (state.runs.some((other) => other.id !== run.id && other.workspaceId === run.workspaceId && activeJobs(other).length)) continue;
      for (let guard = 0; guard < 50; guard++) {
        run = getRun(run.id);
        if (!run.started || !['ready', 'running'].includes(run.status)) break;
        if (run.nodes.some((node) => ['blocked', 'failed'].includes(node.status)) || activeJobs(run).some((job) => ['uncertain', 'awaiting-report'].includes(job.state))) break;
        const actions = nextActions(run);
        const active = run.nodes.filter((node) => node.active);
        const action = actions.find((candidate) => {
          const node = findNode(run, candidate.nodeId);
          if (candidate.phase === 'review') return !active.some((item) => item.write && item.active.phase === 'work');
          if (node.write) return active.length === 0;
          return !active.some((item) => item.write && item.active.phase === 'work');
        });
        if (!action) break;
        await launchOne(run, action);
      }
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
    if (run.workspaceCreation?.state === 'uncertain' || run.workspaceCreation?.state === 'creating') {
      const { workspaces = [] } = await call('workspace.list', {});
      const matches = workspaces.filter((item) => item.projectId === run.projectId && item.name === run.workspaceCreation.name);
      if (matches.length === 1 && isLocal(matches[0])) {
        run.workspaceId = matches[0].id;
        run.workspacePath = matches[0].path;
        run.workspaceCreation.state = 'created';
        appendEvent(run, '기존 생성 작업 공간을 복구했습니다.', now);
        return run;
      }
      throw runtimeError('conflict', '작업 공간 생성 응답이 불명확합니다. Orca에서 기존 생성 결과를 확인하세요. 중복 생성하지 않았습니다.');
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
      await persist();
      const workspace = await validateWorkspace(run.workspaceId, run.projectId);
      run.workspacePath = workspace.path;
      return run;
    } catch (error) {
      run.workspaceCreation.state = run.workspaceId ? 'created' : 'uncertain';
      run.status = 'blocked';
      run.runtimeMessage = safeError(error).message;
      await persist();
      throw error;
    }
  };

  const handlers = {
    'state.get': async () => {
      await chain;
      const names = ['project.list', 'workspace.list', 'workspace.readContext', 'agents.list'];
      const results = await Promise.allSettled(names.map((name) => call(name, name === 'workspace.list' ? { includeStatus: true } : {})));
      const value = (index, key, fallback) => results[index].status === 'fulfilled' ? (key ? results[index].value?.[key] ?? fallback : results[index].value) : fallback;
      return {
        ...clone(state), projects: value(0, 'projects', []), workspaces: value(1, 'workspaces', []),
        context: value(2, null, null), agents: value(3, 'agents', []), providers: PROVIDERS,
        warnings: results.flatMap((result, index) => result.status === 'rejected' ? [names[index] + ': ' + safeError(result.reason).message] : [])
      };
    },
    'runs.create': (input = {}) => queue(async () => {
      if (state.runs.length >= MAX_RUNS) throw runtimeError('too_large', '최대 40개 실행을 보관합니다. 기존 실행을 완료한 뒤 보관 정리를 진행하세요.');
      const goal = requireString(input.goal, '앱 목표', 6000);
      const projectId = requireString(input.projectId, '프로젝트', 256);
      const run = createRun({
        id: id(), goal, projectId, assignments: input.assignments || {},
        maxConcurrency: input.maxConcurrency ?? 2, maxAttempts: input.maxAttempts ?? 3,
        maxRepairLoops: input.maxRepairLoops ?? 3,
        ...(input.nodes ? { nodes: input.nodes } : {}), now: now()
      });
      run.isolate = input.isolate !== false;
      if (input.baseBranch) run.baseBranch = requireString(input.baseBranch, '기준 브랜치', 128);
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
      if (state.archivedRuns.length >= MAX_ARCHIVED_RUNS) throw runtimeError('too_large', '보관 기록 200개 한도에 도달했습니다. 기존 기록은 삭제하지 않았습니다.');
      const archivedRun = clone(run);
      archivedRun.archivedAt = nowIso(now);
      appendEvent(archivedRun, '완료된 실행을 보관했습니다. 이전 작업 기록은 계속 확인할 수 있습니다.', now);
      state.archivedRuns.push(archivedRun);
      state.runs = state.runs.filter((entry) => entry.id !== run.id);
      await persist();
      return { archived: true, runId: run.id, archivedRun: clone(archivedRun) };
    }),
    'runs.start': (input) => queue(async () => {
      let run = getRun(input.runId);
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
      let run = getRun(input.runId);
      if (run.status === 'cancelled' || run.status === 'completed') throw runtimeError('conflict', '종료된 실행은 재개할 수 없습니다.');
      run = await ensureWorkspace(run);
      run = await reconcile(run, true);
      run = resumeRun(run, { now: now() });
      run.started = true;
      replaceRun(run); await persist(); schedulePump(); return clone(run);
    }),
    'runs.refresh': (input) => queue(async () => {
      let run = await reconcile(getRun(input.runId), true);
      replaceRun(run); await persist(); schedulePump(); return clone(run);
    }),
    'runs.approve': (input) => queue(async () => {
      const note = requireString(input.note || '사용자가 패널에서 단계 결과를 확인하고 승인했습니다.', '승인 근거', 2000);
      const original = getRun(input.runId);
      let submission;
      if (input.submission !== undefined) {
        if (!['internal', 'release'].includes(input.nodeId)) throw runtimeError('invalid_params', '내부 테스트/출시 단계에서만 실제 제출 대상을 승인할 수 있습니다.');
        const packageName = requireString(input.submission?.packageName, '제출 패키지', 200);
        const track = requireString(input.submission?.track, '제출 트랙', 80);
        const versionCode = String(input.submission?.versionCode ?? '');
        if (!/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(packageName) || !/^[1-9]\d{0,9}$/.test(versionCode) || Number(versionCode) > 2100000000) {
          throw runtimeError('invalid_params', '정확한 Android 패키지명과 양의 versionCode가 필요합니다.');
        }
        if (track !== (input.nodeId === 'internal' ? 'internal' : 'production')) throw runtimeError('invalid_params', '이 단계의 승인 트랙은 ' + (input.nodeId === 'internal' ? 'internal' : 'production') + '입니다.');
        if (!input.note || input.note.trim().length < 10) throw runtimeError('invalid_params', '실제 제출은 대상과 검증 결과를 확인한 명시적 승인 메모가 필요합니다.');
        submission = { packageName, track, versionCode };
      }
      const approvedFingerprint = submission ? await fingerprint(original.workspacePath) : null;
      const run = approveNode(original, input.nodeId, { note, now: now() });
      if (submission) findNode(run, input.nodeId).approval = { ...findNode(run, input.nodeId).approval, submission, sourceFingerprint: approvedFingerprint };
      replaceRun(run); await persist(); schedulePump(); return clone(run);
    }),
    'runs.updateAssignments': (input) => queue(async () => {
      const run = clone(getRun(input.runId));
      if (!input.assignments || typeof input.assignments !== 'object' || Array.isArray(input.assignments)) throw runtimeError('invalid_params', '단계별 담당자 맵이 필요합니다.');
      for (const [nodeId, assignment] of Object.entries(input.assignments)) {
        const node = findNode(run, nodeId);
        if (node.active || ['passed', 'awaiting-approval'].includes(node.status)) throw runtimeError('conflict', '실행 중이거나 검증 완료한 단계의 담당자는 바꿀 수 없습니다.');
        for (const field of ['agent', 'reviewer']) {
          if (assignment[field] !== undefined) {
            const provider = requireString(assignment[field], '에이전트', 64);
            if (!/^[a-z][a-z0-9-]*$/.test(provider)) throw runtimeError('invalid_params', '잘못된 에이전트 ID입니다.');
            node[field] = provider;
          }
        }
      }
      appendEvent(run, '단계별 에이전트 배정을 변경했습니다.', now);
      replaceRun(run); await persist(); return clone(run);
    }),
    'nodes.deliverPrompt': (input) => queue(async () => {
      if (input.acknowledgeUnsent !== true) {
        throw runtimeError('invalid_params', '해당 터미널이 비어 있고 아직 프롬프트가 전달되지 않았음을 직접 확인해야 합니다.');
      }
      let run = clone(getRun(input.runId));
      if (['completed', 'cancelled'].includes(run.status)) throw runtimeError('conflict', '종료된 실행에는 프롬프트를 전달할 수 없습니다.');
      const node = findNode(run, input.nodeId);
      const job = (run.jobs || []).find((entry) => entry.nonce === node.pendingReceipt?.nonce);
      if (node.status !== 'blocked' || node.active || !node.pendingReceipt || !job?.terminalId ||
          job.state !== 'awaiting-report' || job.nodeId !== node.id || job.workspaceId !== run.workspaceId) {
        throw runtimeError('conflict', '보고서 대기 중인 중단 단계의 기존 소유 터미널만 전달 복구할 수 있습니다.');
      }
      if (job.promptRecovery) throw runtimeError('conflict', '이 배정의 프롬프트 전달 복구는 이미 요청했습니다. 결과가 불명확해도 재전송하지 않습니다.');
      if (job.sessionId || node.pendingReceipt.sessionId) throw runtimeError('conflict', '이미 에이전트 세션이 연결된 작업에는 프롬프트를 다시 전달할 수 없습니다.');
      try {
        await readReceipt(job.receiptPath, job.receiptDirectory);
        throw runtimeError('conflict', '결과 보고서가 이미 있습니다. 전달 복구 대신 새로고침으로 결과를 확인하세요.');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const agents = await listAgents(run.workspaceId);
      const agent = agents.find((entry) => entry.terminalId === job.terminalId);
      if (!agent || agent.agent !== job.agent || !['done', 'waiting'].includes(agent.state) || agent.sessionId) {
        throw runtimeError('conflict', '같은 종류의 빈 에이전트가 대기/종료 상태인 경우만 복구할 수 있습니다. 진행 중인 작업이나 기존 세션에는 전송하지 않습니다.');
      }
      let focused;
      try { focused = await call('terminal.focus', { terminalId: job.terminalId }); }
      catch (error) {
        throw runtimeError('action_failed', '기존 에이전트 터미널을 활성 작업 공간으로 열지 못했습니다. 프롬프트를 전달하지 않았습니다: ' + safeError(error).message);
      }
      if (focused?.focused !== true) {
        throw runtimeError('conflict', '다른 화면 이동으로 에이전트 터미널 활성화가 취소됐습니다. 프롬프트를 전달하지 않았으므로 터미널을 확인한 뒤 다시 시도하세요.');
      }
      if (job.phase === 'review' && (!job.sourceFingerprint || await fingerprint(run.workspacePath) !== job.sourceFingerprint)) {
        throw runtimeError('conflict', '검토 배정 이후 소스가 변경됐습니다. 이전 검토 프롬프트를 전달하지 않았습니다.');
      }
      job.promptRecovery = {
        state: 'sending', at: nowIso(now), terminalId: job.terminalId,
        acknowledgedEmpty: true
      };
      job.state = 'running';
      node.active = { ...node.pendingReceipt, ...job };
      node.status = job.phase === 'review' ? 'review' : 'running';
      node.failureReason = null;
      node.runtimeMessage = '확인된 빈 터미널에 기존 배정 프롬프트를 한 번 전달합니다.';
      delete node.pendingReceipt;
      delete node.launchUncertain;
      if (run.status !== 'paused') run.status = 'running';
      appendEvent(run, node.title + '의 빈 터미널에 기존 프롬프트 전달 복구를 요청했습니다.', now, { nodeId: node.id, nonce: job.nonce, terminalId: job.terminalId });
      replaceRun(run);
      await persist(); // One durable recovery intent per nonce, before any send.
      try {
        const result = await call('terminal.sendText', {
          terminalId: job.terminalId, text: buildNodePrompt(run, node, job), enter: true
        });
        if (result?.accepted !== true) {
          job.promptRecovery.state = 'rejected';
          job.promptRecovery.reason = 'Orca가 프롬프트 전달을 수락하지 않았습니다. 자동 또는 반복 전달하지 않습니다.';
          run = markBlocked(run, job, job.promptRecovery.reason);
          appendEvent(run, job.promptRecovery.reason, now, { nodeId: node.id });
          await persist();
          throw runtimeError('action_failed', job.promptRecovery.reason);
        }
        job.promptRecovery.state = 'sent';
        job.promptRecovery.acceptedAt = nowIso(now);
        node.runtimeMessage = '프롬프트 전달 요청이 수락됐습니다. 완료 보고서로 실제 결과를 확인합니다.';
        appendEvent(run, node.title + '의 기존 배정 프롬프트 전달 요청이 수락됐습니다.', now, { nodeId: node.id, nonce: job.nonce });
        await persist();
        return clone(run);
      } catch (error) {
        // A definite host refusal was already recorded; all other failures have
        // an uncertain delivery outcome and must never cause an automatic resend.
        if (job.promptRecovery.state === 'rejected') throw error;
        job.promptRecovery.state = 'uncertain';
        job.promptRecovery.reason = '프롬프트 전달 결과가 불명확합니다: ' + safeError(error).message;
        run = markBlocked(getRun(run.id), job, job.promptRecovery.reason, true);
        appendEvent(run, '전달 복구 결과가 불명확해 자동 재전송을 중단했습니다.', now, { nodeId: node.id, nonce: job.nonce });
        await persist();
        throw runtimeError('action_failed', job.promptRecovery.reason);
      }
    }),
    'nodes.retry': (input) => queue(async () => {
      let run = clone(getRun(input.runId));
      const node = findNode(run, input.nodeId);
      const previousJobs = activeJobs(run).filter((job) => job.nodeId === node.id);
      if (node.launchUncertain && input.acknowledgeUncertain !== true) {
        throw runtimeError('conflict', '이전 배정의 시작 여부가 불명확합니다. Orca 터미널을 확인한 뒤 acknowledgeUncertain=true로 명시적으로 재시도하세요.');
      }
      const candidate = retryNode(run, input.nodeId, { now: now() });
      for (const job of previousJobs) {
        if (job.terminalId && ['running', 'uncertain'].includes(job.state)) {
          const agents = await listAgents(run.workspaceId);
          const running = agents.find((agent) => agent.terminalId === job.terminalId && agent.state !== 'done');
          if (running && input.stopPrevious !== true) throw runtimeError('conflict', '이전 에이전트가 아직 실행 중입니다. 먼저 종료하거나 stopPrevious=true로 재시도하세요.');
          if (running) await call('terminal.close', { terminalId: job.terminalId });
        }
        const previous = candidate.jobs.find((entry) => entry.nonce === job.nonce);
        if (previous) previous.state = 'superseded';
      }
      delete findNode(candidate, input.nodeId).pendingReceipt;
      delete findNode(candidate, input.nodeId).launchUncertain;
      run = candidate;
      replaceRun(run); await persist(); schedulePump(); return clone(run);
    }),
    'runs.cancel': (input) => queue(async () => {
      let run = getRun(input.runId);
      const owned = activeJobs(run).filter((job) => job.terminalId);
      run = cancelRun(run, { now: now(), reason: '사용자가 실행을 취소했습니다.' });
      run.stopFailures = [];
      replaceRun(run);
      await persist(); // Cancellation intent precedes terminal mutations.
      for (const job of owned) {
        try {
          await call('terminal.close', { terminalId: job.terminalId });
          const saved = run.jobs.find((item) => item.nonce === job.nonce);
          if (saved) saved.state = 'cancelled';
        } catch (error) {
          run.stopFailures.push({ terminalId: job.terminalId, ...safeError(error) });
        }
      }
      for (const job of run.jobs || []) if (!job.terminalId && job.state === 'uncertain') run.stopFailures.push({ terminalId: null, code: 'uncertain', message: '응답이 없는 실행 요청이 있습니다. Orca에서 해당 실행을 확인하세요.' });
      appendEvent(run, run.stopFailures.length ? '취소됐지만 일부 터미널 종료 여부를 확인해야 합니다.' : '실행을 취소하고 소유한 활성 터미널을 종료했습니다.', now);
      await persist(); return clone(run);
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

  async function initialize() {
    const saved = await orca.storage.get(STORE_KEY);
    if (saved !== null && saved !== undefined) {
      if (saved.version !== 1 || !Array.isArray(saved.runs) || (saved.archivedRuns !== undefined && !Array.isArray(saved.archivedRuns))) throw runtimeError('invalid_params', '저장된 실행 데이터 형식이 지원되지 않습니다. 원본 데이터를 덮어쓰지 않았습니다.');
      state = { ...clone(saved), archivedRuns: clone(saved.archivedRuns || []) };
    }
    await queue(async () => {
      for (const entry of [...state.runs]) {
        let run = getRun(entry.id);
        if (['running', 'ready'].includes(run.status) && (run.workspaceId || activeJobs(run).length)) {
          run = pauseRun(run, { now: now(), reason: '작업자가 다시 시작되었습니다. 활성 에이전트는 유지되며 재개를 누르면 다음 단계를 배정합니다.' });
          replaceRun(run);
        }
        if (activeJobs(run).length) await reconcile(run, true);
      }
      await persist();
    });
    if (orca.events?.on) {
      subscriptions.push(orca.events.on('agent.status.changed', (event) => queue(async () => {
        if (!event || typeof event.terminalId !== 'string' || !['working', 'blocked', 'waiting', 'done'].includes(event.state)) return;
        for (const original of [...state.runs]) {
          let run = getRun(original.id);
          if (run.status === 'cancelled') continue;
          const job = activeJobs(run).find((candidate) => candidate.terminalId && candidate.terminalId === event.terminalId);
          if (!job || !matchingNodeJob(run, job)) continue;
          if (typeof event.sessionId === 'string' && event.sessionId) job.sessionId = event.sessionId;
          job.agentState = event.state;
          if (typeof event.mainAgent?.outcome === 'string') job.agentOutcome = event.mainAgent.outcome;
          else delete job.agentOutcome;
          if (event.state === 'done') await acceptReceipt(run, job, event.mainAgent?.outcome);
        }
        await persist(); schedulePump();
      }).catch((error) => orca.log?.('Toris Neon event: ' + safeError(error).message))));
    }
    return api;
  }
  const api = {
    initialize,
    handlers: Object.fromEntries(Object.entries(handlers).map(([name, handler]) => [name, async (input) => jsonValue(await handler(input))])),
    getState: () => jsonValue(state),
    drain: async () => { let pending; do { pending = chain; await pending; } while (pending !== chain); },
    dispose: () => { disposed = true; for (const subscription of subscriptions) subscription?.dispose?.(); },
    flush: () => chain
  };
  return api;
}
