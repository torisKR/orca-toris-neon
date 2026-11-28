/**
 * The target block (src/target.mjs): who the app is for, read first, then the promise, who it is not
 * for, the voice with real copy, the look, what to avoid and the signals. Shown on a passed brief and,
 * for an improvement, on the identity stage (the existing app's current target, possibly inferred).
 * Reuses the research block styles. Empty for reports without a target, so older runs are unchanged.
 */
import { e } from './kit.mjs';

const part = (heading, body) => body ? '<div class="result-part"><h5>' + heading + '</h5>' + body + '</div>' : '';
const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : [];
const list = (items) => items.length ? '<ul>' + items.map((item) => '<li>' + e(item) + '</li>').join('') + '</ul>' : '';
const field = (label, value) => typeof value === 'string' && value ? '<p class="research-who"><strong>' + label + '</strong> ' + e(value) + '</p>' : '';
const para = (value, cls = '') => typeof value === 'string' && value ? '<p' + (cls ? ' class="' + cls + '"' : '') + '>' + e(value) + '</p>' : '';
const record = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

/** Reads stored state defensively: older or hand-edited targets render what is well-formed. */
export function targetBlock(report) {
  const inferred = !report?.target && Boolean(report?.identity?.target);
  const target = record(inferred ? report.identity.target : report?.target);
  if (typeof target.primaryUser !== 'string' || !target.primaryUser) {
    // Present but unusable: said, as the stage prompts say it, instead of an empty card.
    return Object.keys(target).length ? '<p class="hint target-unreadable">저장된 타겟을 읽을 수 없습니다(주 사용자 없음). 보고서와 brief.md의 "## 타겟"을 확인하세요.</p>' : '';
  }
  const voice = record(target.voice), look = record(target.look);
  const examples = strings(voice.examples);
  return '<div class="research-findings target-findings">' +
    '<h5>' + (inferred ? '현재 타겟' : '타겟') + '</h5><p class="hint target-note">' + (inferred ? '기존 앱에서 읽은 것입니다. (추정)은 추론한 값입니다.' : '이 앱이 누구를 위한 것인지') + '</p>' +
    '<p class="research-decision"><strong>주 사용자</strong> ' + e(target.primaryUser) + '</p>' +
    field('약속', target.promise) +
    field('쓰는 순간', target.job) +
    part('대상이 아닌 사람', list(strings(target.notFor))) +
    part('말투', para(voice.tone) + (examples.length ? '<ul class="target-copy" role="list">' + examples.map((item) => '<li>“' + e(item) + '”</li>').join('') + '</ul>' : '')) +
    part('시각 방향', para(look.direction) + (look.direction && typeof look.why === 'string' && look.why ? '<p class="hint">이유: ' + e(look.why) + '</p>' : '')) +
    part('피할 것', list(strings(target.avoid))) +
    part('맞는지 보는 신호', list(strings(target.signals))) +
    '</div>';
}
