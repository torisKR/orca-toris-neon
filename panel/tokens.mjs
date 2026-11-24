/**
 * Token usage as the panel shows it (plan 6.6): compact figures (1.3M, 245K) that open to the exact
 * integer, the scope of what was counted, and the last check. Renders the summary the worker
 * computes (src/usage.mjs, tokenUsage on each summary run); never estimates or fills a gap with 0.
 */
import { e, localDate } from './kit.mjs';

export const SCOPE_LABELS = { partial: '일부 집계', pending: '집계 대기', unavailable: '집계 불가', session: '세션 누계' };
const UNATTRIBUTED = '단계 미분류';
const STALE_MS = 5 * 60_000; // five missed one-minute checks
const UNITS = [[1e3, 'K'], [1e6, 'M'], [1e9, 'B']];
const SCOPE_NOTE = 'Orca가 이 컴퓨터에 기록한 세션 합계입니다(하위 에이전트 포함 여부는 확인하지 않음). 현재 컨텍스트 크기·구독 잔여량·청구 금액과는 다른 값입니다.';

/** 950, 1K, 1.1K, 245K, 1.3M, 2B: one decimal at most, no ".0", and a unit boundary moves up (never 1000K). */
export function compactTokens(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  const n = Math.round(value);
  if (n < 1000) return String(n);
  let unit = UNITS.findLastIndex(([size]) => n >= size);
  let scaled = Math.round(n / UNITS[unit][0] * 10) / 10;
  if (scaled >= 1000 && unit < UNITS.length - 1) scaled = Math.round(n / UNITS[++unit][0] * 10) / 10;
  return String(scaled) + UNITS[unit][1];
}
export const exactTokens = (value) => Math.round(value).toLocaleString('ko-KR') + ' 토큰';
// Summaries carry a stable id so a background re-render keeps keyboard focus on them (panel/studio.mjs).
const summaryId = (...parts) => 'tok-' + parts.join('-').replace(/[^\w-]/g, '-');
const both = (value) => compactTokens(value) + ' (' + exactTokens(value) + ')';

function headline(usage) {
  if (usage.total !== null) return '토큰 ' + compactTokens(usage.total) + (SCOPE_LABELS[usage.scope] ? ' · ' + SCOPE_LABELS[usage.scope] : '');
  if (usage.scope === 'session' && usage.sessionTotal !== null) return '토큰 ' + SCOPE_LABELS.session + ' ' + compactTokens(usage.sessionTotal);
  return '토큰 ' + (SCOPE_LABELS[usage.scope] ?? SCOPE_LABELS.pending);
}

// Why the scope is what it is, one line per reason.
function reasons(usage) {
  const c = usage.counts ?? {};
  return [
    c.unmapped && '세션이 아직 확인되지 않은 배정 ' + c.unmapped + '개',
    c.waiting && '아직 기록이 없거나 0으로만 보고된 세션 ' + c.waiting + '개',
    c.missing && '목록에서 찾지 못한 세션 ' + c.missing + '개 · 마지막 확인값 유지',
    c.truncated && '조회 한도(최근 200개) 밖의 세션 ' + c.truncated + '개 · 마지막 확인값 유지',
    usage.listTruncated && !c.truncated && 'Orca 세션 목록이 조회 한도에서 잘렸습니다.',
    c.invalid && 'Orca가 토큰 값을 정수로 주지 않은 세션 ' + c.invalid + '개 · 마지막 확인값 유지',
    c.lower && '이전보다 작은 값이 보고된 세션 ' + c.lower + '개 · 다시 확인될 때까지 마지막 값 유지',
    c.corrected && '기록 보정으로 값이 줄어든 세션 ' + c.corrected + '개',
    c.handedOver && '후속 실행이 이어 쓴 세션 ' + c.handedOver + '개 · 넘겨준 시점까지만 포함',
    usage.error && '조회 실패' + (usage.failedAt ? ' (' + localDate(usage.failedAt) + ')' : '') + ': ' + usage.error,
  ].filter(Boolean);
}

function runDetail(usage) {
  const lines = [
    usage.total !== null && exactTokens(usage.total),
    usage.retry > 0 && '그중 재시도 ' + both(usage.retry) + ' · 합계에 이미 포함',
    usage.unattributed > 0 && UNATTRIBUTED + ' ' + both(usage.unattributed) + ' · 여러 배정이 같은 세션을 써서 단계를 나누지 않음',
    usage.sessionTotal !== null && SCOPE_LABELS.session + ' ' + both(usage.sessionTotal) + ' · 시작 기준값이 없는 이어 쓴 세션이라 이번 실행 합계에 넣지 않음',
    ...reasons(usage),
    usage.checkedAt ? '마지막 확인 ' + localDate(usage.checkedAt) : '아직 확인 전',
  ].filter(Boolean);
  return lines.map((line) => '<p>' + e(line) + '</p>').join('') + '<p class="hint">' + e(SCOPE_NOTE) + '</p>';
}

