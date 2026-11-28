/**
 * A review must not pass work the next stage will fail. Each follow-up a reviewer lists is
 * classified: a "defect" breaks one of the stage's completion criteria, so the review fails now as a
 * code defect and the stage repairs it (cheaper than finding it a stage later); a "later" item is a
 * recorded follow-up that later stages may not fail on by itself. A failed test names the completion
 * criterion it breaks. Work reports may still list plain follow-up text.
 */
export const FOLLOW_UP_CLASSES = Object.freeze(['defect', 'later']);
import { REPORT_LIMITS, overCap } from './reportlimits.mjs';
const MAX_FOLLOW_UPS = REPORT_LIMITS.followUps;
const fail = (message) => { throw Object.assign(new Error(message), { code: 'invalid_report' }); };
const text = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(label + ' 값이 필요합니다 (최대 ' + max + '자).');
  return value.trim();
};
const CLASSIFY = '검토 보고서의 followUps는 항목마다 {"text": "…", "class": "defect", "criterion": "깨지는 완료 조건"} 또는 {"text": "…", "class": "later"}로 분류해야 합니다.';

function classified(item) {
  if (!item || typeof item !== 'object' || !FOLLOW_UP_CLASSES.includes(item.class)) fail(CLASSIFY);
  const entry = { text: text(item.text, '후속 과제', REPORT_LIMITS.followUpText), class: item.class };
  if (item.class === 'defect') entry.criterion = text(item.criterion, 'defect 후속 과제가 깨는 완료 조건(criterion)', 300);
  return entry;
}

/** { followUps?: string[] (later), followUpDefects?: [{ text, criterion }] } from a report. */
export function followUpFieldsOf(report) {
  if (report.followUps === undefined) return { followUpDefects: undefined }; // never an agent-written value
  if (!Array.isArray(report.followUps)) fail('followUps는 최대 ' + MAX_FOLLOW_UPS + '개 배열이어야 합니다.');
  if (report.followUps.length > MAX_FOLLOW_UPS) fail(overCap('followUps', report.followUps.length, MAX_FOLLOW_UPS));
  // Only a passing review must classify: a failed or blocked verdict is recorded whatever its follow-ups look like.
  const plain = report.phase !== 'review' || (report.outcome !== 'passed' && report.followUps.every((item) => typeof item === 'string'));
  if (plain) return { followUps: report.followUps.map((item) => text(item, '후속 과제', REPORT_LIMITS.followUpText)), followUpDefects: undefined };
  const items = report.followUps.map(classified);
  const defects = items.filter((item) => item.class === 'defect').map(({ text: what, criterion }) => ({ text: what, criterion }));
  return { followUps: items.filter((item) => item.class === 'later').map((item) => item.text), followUpDefects: defects.length ? defects : undefined };
}

/** A passed review that lists a criterion-breaking follow-up is a failed review with a code defect. */
export function failOnDefects(report) {
  if (report.phase !== 'review' || report.outcome !== 'passed' || !report.followUpDefects?.length) return report;
  const lines = report.followUpDefects.map((item) => item.text + ' (깨지는 완료 조건: ' + item.criterion + ')');
  return { ...report, outcome: 'failed', failureClass: 'code', reviewedAs: 'passed',
    summary: ('완료 조건을 깨는 후속 과제가 있어 이 단계에서 고칩니다: ' + lines.join('; ') + ' — 검토 요약: ' + report.summary).slice(0, 16000) };
}

/** A failed test that sends work back to build (a code defect) names the completion criterion it breaks. */
export function requireBrokenCriterion(nodeId, report) {
  if (nodeId !== 'test' || report.phase !== 'work' || report.outcome !== 'failed' || ['external', 'check'].includes(report.failureClass)) return;
  if (!report.criteria?.some((item) => item.met === false)) {
    fail('테스트 실패 보고서에는 깨진 완료 조건을 "criteria": [{"criterion": "완료 조건", "met": false, "evidence": "재현 명령과 결과"}]로 적어야 합니다. 선행 단계의 후속 과제(later)만으로는 실패로 보고하지 마세요.');
  }
}
