/**
 * Where the run's time and tokens went (src/costs.mjs): per stage and phase, minutes worked, minutes
 * waiting (queued, blocked, or stuck before the agent started) and tokens, with the run total.
 */
import { e } from './kit.mjs';
import { compactTokens } from './tokens.mjs';

const tokens = (value) => value === null || value === undefined ? '<span class="hint">집계 없음</span>' : e(compactTokens(value));
const time = (value, unknown = 0) => e(value ?? 0) + '분' + (unknown ? '<span class="hint"> + 알 수 없음</span>' : '');

export function costBlock(item) {
  const costs = item.costs;
  const rows = Object.entries(costs?.stages ?? {});
  if (!rows.length) return '';
  const title = (id) => item.nodes?.find((node) => node.id === id)?.title ?? id;
  const total = costs.total;
  const heaviest = [...rows].sort(([, a], [, b]) => (b.work.minutes + b.review.minutes + b.waitingMinutes) - (a.work.minutes + a.review.minutes + a.waitingMinutes))[0];
  return '<div class="result-part cost-block"><h4>시간과 토큰</h4>' +
    '<p>작업 <strong>' + e(total.workedMinutes) + '분</strong> · 대기 <strong>' + e(total.waitingMinutes) + '분</strong> · 토큰 <strong>' + tokens(total.tokens) + '</strong>' +
    (total.tokenScope && total.tokenScope !== 'complete' ? ' <span class="hint">(토큰 ' + e(total.tokenScope === 'partial' ? '일부 집계' : '집계 대기') + ')</span>' : '') + '</p>' +
    '<p class="hint">가장 오래 걸린 단계: ' + e(title(heaviest[0])) + '. 대기는 배정 차례·검토 차례·사람의 조치를 기다린 시간과 에이전트가 작업을 시작하지 못한 시간입니다.' +
    (total.unknown ? ' 끝난 시각이 기록되지 않은 작업 ' + e(total.unknown) + '개는 시간에서 뺐습니다.' : '') + '</p>' +
    '<table class="before-after cost-table"><caption class="sr-only">단계별 작업·검토·대기 시간과 토큰</caption><thead><tr><th scope="col">단계</th><th scope="col">작업</th><th scope="col">검토</th><th scope="col">대기</th></tr></thead><tbody>' +
    rows.map(([id, row]) => '<tr><th scope="row">' + e(title(id)) + '</th><td>' + time(row.work.minutes, row.unknown) + ' · ' + tokens(row.work.tokens) + '</td><td>' + time(row.review.minutes) + ' · ' + tokens(row.review.tokens) +
      '</td><td>' + time(row.waitingMinutes) + '</td></tr>').join('') + '</tbody></table></div>';
}
