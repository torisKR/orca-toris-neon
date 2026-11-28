/**
 * One evidence item of a stage report (command, artifact or note) and the rule that a failed command
 * never supports a pass. Split from src/engine.mjs; the limits come from src/reportlimits.mjs.
 */
import { REPORT_LIMITS as LIMITS } from './reportlimits.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const requiredText = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid_input', label + ' 값을 확인하세요 (최대 ' + max + '자).');
  return value.trim();
};
const copy = (value) => structuredClone(value);
const ARTIFACT_LABELS = new Set(['mockup', 'screenshot']);
const COMMAND_ROLES = new Set(['check', 'history']);
/**
 * A failed command never supports a pass. A command succeeds when it exits with its expected code:
 * 0, or `expectedExitCode` when a non-zero exit is the point (diff showing a difference, a listing
 * proving a file is absent). A failure may stay as history (an earlier try that was redone):
 * explicitly with role 'history', or without a role when another command in the report succeeded.
 * A failed 'check', or a pass whose only commands failed, is refused, naming the entry so the
 * agent can correct its report. Marks lenient history entries on the fresh normalized entries.
 */
const commandSucceeded = (item) => item.exitCode === (item.expectedExitCode ?? 0);
export function classifyFailedCommands(evidence) {
  const succeeded = evidence.some(item => item.kind === 'command' && commandSucceeded(item));
  evidence.forEach((item, index) => {
    if (item.kind !== 'command' || commandSucceeded(item) || item.role === 'history') return;
    if (item.role === 'check' || !succeeded) {
      fail('contradictory_evidence', '실패한 명령을 통과 근거로 사용할 수 없습니다: evidence[' + index + '] (' + item.command.slice(0, 120) + ')의 exitCode가 ' +
        item.exitCode + '입니다. 이 종료 코드가 기대한 결과라면 "expectedExitCode": ' + item.exitCode + '를 적고, 실패 후 다시 실행한 기록이면 "role": "history"로 적으세요.');
    }
    item.role = 'history';
  });
}
const exitCodeOf = (value) => typeof value === 'string' && /^-?\d{1,5}$/.test(value.trim()) ? Number(value) : value;

/** evidence[index] normalized, or a refusal that names the item. */
export function evidenceItem(item, index) {
  try { return evidenceItemOf(item); } catch (error) { error.message = 'evidence[' + index + ']: ' + error.message; throw error; }
}
function evidenceItemOf(item) {
  if (!item || typeof item !== 'object') fail('invalid_evidence', '결과 근거 형식이 잘못되었습니다.');
  if (item.kind === 'command') {
    const command = requiredText(item.command, '실행한 명령', LIMITS.command);
    // Agents write exit codes as numbers or numeric strings; compare them as numbers.
    const exitCode = exitCodeOf(item.exitCode);
    if (!Number.isInteger(exitCode)) fail('invalid_evidence', '명령 종료 코드가 필요합니다.');
    const expected = exitCodeOf(item.expectedExitCode);
    if (expected !== undefined && !Number.isInteger(expected)) fail('invalid_evidence', 'expectedExitCode는 정수여야 합니다.');
    if (item.role !== undefined && !COMMAND_ROLES.has(item.role)) fail('invalid_evidence', '명령 role은 check 또는 history여야 합니다.');
    return { ...copy(item), kind: 'command', command, exitCode, ...(expected === undefined ? {} : { expectedExitCode: expected }) };
  }
  if (item.kind === 'artifact') {
    if (item.label !== undefined && !ARTIFACT_LABELS.has(item.label)) fail('invalid_report', '이미지 label은 mockup(시안) 또는 screenshot(실제 화면)이어야 합니다.');
    return { ...copy(item), kind: 'artifact', path: requiredText(item.path, '산출물 경로', LIMITS.path) };
  }
  if (item.kind === 'note') {
    // Agents sometimes write the note under `note`; keep it as the canonical `text`.
    const { note, ...rest } = copy(item);
    return { ...rest, kind: 'note', text: requiredText(item.text ?? note, '확인 근거', LIMITS.note) };
  }
  fail('invalid_evidence', 'command, artifact, note 근거만 지원합니다.');
}

