/**
 * Operations view (plan 5.4, 6.5): the jobs Neon holds now with their condition and last progress,
 * why stages wait, terminal cleanup, CPU/RAM scope, and a run's disk use with a cleanup preview.
 * Only what the worker recorded is shown; unmeasured values say 미측정, never 0.
 */
import { e, button, localDate, nodeNames, goalTitle } from './kit.mjs';
import { elapsed } from './teams.mjs';

/** src/operations.mjs jobCondition values, most urgent first. */
export const CONDITION_LABELS = {
  unclear: '전달 불명확', error: '실행 오류', 'needs-user': '사용자 응답 대기', report: '보고서 확인 필요',
  launching: '시작·지시 전달 중', idle: '응답 끝남 · 보고서 대기', unknown: '상태 미확인', working: '작업 중',
};
const CONDITION_BADGE = { unclear: 'blocked', error: 'failed', 'needs-user': 'awaiting-approval', report: 'blocked', launching: 'waiting', idle: 'paused', unknown: 'waiting', working: 'running' };
const ORDER = Object.keys(CONDITION_LABELS);
const PHASES = { work: '작업', review: '검토' };
const KIND_LABELS = { live: '진행 중 · 사용 중', referenced: '검증 근거로 참조', candidate: '정리 후보' };
const PROTECTED_LABELS = { signing: '보호 · 서명 자료 포함', tracked: '보호 · Git에 포함됐거나 확인하지 못함', unreadable: '보호 · 끝까지 읽지 못함' };

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '미확인';
  let value = bytes, unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit++; }
  return unit ? value.toFixed(1) + ' ' + UNITS[unit] : value + ' B';
}
const size = (item) => (item.truncated ? '최소 ' : '') + formatBytes(item.bytes);
const conditionBadge = (condition) => '<span class="badge ' + (CONDITION_BADGE[condition] ?? 'waiting') + '">' + e(CONDITION_LABELS[condition] ?? condition) + '</span>';
const since = (iso, now) => iso ? '<time data-since="' + e(iso) + '" datetime="' + e(iso) + '">' + e(elapsed(iso, now)) + '</time> 전' : '기록 없음';
const counts = (ops) => ORDER.map((key) => [key, ops.filter((op) => op.condition === key).length]).filter(([, n]) => n).map(([key, n]) => CONDITION_LABELS[key] + ' ' + n).join(' · ');
const newest = (ops) => ops.map((op) => op.lastProgressAt).filter(Boolean).sort().at(-1) ?? null;
const progressNote = (ops) => ops.some((op) => !op.lastProgressAt) && newest(ops) ? ' (일부 기록 없음)' : '';
const stageName = (op) => nodeNames[op.nodeId] ?? op.nodeId;

function jobRow(op, run, now) {
  return '<li class="ops-row">' + conditionBadge(op.condition) + '<div class="grow"><p><strong>' + e(stageName(op)) + ' · ' + e(PHASES[op.phase] ?? op.phase) + '</strong> <span class="hint">' +
    e(op.agent ?? '에이전트 미기록') + (op.attempt ? ' · 시도 ' + e(op.attempt) : '') + '</span></p><p class="hint">' + e(goalTitle(run.goal)) + ' · 마지막 진행 ' + since(op.lastProgressAt, now) + '</p>' + releaseControl(op, run) + '</div>' +
    (op.terminalId ? button('열기', 'focus-terminal', 'data-terminal="' + e(op.terminalId) + '" aria-label="' + e('열기: ' + stageName(op) + ' 터미널 · ' + goalTitle(run.goal)) + '"', 'small') : '') + '</li>';
}
// src/slotrelease.mjs: only a person who checked Orca frees the slot of a launch that never answered.
function releaseControl(op, run) {
  if (!op.releasable || !op.nonce) return '';
  const id = 'release-ack-' + e(op.nonce);
  return '<details class="ops-release"><summary>슬롯 해제…</summary><p class="hint" id="' + id + '-hint">Orca가 실행 요청에 답하지 않아 에이전트가 떠 있을 수 있습니다. Orca에서 확인한 뒤에만 해제하세요.</p>' +
    '<div class="release-confirm"><input type="checkbox" id="' + id + '" aria-describedby="' + id + '-hint"> <label for="' + id + '">Orca에서 이 요청으로 실행 중인 에이전트가 없음을 확인했습니다</label> ' +
    button('슬롯 해제', 'release-slot', 'data-run="' + e(run.id) + '" data-nonce="' + e(op.nonce) + '" aria-label="' + e('슬롯 해제: ' + stageName(op) + ' · ' + goalTitle(run.goal)) + '"', 'small') + '</div></details>';
}

