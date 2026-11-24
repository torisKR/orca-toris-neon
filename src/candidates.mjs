/**
 * Diagnosis candidates (template 'diagnose'): the report field each improvement is started from
 * (src/flows.mjs fromDiagnosis), its contract for the brief, and the check that a passed diagnosis
 * carries 3-5 of them. Refusals are report-form errors (src/reportfix.mjs), so the same agent adds
 * the field instead of the stage running again. Pure: no engine import, the kinds are passed in.
 */
export const MIN_CANDIDATES = 3;
export const MAX_CANDIDATES = 5;
const FIELDS = ['title', 'problem', 'evidence', 'impact', 'scope', 'verify'];
// Names agents reach for when they follow the plan's wording; read as the canonical field.
const ALIASES = { impact: 'userImpact', verify: 'verification' };

const fail = (message) => { throw Object.assign(new Error(message), { code: 'invalid_report' }); };
const text = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(label + ' 값이 필요합니다(최대 ' + max + '자).');
  return value.trim();
};

const SHAPE = '{"kind", "title", "problem", "evidence", "impact", "scope", "verify"}';
const EXAMPLE = '{"kind": "bugfix", "title": "재부팅 후 알람이 두 번 울림", "problem": "부팅 복원이 이미 예약된 알람을 한 번 더 등록한다", ' +
  '"evidence": "AlarmScheduler.kt:88 중복 등록, 결과 디렉터리의 repro.log", "impact": "사용자가 같은 알람을 두 번 받는다", ' +
  '"scope": "AlarmScheduler 부팅 복원 경로만", "verify": "재부팅 뒤 예약 수가 1인지 보는 단위 테스트"}';

/** The brief's contract: exact field names, the kinds a person can start, and one example. */
export function candidatesContract(kinds) {
  return '보고서(result.json)에 "candidates": [...] 배열로 후보 ' + MIN_CANDIDATES + '~' + MAX_CANDIDATES + '개를 적으세요. 각 후보는 ' + SHAPE + '이고 ' +
    '"kind"는 ' + kinds.join('|') + ' 중 하나, "evidence"는 실제로 확인한 근거(파일:라인, 명령 출력), "impact"는 사용자 영향, "scope"는 바꿀 범위, "verify"는 검증 방법입니다. ' +
    '예: ' + EXAMPLE + '. verification.md에만 적으면 패널이 개선을 시작할 수 없습니다. 같은 후보를 반드시 이 배열에도 적으세요.';
}

/** A report's candidates, normalized: 3-5 objects of a known kind with every field filled in. */
export function candidatesOf(value, kinds) {
  if (!Array.isArray(value) || value.length < MIN_CANDIDATES || value.length > MAX_CANDIDATES) {
    fail('"candidates"는 ' + MIN_CANDIDATES + '~' + MAX_CANDIDATES + '개의 개선 후보 배열이어야 합니다. 각 후보: ' + SHAPE + '.');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || !kinds.includes(item.kind)) fail('candidates[' + index + '].kind는 ' + kinds.join(', ') + ' 중 하나여야 합니다.');
    return { kind: item.kind, ...Object.fromEntries(FIELDS.map((field) =>
      [field, text(item[field] ?? item[ALIASES[field]], 'candidates[' + index + '].' + field, field === 'title' ? 160 : 1500)])) };
  });
}

/** Refuses a passed diagnosis work report with no candidates; their shape is checked by candidatesOf. */
export function requireCandidates(run, nodeId, report) {
  if (run.template !== 'diagnose' || nodeId !== 'diagnose' || report.phase !== 'work' || report.outcome !== 'passed' || report.candidates) return;
  fail('진단 보고서에 "candidates" 배열이 없습니다. verification.md의 후보 ' + MIN_CANDIDATES + '~' + MAX_CANDIDATES + '개를 ' + SHAPE +
    ' 형식으로 result.json의 "candidates"에 옮겨 적으세요. 예: ' + EXAMPLE);
}
