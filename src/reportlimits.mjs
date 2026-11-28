/**
 * Every numeric limit of a stage report, in one place: the validators (src/engine.mjs, src/kinds.mjs,
 * src/followups.mjs, src/reportcheck.mjs) read these, and the brief states them from the same values
 * (reportLimitsText), so what an agent is told and what is enforced cannot drift apart.
 */
export const REPORT_LIMITS = Object.freeze({
  evidence: 30, // items in "evidence"
  summary: 16000, command: 4000, note: 12000, path: 4000, next: 4000, nonce: 160, // characters
  changes: 20, notVerified: 20, listText: 600, // "changes" and "notVerified": items and characters each
  criteria: 20, criterion: 300, criterionEvidence: 600,
  beforeAfter: 12, beforeAfterLabel: 120, beforeAfterValue: 300,
  followUps: 12, followUpText: 1000,
  products: 20, identity: 24,
  condition: 160, // each screenshot condition in "comparison"
  samples: 200, metrics: 8, measurementText: 600,
});
/** Screenshot conditions: what must be the same before and after for a fair comparison. */
export const CONDITION_KEYS = Object.freeze(['device', 'size', 'language', 'data']);

/**
 * The refusal for an array over its cap: how many to keep, and where the rest goes. Evidence keeps one
 * place free for the artifact file that holds the rest.
 */
export function overCap(label, count, max, { evidence = false } = {}) {
  const keep = evidence ? max - 1 : max;
  return label + '는 최대 ' + max + '개입니다(지금 ' + count + '개). 가장 중요한 ' + keep + '개만 남기고, 나머지는 결과 디렉터리의 파일 하나에 적어 ' +
    (evidence ? '그 파일을 artifact 근거 1개로 넣으세요.' : 'evidence에 artifact로 가리키세요.');
}

const L = REPORT_LIMITS;
/** The brief's report rules, generated from REPORT_LIMITS. */
export function reportLimitsText() {
  const conditions = '{' + CONDITION_KEYS.map((key) => '"' + key + '"').join(', ') + '}';
  return '보고서 형식 한도(넘거나 빠지면 보고서가 거절되고, 문제는 한 번에 모두 알려 드립니다): ' +
    '"evidence" 최대 ' + L.evidence + '개(command·artifact·note), "summary" 최대 ' + L.summary + '자, command 최대 ' + L.command + '자, note "text" 최대 ' + L.note + '자, artifact "path" 최대 ' + L.path + '자, "next" 최대 ' + L.next + '자. ' +
    '"changes"·"notVerified" 각각 최대 ' + L.changes + '개(항목마다 최대 ' + L.listText + '자), "criteria" 최대 ' + L.criteria + '개(항목마다 "criterion" 최대 ' + L.criterion + '자, "met" true/false 필수, "evidence" 최대 ' + L.criterionEvidence + '자), ' +
    '"beforeAfter" 최대 ' + L.beforeAfter + '개("label" 최대 ' + L.beforeAfterLabel + '자, "before"·"after" 각 최대 ' + L.beforeAfterValue + '자), "followUps" 최대 ' + L.followUps + '개(항목마다 최대 ' + L.followUpText + '자), "products" 최대 ' + L.products + '개, "identity" 최대 ' + L.identity + '개 항목. ' +
    '"comparison"은 {"before": ' + conditions + '} 그리고/또는 {"after": ' + conditions + '} 객체이고, 네 값 모두 필수이며 각 최대 ' + L.condition + '자입니다(예: "data": "샘플 메모 3개"). ' +
    '"measurement"는 "samples" 1~' + L.samples + ' 정수, "metrics" 1~' + L.metrics + '개, 지표마다 "values" 길이가 samples와 같아야 합니다. ' +
    '근거나 목록이 한도를 넘으면 가장 중요한 것만 남기고 나머지는 결과 디렉터리의 파일 하나에 적어 artifact로 가리키세요.';
}