function waitSummary(runs) {
  const reasons = new Map();
  for (const run of runs) for (const reason of Object.values(run.waiting ?? {})) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  return reasons.size ? [...reasons].map(([reason, n]) => reason + ' ' + n).join(' · ') : '대기 중인 단계 없음';
}

function cleanupTotals(runs) {
  const sum = { pending: 0, closed: 0, failed: 0, kept: 0 };
  for (const c of runs.map((run) => run.cleanup).filter(Boolean)) {
    sum.pending += c.pending ?? 0; sum.closed += c.closed ?? 0; sum.failed += c.failed?.length ?? 0; sum.kept += c.kept?.length ?? 0;
  }
  const parts = [['정리 대기', sum.pending], ['닫음', sum.closed], ['종료 확인 실패', sum.failed], ['작업 중이라 남김', sum.kept]].filter(([, n]) => n);
  return parts.length ? parts.map(([label, n]) => label + ' ' + n).join(' · ') : '정리할 터미널 없음';
}

/** The 에이전트 tab section: every job Neon holds across runs, wait reasons, cleanup and resource scope. */
export function operationsOverview({ runs = [], limits, resources, now = Date.now() }) {
  const jobs = runs.flatMap((run) => (run.operations ?? []).map((op) => ({ op, run })))
    .sort((a, b) => ORDER.indexOf(a.op.condition) - ORDER.indexOf(b.op.condition));
  const ops = jobs.map((item) => item.op);
  return '<section class="section ops" aria-labelledby="ops-title"><div class="section-heading"><h2 id="ops-title">운영 현황</h2><span class="hint">Neon 관리 작업 ' + jobs.length + '개' +
    (limits ? ' · 한도 ' + e(limits.activeJobs) : '') + '</span></div><div class="card">' +
    (jobs.length ? '<p class="ops-counts">' + e(counts(ops)) + '</p><ul class="ops-list">' + jobs.map(({ op, run }) => jobRow(op, run, now)).join('') + '</ul>'
      : '<p class="hint">지금 Neon이 배정한 작업이 없습니다.</p>') +
    '<dl class="ops-facts"><dt>대기 이유</dt><dd>' + e(waitSummary(runs)) + '</dd><dt>터미널 정리</dt><dd>' + e(cleanupTotals(runs)) + '</dd>' +
    '<dt>CPU·메모리</dt><dd>CPU·메모리 미측정 <span class="hint">— ' + e(resources?.reason ?? '측정 경로가 없습니다.') + '</span></dd></dl>' +
    '<p class="hint">Neon이 배정한 작업만 셉니다. 직접 실행한 다른 에이전트와 그 하위 프로세스는 포함하지 않습니다.</p></div></section>';
}

/** One line on the run card: this run's jobs by condition, newest progress and terminals awaiting cleanup. */
export function runOperationsLine(item, { now = Date.now() } = {}) {
  const ops = item.operations ?? [];
  const pending = item.cleanup?.pending ?? 0;
  if (!ops.length && !pending) return '';
  return '<p class="ops-run-line hint">' + [ops.length ? 'Neon 작업 ' + e(counts(ops)) + ' · 마지막 진행 ' + since(newest(ops), now) + progressNote(ops) : '', pending ? '터미널 정리 대기 ' + e(pending) : ''].filter(Boolean).join(' · ') + '</p>';
}

const kindLabel = (item) => item.kind === 'protected' ? PROTECTED_LABELS[item.reason] ?? '보호' : KIND_LABELS[item.kind] ?? item.kind;
const total = (list) => ({ bytes: list.reduce((sum, item) => sum + item.bytes, 0), truncated: list.some((item) => item.truncated) });

