/**
 * A report refused for its form (evidence shape, identifiers, missing artifact, malformed JSON) does
 * not mean the work is bad. The same agent, whose terminal is still open, is asked to correct only
 * the report, at most MAX_REPORT_FIXES times, before the stage falls back to a new attempt.
 */
export const MAX_REPORT_FIXES = 2;
export const REPORT_FIX_DELAY_MS = 3000;
// Room for every problem of a report in one request, under Orca's 4096-character typed prompt.
export const REPORT_FIX_REASON_CHARS = 2800;
const FORM_CODES = new Set(['invalid_report', 'invalid_evidence', 'invalid_input', 'missing_evidence', 'contradictory_evidence']);

/** A refusal raised by the receipt checks that only the report's author can correct. */
export const formError = (message) => Object.assign(new Error(message), { code: 'invalid_params', reportForm: true });

export const isReportFormError = (error) => Boolean(error) && !error.missingReceipt &&
  (error.reportForm === true || FORM_CODES.has(error.code) || error instanceof SyntaxError);

/** One line: a newline typed into an agent terminal would submit the request early. */
export function reportFixPrompt(reason, receiptPath, count, { commit = false, manual = false } = {}) {
  const why = String(reason).replace(/\s+/g, ' ').trim().slice(0, REPORT_FIX_REASON_CHARS);
  const round = manual ? '사람 요청' : count + '/' + MAX_REPORT_FIXES; // a person's request is outside the automatic two
  if (commit) {
    return '작업 결과가 이 실행 브랜치에 커밋되지 않았습니다 (' + round + '): ' + why +
      ' — 작업은 다시 하지 마세요. 이 단계에서 바꾼 파일을 이 실행 브랜치에 커밋한 뒤(무시 대상 파일 제외) ' + receiptPath + '의 보고서를 다시 저장하고 턴을 마치세요.';
  }
  return '완료 보고서가 형식 때문에 받아들여지지 않았습니다 (' + round + '): ' + why +
    ' — 작업은 다시 하지 마세요. ' + receiptPath + '의 JSON 보고서만 고쳐 같은 경로에 다시 저장하고 턴을 마치세요. ' +
    '0이 아닌 종료 코드가 기대 결과인 명령(예: 다름을 확인하는 diff의 1)은 "expectedExitCode"에 그 값을 적으세요.';
}

/**
 * Why a person's "report only" request (nodes.requestReport) is refused, or null. Without `agent` only
 * the stage is checked; with it (the agents.list row of the job's terminal, or null) the terminal too.
 * Only a stage blocked on its report's form, whose prompt was delivered, and whose agent ended its turn.
 */
export function reportRequestRefusal(run, node, job, agent) {
  if (['completed', 'cancelled'].includes(run.status) || node.status !== 'blocked' || node.active || !job?.reportFix ||
      job.state !== 'awaiting-report' || job.promptRecovery?.state !== 'sent' || !job.terminalId) {
    return '보고서 형식 때문에 멈춘 단계만 보고서를 다시 요청할 수 있습니다. 이미 요청했다면 에이전트의 다음 보고서를 기다리세요.';
  }
  if (agent === undefined) return null;
  if (agent?.agent !== job.agent || agent.state !== 'done') {
    return '같은 에이전트의 터미널이 열려 있고 턴이 끝난 상태일 때만 요청합니다. 입력을 기다리거나 일하는 중인 터미널에는 입력하지 않습니다. 터미널이 닫혔다면 이 단계를 재시도하세요.';
  }
  return null;
}
