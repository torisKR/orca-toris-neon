/**
 * A report refused for its form (evidence shape, identifiers, missing artifact, malformed JSON) does
 * not mean the work is bad. The same agent, whose terminal is still open, is asked to correct only
 * the report, at most MAX_REPORT_FIXES times, before the stage falls back to a new attempt.
 */
export const MAX_REPORT_FIXES = 2;
export const REPORT_FIX_DELAY_MS = 3000;
const FORM_CODES = new Set(['invalid_report', 'invalid_evidence', 'invalid_input', 'missing_evidence', 'contradictory_evidence']);

/** A refusal raised by the receipt checks that only the report's author can correct. */
export const formError = (message) => Object.assign(new Error(message), { code: 'invalid_params', reportForm: true });

export const isReportFormError = (error) => Boolean(error) && !error.missingReceipt &&
  (error.reportForm === true || FORM_CODES.has(error.code) || error instanceof SyntaxError);

/** One line: a newline typed into an agent terminal would submit the request early. */
export function reportFixPrompt(reason, receiptPath, count) {
  const why = String(reason).replace(/\s+/g, ' ').trim().slice(0, 900);
  return '완료 보고서가 형식 때문에 받아들여지지 않았습니다 (' + count + '/' + MAX_REPORT_FIXES + '): ' + why +
    ' — 작업은 다시 하지 마세요. ' + receiptPath + '의 JSON 보고서만 고쳐 같은 경로에 다시 저장하고 턴을 마치세요. ' +
    '0이 아닌 종료 코드가 기대 결과인 명령(예: 다름을 확인하는 diff의 1)은 "expectedExitCode"에 그 값을 적으세요.';
}