function diskValue(value, runId) {
  const receipts = value.receipts;
  const all = [...receipts.jobs, ...value.builds];
  const byKind = ['live', 'referenced', 'protected', 'candidate'].map((kind) => [kind, all.filter((item) => item.kind === kind)]).filter(([, list]) => list.length)
    .map(([kind, list]) => (kind === 'protected' ? '보호' : KIND_LABELS[kind]) + ' ' + size(total(list)));
  const candidates = all.filter((item) => item.kind === 'candidate');
  const row = (label, item) => '<li><span class="mono">' + e(label) + '</span> ' + e(size(item)) + ' — ' + e(kindLabel(item)) + '</li>';
  return (receipts.exists ? '<p>결과 폴더 <span class="mono">' + e(receipts.path) + '</span> · ' + e(size(receipts)) + ' · 파일 ' + (receipts.truncated ? '최소 ' : '') + e(receipts.files) + '개' +
      (receipts.unclassifiedBytes ? ' · 분류하지 못한 자료 ' + e(formatBytes(receipts.unclassifiedBytes)) + '(후보 아님)' : '') + '</p>' : '<p class="hint">결과 폴더가 아직 없습니다.</p>') +
    (byKind.length ? '<p class="hint">' + e(byKind.join(' · ')) + '</p>' : '') +
    (receipts.jobs.length ? '<details class="disk-list" data-disclosure="disk:' + e(runId) + '"><summary class="hint">결과 폴더 내역 ' + receipts.jobs.length + '개</summary><ul>' + receipts.jobs.map((item) => row(item.path, item)).join('') + '</ul></details>' : '') +
    '<h3 class="disk-subhead">작업 공간 빌드 출력</h3>' + (value.builds.length ? '<ul class="disk-builds">' + value.builds.map((item) => row(item.relative, item)).join('') + '</ul>' : '<p class="hint">' + e(value.buildsNote ?? '빌드 출력 폴더가 없습니다.') + '</p>') +
    '<div class="callout">정리 후보 ' + e(value.candidates.count) + '개 · ' + e(size({ bytes: value.candidates.bytes, truncated: candidates.some((item) => item.truncated) })) +
    '<br><span class="hint">미리보기만 제공합니다. Neon은 이 파일을 지우지 않습니다. 진행 중인 자료, 검증 근거, 서명 자료, Git에 포함된 파일은 후보에서 뺍니다.</span>' +
    (candidates.length ? '<ul aria-label="정리 후보 목록">' + candidates.map((item) => '<li class="mono">' + e(item.path) + '</li>').join('') + '</ul>' : '') + '</div>' +
    '<p class="hint">' + e(localDate(value.at, true)) + ' 확인 · 디스크 사용량은 메모리 사용량과 별개입니다.</p>';
}

/** One sentence for the screen-reader announcer after a disk check the person asked for. */
export function diskSummary(entry) {
  if (!entry?.value) return entry?.error ? '디스크 사용량을 확인하지 못했습니다: ' + entry.error : '';
  const { receipts, candidates } = entry.value;
  return '디스크 사용량 확인 완료: 결과 폴더 ' + size(receipts) + ', 정리 후보 ' + candidates.count + '개 ' + formatBytes(candidates.bytes) + (entry.error ? '. 다시 확인하지 못해 이전 결과입니다' : '');
}

/** The run card's disk section: asks first, then shows what runs.disk measured (src/disk.mjs). */
export function diskBlock(entry, { runId }) {
  const headingId = 'disk-' + String(runId).replace(/[^\w-]/g, '_');
  const check = button(entry?.loading ? '확인 중…' : entry?.value ? '다시 확인' : '디스크 사용량 확인', 'check-disk', 'data-run="' + e(runId) + '" aria-describedby="' + headingId + '"' + (entry?.loading ? ' aria-disabled="true"' : ''), 'small');
  const open = '<section class="disk" aria-labelledby="' + headingId + '"><div class="preflight-head"><h2 class="preflight-title" id="' + headingId + '">디스크 사용량</h2>' + check + '</div>';
  if (!entry) return open + '<p class="hint">이 실행의 결과 폴더와 Neon이 만든 작업 공간의 빌드 출력 크기를 확인합니다. 파일은 읽기만 합니다.</p></section>';
  if (!entry.value) return open + (entry.loading ? '<p class="hint" role="status">폴더 크기를 확인하고 있습니다.</p>' : '<div class="callout warning" role="status">디스크 사용량을 확인하지 못했습니다: ' + e(entry.error ?? '원인 미확인') + '</div>') + '</section>';
  return open + (entry.error ? '<div class="callout warning" role="status">다시 확인하지 못했습니다: ' + e(entry.error) + '. 아래는 이전 결과입니다.</div>' : '') + diskValue(entry.value, runId) + '</section>';
}
