/**
 * What each stage's crew member is doing, from the summary state only (docs/design/pixel-ui/SPEC.md,
 * 상태표). Pure: the workshop, the run header and the rows render from these views, and motion is
 * drawn only where the state proves activity. Rows are checked top to bottom as the table orders them.
 */
export const START_SLOW_MS = 15_000; // 시작 중 → 시작 신호 대기
export const QUIET_MS = 180_000; // 작업 중 → x분째 조용함
export const DELIVERY_ATTEMPTS = 3; // src/runtime.mjs: the first start + MAX_PROMPT_DELIVERY_RETRIES (2)
export const AUTONOMY_STAGE_RETRIES = 3; // src/autonomy.mjs AUTONOMY_LIMITS.retriesPerStage
export const ONCE_WINDOW_MS = 1000; // the longest one-shot pose (retry, 960 ms) fits inside
export const QUIET_TOOLTIP = '최근 에이전트 상태 기록 기준. 작업 내용은 측정하지 않습니다.';

const TONES = {
  work: 'good', review: 'review', passed: 'good', completed: 'good', start: 'neutral', 'start-slow': 'warn', retry: 'warn',
  quiet: 'warn', approval: 'warn', report: 'warn', blocked: 'stop', failed: 'stop', unknown: 'neutral', paused: 'neutral',
  dependency: 'neutral', queue: 'neutral', idle: 'neutral', skipped: 'neutral', cancelled: 'neutral',
};
const MOTIONS = { work: 'loop', review: 'loop', start: 'once', retry: 'once' };
const BLOCKER_LABELS = { 'hook-review': '멈춤 · 시작 화면', 'start-dialog': '멈춤 · 시작 화면', login: '로그인 필요', 'usage-limit': '사용 한도' };
const DIALOG_NAMES = { 'code-mode': 'Code Mode 안내', 'folder-trust': '폴더 신뢰 확인' };
const ORDINALS = ['첫 번째', '두 번째', '세 번째', '네 번째'];
// The station names the workshop uses; the detail keeps the full stage title (panel/kit.mjs nodeNames).
const SHORT_TITLES = {
  research: '시장·앱 조사', brief: '제품 기획', architecture: '구조 설계', design: '화면 설계', assets: '앱 에셋', build: '앱 구현',
  test: '테스트·수정', policy: '정책 점검', listing: '스토어 자료', internal: '내부 테스트', release: '출시 검토', identity: '앱 정체성',
  diagnose: '진단', reproduce: '증상 재현', measure: '성능 측정', plan: '개선 기획', monetization: '결제 연동', catalog: '상품 등록',
};
export const shortTitle = (node) => SHORT_TITLES[node.id] ?? node.title ?? node.id;