/** The run card (and, with `label`, the result card): compact total, scope, exact integer on open. */
export function runTokens(usage, { id, now = Date.now(), live = false, label = null }) {
  if (!usage) return '';
  const stale = live && usage.checkedAt && now - Date.parse(usage.checkedAt) > STALE_MS;
  const head = label && usage.total !== null ? label + ' ' + compactTokens(usage.total) + (SCOPE_LABELS[usage.scope] ? ' · ' + SCOPE_LABELS[usage.scope] : '') : headline(usage);
  return '<details class="token-usage" data-disclosure="tokens:' + e(id) + (label ? ':result' : '') + '"><summary id="' + e(summaryId(id, label ? 'result' : 'run')) + '">' +
    '<span class="token-figure">' + e(head) + '</span>' + (stale ? '<span class="token-stale"> · 마지막 확인 ' + e(localDate(usage.checkedAt, true)) + '</span>' : '') +
    '</summary><div class="token-detail">' + runDetail(usage) + '</div></details>';
}

const phaseText = (stage, phase) => (phase === 'review' ? '검토 ' : '작업 ') + (stage[phase] === null ? SCOPE_LABELS.pending : compactTokens(stage[phase]));

/** The stage detail: work / review, the retry part, the stage's own scope. Nothing for a stage that never ran. */
export function stageTokens(usage, node, runId, where = 'stage') {
  if (!usage || !((node.attempts ?? 0) + (node.reviewAttempts ?? 0))) return '';
  const stage = usage.stages?.[node.id];
  if (!stage || stage.work === null && stage.review === null) {
    const why = usage.scope === 'unavailable' ? SCOPE_LABELS.unavailable : stage?.uncounted && usage.sessionTotal !== null ? SCOPE_LABELS.session + '만 있음' : SCOPE_LABELS.pending;
    return '<p class="meta token-stage">토큰 ' + e(why) + (usage.unattributed > 0 ? ' · 실행에 ' + UNATTRIBUTED + ' ' + e(compactTokens(usage.unattributed)) : '') + '</p>';
  }
  // The stage's own doubt (an uncounted, missing or held session, a job without a session) or a failed read.
  const partial = stage.uncertain > 0 || Boolean(usage.error) || usage.scope === 'unavailable';
  // A phase that has not run yet is left out rather than shown as waiting for a count.
  const phases = ['work', 'review'].filter((phase) => stage[phase] !== null || (phase === 'review' ? node.reviewAttempts : node.attempts));
  const head = '토큰 ' + phases.map((phase) => phaseText(stage, phase)).join(' / ') + (stage.retry > 0 ? ' · 그중 재시도 ' + compactTokens(stage.retry) : '') + (partial ? ' · ' + SCOPE_LABELS.partial : '');
  const line = (phase) => stage[phase] === null ? '' : '<p>' + (phase === 'review' ? '검토 ' : '작업 ') + e(exactTokens(stage[phase])) + (stage.agents?.[phase]?.length ? ' · ' + e(stage.agents[phase].join(', ')) : '') + '</p>';
  return '<details class="token-usage token-stage" data-disclosure="tokens:' + e(runId + ':' + node.id + ':' + where) + '"><summary id="' + e(summaryId(runId, node.id, where)) + '"><span class="token-figure">' + e(head) + '</span></summary><div class="token-detail">' +
    line('work') + line('review') + (stage.retry > 0 ? '<p>그중 재시도 ' + e(exactTokens(stage.retry)) + ' · 작업·검토에 이미 포함</p>' : '') +
    (stage.uncertain ? '<p>아직 세지 못했거나 확인 중인 이 단계 세션·배정 ' + e(stage.uncertain) + '개</p>' : '') +
    '<p class="hint">이 단계 배정에 연결된 세션만 셉니다. ' + (usage.checkedAt ? '마지막 확인 ' + e(localDate(usage.checkedAt)) : '아직 확인 전') + '</p></div></details>';
}

/** Inside an agent button: the compact figure; screen readers hear the exact integer (the role is already named). */
export function memberTokens(usage, nodeId, role) {
  const value = usage?.stages?.[nodeId]?.[role === 'review' ? 'review' : 'work'];
  if (!Number.isFinite(value)) return '';
  return '<span class="member-tokens"><span aria-hidden="true">' + e(compactTokens(value)) + '</span><span class="sr-only">토큰 ' + e(Math.round(value).toLocaleString('ko-KR')) + '</span></span>';
}
