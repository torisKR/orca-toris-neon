/** 실행 전 점검 on the run card (src/preflight.mjs): the verdict, counts, and each problem once with its stages and what to do. */
import { e, button, localDate, title } from './kit.mjs';

export const PREFLIGHT_LABELS = { ready: '실행 가능', blocked: '해당 단계 불가', check: '확인 필요' };
const BADGE = { ready: 'passed', blocked: 'failed', check: 'blocked' }; // the panel's existing mint / red / amber
const ORDER = { blocked: 0, check: 1, ready: 2 };
const badge = (state) => '<span class="badge ' + BADGE[state] + '">' + PREFLIGHT_LABELS[state] + '</span>';

// One entry per problem and state: the same missing SDK on four stages is said once, with the four stages.
function problems(stages) {
  const groups = new Map();
  for (const stage of stages) for (const reason of stage.reasons ?? []) {
    const key = reason.state + '\n' + reason.text;
    const group = groups.get(key) ?? { ...reason, stages: [] };
    group.stages.push(title(stage));
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => ORDER[a.state] - ORDER[b.state]);
}
const item = (problem, stages) => '<li class="preflight-item">' + badge(problem.state) + '<div class="grow"><p>' + e(problem.text) +
  (stages ? ' <span class="hint"><span aria-hidden="true">— </span>단계: ' + e(stages) + '</span>' : '') + '</p><p class="preflight-fix">할 일: ' + e(problem.fix) + '</p></div></li>';

/** One sentence for the screen-reader announcer after a check the person asked for. */
export function preflightSummary(entry) {
  if (entry?.error) return '실행 전 점검을 하지 못했습니다: ' + entry.error;
  const value = entry?.value;
  if (!value) return '';
  return '실행 전 점검 완료: ' + PREFLIGHT_LABELS[value.overall] + '. ' + ['blocked', 'check', 'ready'].filter((state) => value.counts?.[state]).map((state) => PREFLIGHT_LABELS[state] + ' ' + value.counts[state]).join(', ');
}

export function preflightBlock(entry, { runId }) {
  if (!entry) return '';
  const headingId = 'preflight-' + String(runId).replace(/[^\w-]/g, '_');
  const recheck = button(entry.loading ? '점검 중…' : '다시 점검', 'recheck-preflight', 'data-run="' + e(runId) + '"' + (entry.loading ? ' disabled' : ''), 'small');
  const open = '<section class="preflight" aria-labelledby="' + headingId + '"><div class="preflight-head"><h2 class="preflight-title" id="' + headingId + '">실행 전 점검</h2>';
  const value = entry.value;
  if (!value) {
    return open + (entry.loading ? '</div><p class="hint">단계별로 필요한 SDK와 설정을 점검하고 있습니다.</p>'
      : recheck + '</div><div class="callout warning" role="status">실행 전 점검을 하지 못했습니다: ' + e(entry.error ?? '원인 미확인') + '</div>') + '</section>';
  }
  const counts = ['blocked', 'check', 'ready'].filter((state) => value.counts?.[state]).map((state) => PREFLIGHT_LABELS[state] + ' ' + value.counts[state]).join(' · ');
  const list = [...(value.notices ?? []).map((notice) => item(notice, '')), ...problems(value.stages ?? []).map((problem) => item(problem, problem.stages.join(', ')))].join('');
  return open + badge(value.overall) + '<span class="hint grow">' + e(counts) + '</span>' + recheck + '</div>' +
    (entry.error ? '<div class="callout warning">다시 점검하지 못했습니다: ' + e(entry.error) + '. 아래는 ' + e(localDate(value.at, true)) + '에 확인한 이전 결과입니다.</div>' : '') +
    (list ? '<ul class="preflight-list">' + list + '</ul>' : '') +
    (value.conclusive ? '' : '<p class="hint">로그인 셸 환경을 읽지 못해 Orca의 PATH만 확인했습니다. 찾지 못한 도구는 해당 단계 불가 대신 확인 필요로 표시합니다.</p>') +
    '<p class="hint">빌드는 하지 않고 설치·설정 여부만 봤습니다' + (value.stack ? ' · ' + e(value.stack) : '') + ' · ' + e(localDate(value.at, true)) + ' 확인</p></section>';
}