/** A positive time from ms or ISO text, else null. */
export const msOf = (value) => {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

const delivered = (job) => Boolean(job) && (!job.selfDelivery || job.promptRecovery?.state === 'sent');

/**
 * The time of the agent event that proves this assignment's turn, or null. A turn needs the agent
 * working in its own session after the prompt was sent; promptSeen alone can rise on a start modal,
 * and an event older than the assignment or the send belongs to something else.
 */
function workSignal(job, startMs) {
  if (!job || job.agentState !== 'working' || job.promptSeen !== true || !job.sessionId || !delivered(job)) return null;
  const at = msOf(job.lastAgentEventAt);
  if (at === null) return null;
  const sentAt = job.selfDelivery ? msOf(job.promptRecovery?.at) ?? 0 : 0;
  return at >= Math.max(startMs ?? 0, sentAt) ? at : null;
}

const known = (...values) => values.every(Number.isFinite);
function queueView(waiting, run, limits) {
  if (/^전체 작업 \d+개 실행 중$/.test(waiting)) return ['슬롯 대기', limits && known(limits.active, limits.activeJobs) ? '전체 ' + limits.active + '/' + limits.activeJobs : waiting];
  if (waiting === '빌드 작업 완료 대기') return ['차례 대기', limits && known(limits.heavy, limits.heavyJobs) ? '빌드·테스트 ' + limits.heavy + '/' + limits.heavyJobs : waiting];
  if (waiting === '실행별 한도') return ['슬롯 대기', '실행별 ' + (run.nodes ?? []).filter((item) => item.active).length + '/' + (run.maxConcurrency ?? '?')];
  if (['쓰기 작업 완료 대기', '배정 순서 대기'].includes(waiting)) return ['차례 대기', waiting];
  return null;
}

/** Everything the workshop needs about one stage. Inputs come from the latest summary push only. */
export function stagePixel({ run, node, job = null, operation = null, waiting = null, limits = null, now, cancelling = false, autonomyRetry = null }) {
  const startMs = msOf(node.active?.startedAt) ?? msOf(job?.startedAt);
  const phase = node.active?.phase ?? node.pendingReceipt?.phase ?? (node.status === 'review' ? 'review' : 'work');
  const reason = node.runtimeMessage || node.failureReason || '';
  const base = { phase, startedAt: startMs, activityAt: msOf(operation?.lastProgressAt) ?? msOf(job?.lastAgentEventAt),
    detail: '', reason, tooltip: '', person: false, retryKind: null, retryCount: null, until: null, onceScope: null };
  const view = (pose, label, extra = {}) => ({ ...base, pose, label, tone: TONES[pose], motion: MOTIONS[pose] ?? 'still', ...extra });
  const status = node.status;
  if (status === 'passed') return view('passed', '통과');
  if (status === 'skipped') return view('skipped', '건너뜀');
  if (cancelling) return view('cancelled', '취소 요청 처리 중');
  if (run.status === 'cancelled') return view('cancelled', '취소됨');
  const uncertain = Boolean(node.launchUncertain || job?.state === 'uncertain' || job?.promptRecovery?.state === 'uncertain' || operation?.condition === 'unclear');
  const blocker = job?.blocker && BLOCKER_LABELS[job.blocker.kind] ? job.blocker : null;
  if (blocker) { // a confirmed cause first; an unconfirmed stop is added to it
    const what = [blocker.agent, DIALOG_NAMES[blocker.dialog]].filter(Boolean).join(' · ');
    return view('blocked', BLOCKER_LABELS[blocker.kind], { detail: what + (uncertain ? ' · 종료 확인 필요' : ''), person: true, blocker });
  }
  if (uncertain) return view('blocked', '확인 필요 · ' + (delivered(job) && job.promptSeen ? '작업 신호 종료 불명' : '시작 여부 불명'), { person: true });
  const retries = node.deliveryRetries ?? 0;
  if (status === 'blocked') {
    if (retries >= DELIVERY_ATTEMPTS) return view('blocked', '멈춤 · 시작 준비 실패 · ' + retries + '/' + DELIVERY_ATTEMPTS, { person: true, retryKind: 'delivery', retryCount: retries });
    return view('blocked', '확인 필요', { person: true, detail: job?.promptRecovery?.state === 'rejected' ? '지시 전달이 거부됨' : '' });
  }
  if (status === 'failed') return view('failed', '실패', { person: true });
  if (job?.agentOutcome === 'failure') return view('failed', '에이전트 오류 · 처리 대기'); // the runtime continues the turn itself
  if (operation?.condition === 'error') return view('failed', '배정 확인 필요', { person: true });
  if (status === 'awaiting-approval' || waiting === '승인 대기') return view('approval', '확인 필요 · 승인 대기', { person: true });
  if (delivered(job) && job.promptSeen && job.agentState === 'blocked') return view('approval', '확인 필요 · 터미널 응답', { person: true });
  if (delivered(job) && job.promptSeen && job.agentState === 'waiting') return view('approval', '응답 대기', { person: true });
  const signal = workSignal(job, startMs);
  if (retries > 0 && retries < DELIVERY_ATTEMPTS && signal === null) {
    const step = node.active ? '준비 실패 ' + retries + '회 · ' + ORDINALS[retries] + ' 시작 확인 중' : '재배정 대기';
    return view('retry', '시작 지연 · 재시도 ' + retries + '/' + DELIVERY_ATTEMPTS, { detail: [step, waiting].filter(Boolean).join(' · '),
      hint: '준비 신호 대기 · 반복되면 시작 화면 확인', retryKind: 'delivery', retryCount: retries, onceScope: 'delivery' });
  }
  if (autonomyRetry && signal === null && ['pending', 'running', 'review'].includes(status)) {
    return view('retry', '자율 재시도 ' + autonomyRetry + '/' + AUTONOMY_STAGE_RETRIES, { detail: [node.active ? '새 배정 수락 확인 중' : '재배정 대기', waiting].filter(Boolean).join(' · '),
      retryKind: 'autonomy', retryCount: autonomyRetry, onceScope: 'autonomy' });
  }
  if (node.active || node.pendingReceipt) return assignedView(view, { node, job, operation, phase, startMs, signal, now });
  if (run.status === 'paused' || waiting === '일시 정지') return view('paused', '새 배정 멈춤');
  const open = (node.deps ?? []).map((id) => (run.nodes ?? []).find((item) => item.id === id)).filter((dep) => dep && !['passed', 'skipped'].includes(dep.status));
  if (waiting === '선행 단계 대기' || open.length) {
    return view('dependency', '선행 대기', { detail: '해당 단계 처리 대기', tooltip: open.length ? '선행 단계 · ' + open.map(shortTitle).join(', ') : '' });
  }
  if (waiting === '확인이 필요한 단계 처리 대기') return view('dependency', '다른 단계 확인 대기', { detail: waiting });
  const queued = waiting ? queueView(waiting, run, limits) : null;
  if (queued) return view('queue', queued[0], { detail: queued[1] });
  if (status === 'review') return view('queue', '검토 배정 대기');
  if (!run.started || waiting === '시작 전') return view('idle', '시작 전');
  return view('idle', '미배정');
}

function assignedView(view, { node, job, operation, phase, startMs, signal, now }) {
  if (!job) return view('unknown', '작업 신호 미확인', { detail: '기록 없음' });
  if (job.state === 'awaiting-report' || operation?.condition === 'report') return view('report', '보고서 확인 대기');
  if (signal === null && delivered(job) && job.promptSeen && job.sessionId && job.agentState === 'done') return view('report', '턴 종료 · 보고서 대기');
  if (signal !== null) {
    const review = phase === 'review', quietFor = now - signal;
    if (quietFor >= QUIET_MS) {
      const minutes = Math.floor(quietFor / 60_000);
      return view('quiet', (review ? '검토 · ' : '') + minutes + '분째 조용함', { activityAt: signal, until: signal + (minutes + 1) * 60_000, tooltip: QUIET_TOOLTIP });
    }
    return view(review ? 'review' : 'work', review ? '검토 중' : '작업 중', { activityAt: signal, until: signal + QUIET_MS, detail: '작업 신호 확인됨', tooltip: QUIET_TOOLTIP });
  }
  // The runtime is starting it: launching, typing, or waiting for the sent prompt to start a turn.
  const starting = job.state === 'launching' || node.active?.state === 'launching' || job.selfDelivery;
  if (!starting) return view('unknown', '작업 신호 미확인', { detail: '기록 없음' });
  const detail = job.promptRecovery?.state === 'sent' ? '작업 시작 확인 대기' : '준비 신호 대기';
  if (startMs === null) return view('start-slow', '시작 시각 미확인', { detail });
  if (now - startMs < START_SLOW_MS) return view('start', '시작 중', { detail, until: startMs + START_SLOW_MS, onceScope: 'nonce' });
  return view('start-slow', '시작 신호 대기', { detail });
}

/** stagePixel with the assignment's job, operation and wait reason found by its nonce. */
export function stagePixelOf(run, node, { now, limits = null, cancelling = false, autonomyRetry = null } = {}) {
  const nonce = node.active?.nonce ?? node.pendingReceipt?.nonce;
  const job = nonce ? (run.jobs ?? []).find((item) => item.nonce === nonce) ?? null : null;
  const operation = nonce ? (run.operations ?? []).find((item) => item.nonce === nonce) ?? null : null;
  return stagePixel({ run, node, job, operation, waiting: run.waiting?.[node.id] ?? null, limits, now, cancelling, autonomyRetry });
}

// Most urgent first; anything else is work in progress or a wait.
const URGENT = ['blocked', 'failed', 'approval', 'retry', 'start-slow', 'quiet', 'report', 'unknown'];
const LIVE = new Set(['work', 'review']);

/** "구조 설계" and "화면 설계" read as "구조·화면 설계"; other titles are joined. */
function joinTitles(nodes) {
  const titles = nodes.map(shortTitle);
  const tails = titles.map((text) => text.split(' ').at(-1));
  if (titles.every((text) => text.includes(' ')) && tails.every((tail) => tail === tails[0])) {
    return titles.map((text) => text.split(' ').slice(0, -1).join(' ')).join('·') + ' ' + tails[0];
  }
  return titles.join(' · ');
}

/**
 * The run header: what is happening, why it stopped, and whether something is for the person.
 * stages: [{ node, view }] from stagePixelOf.
 */
export function runPixel(run, stages, { cancelling = false } = {}) {
  const result = (pose, headline, extra = {}) => ({ pose, headline, detail: '', tone: TONES[pose], motion: 'still',
    person: false, nodeId: null, startedAt: null, activityAt: null, until: null, ...extra });
  if (run.status === 'completed') return result('completed', '실행 완료', { detail: '결과를 열거나 이어서 개선할 수 있습니다.' });
  if (cancelling) return result('cancelled', '취소 요청 처리 중');
  if (run.status === 'cancelled') {
    if (run.cancelUnsaved) return result('blocked', '취소 저장 대기', { person: true, detail: '저장되면 에이전트를 닫습니다.' });
    if (run.stopFailures?.length) return result('blocked', '종료 확인 필요', { person: true, detail: '일부 에이전트의 종료를 확인하지 못했습니다.' });
    return result('cancelled', '취소 완료');
  }
  const live = stages.filter((stage) => LIVE.has(stage.view.pose));
  const keep = live.length ? ' · 작업 ' + live.length + '개 계속' : '';
  const timing = (stage) => ({ nodeId: stage.node.id, startedAt: stage.view.startedAt, activityAt: stage.view.activityAt, until: stage.view.until });
  const urgent = stages.filter((stage) => URGENT.includes(stage.view.pose)).sort((a, b) => URGENT.indexOf(a.view.pose) - URGENT.indexOf(b.view.pose));
  if (urgent.length) {
    const top = urgent[0];
    return result(top.view.pose, shortTitle(top.node) + ' · ' + top.view.label, { ...timing(top), person: top.view.person,
      detail: [top.view.hint ?? top.view.detail, urgent.length > 1 ? '확인할 단계 ' + urgent.length + '개' : ''].filter(Boolean).join(' · ') + keep });
  }
  if (run.status === 'paused') return result('paused', '새 배정 멈춤' + keep, { detail: '재개하면 다음 단계를 배정합니다.' });
  if (live.length) {
    const oldest = live.reduce((first, stage) => (stage.view.startedAt ?? Infinity) < (first.view.startedAt ?? Infinity) ? stage : first);
    const newest = Math.max(...live.map((stage) => stage.view.activityAt ?? 0));
    const headline = live.length > 1 ? joinTitles(live.map((stage) => stage.node)) + ' · ' + live.length + '개 작업 중' : shortTitle(live[0].node) + ' · ' + live[0].view.label;
    return result(live[0].view.pose, headline, { ...timing(oldest), activityAt: newest || null, until: Math.min(...live.map((stage) => stage.view.until ?? Infinity)),
      detail: live.length === 2 ? '두 작업 신호 확인됨' : live.length > 2 ? live.length + '개 작업 신호 확인됨' : '작업 신호 확인됨', motion: 'loop' });
  }
  const starting = stages.find((stage) => stage.view.pose === 'start');
  if (starting) return result('start', shortTitle(starting.node) + ' · 시작 중', { ...timing(starting), detail: starting.view.detail });
  if (run.runtimeMessage || run.workspaceCreation?.state === 'uncertain') return result('blocked', '확인 필요', { person: true, detail: run.runtimeMessage ?? '작업 공간 생성 결과를 확인해 주세요.' });
  if (!run.started) return result('idle', '시작 전', { detail: '시작하면 첫 단계부터 배정합니다.' });
  const waiting = stages.find((stage) => stage.view.pose === 'queue') ?? stages.find((stage) => stage.view.pose === 'dependency');
  if (waiting) return result(waiting.view.pose, shortTitle(waiting.node) + ' · ' + waiting.view.label, { nodeId: waiting.node.id, detail: waiting.view.detail });
  return result('idle', '대기 중', { detail: '실행 중인 에이전트가 없습니다.' });
}

/**
 * One-shot motion memory, fed from every state push (never from rendering), so a re-render or a tab
 * return never replays a pose. observe(scope, value, now) records a value; a new non-empty value, or a
 * counter that grew, opens a motion window. delay() is how far into that window we are (for a negative
 * animation-delay); raised() is the counter value that grew against an earlier push.
 */
export function createMotionMemory() {
  const seen = new Map();
  const grew = (before, after) => after !== null && after !== undefined && (typeof after !== 'number' || typeof before !== 'number' || after > before);
  return {
    observe(scope, value, now) {
      const entry = seen.get(scope);
      if (!entry) { seen.set(scope, { value, at: null }); return; }
      if (entry.value === value) return;
      seen.set(scope, { value, at: grew(entry.value, value) ? now : null });
    },
    delay(scope, now) {
      const at = seen.get(scope)?.at;
      return typeof at === 'number' && now - at < ONCE_WINDOW_MS ? Math.max(0, now - at) : null;
    },
    raised(scope) {
      const entry = seen.get(scope);
      return typeof entry?.at === 'number' ? entry.value : null;
    },
  };
}
