/**
 * The form of a finished report, checked in one pass: its identifiers, its artifact files, the
 * artifact a pass needs, and every field rule of the engine (src/engine.mjs reportProblems), with the
 * caps from src/reportlimits.mjs. All problems go into one refusal, so the agent fixes them in one
 * request (src/reportfix.mjs) instead of meeting a new rule each round.
 */
import { formError } from './reportfix.mjs';
import { reportProblems } from './engine.mjs';

const IDENTIFIERS = ['runId', 'nodeId', 'nonce', 'phase', 'attempt'];
const MAX_ARTIFACT_CHECKS = 64; // an oversized list is refused anyway; its files are not all hashed

/** One refusal message for several problems. */
export const problemList = (problems) => problems.length === 1 ? problems[0]
  : '보고서에서 고칠 곳 ' + problems.length + '개: ' + problems.map((text, index) => (index + 1) + ') ' + text).join(' ');

/**
 * { report (artifact items carry the hash read now), artifacts } or a form refusal listing every
 * problem. artifactDetails(item, job) reads one artifact; describe(error) is a safe message.
 */
export async function checkReceiptForm({ run, job, report, artifactDetails, describe }) {
  const problems = [];
  for (const field of IDENTIFIERS) {
    if (report?.[field] !== job[field]) problems.push('완료 보고서의 ' + field + ' 식별자가 현재 배정과 다릅니다 (보고서: ' + JSON.stringify(report?.[field] ?? null) + ', 배정: ' + JSON.stringify(job[field]) + ').');
  }
  const evidence = Array.isArray(report?.evidence) ? report.evidence : [];
  const hashed = new Map();
  for (const item of evidence.slice(0, MAX_ARTIFACT_CHECKS)) {
    if (item?.kind !== 'artifact') continue;
    try { hashed.set(item, await artifactDetails(item, job)); }
    catch (error) { problems.push('artifact ' + String(item.path) + ': ' + (error.code === 'ENOENT' ? '파일이 없습니다.' : describe(error))); }
  }
  if (report?.outcome === 'passed' && !evidence.some((item) => item?.kind === 'artifact')) problems.push('성공 보고서에는 실제 검증 artifact가 한 개 이상 필요합니다.');
  if (report && typeof report === 'object') problems.push(...reportProblems(run, job.nodeId, report));
  if (problems.length) throw formError(problemList(problems));
  const artifacts = evidence.filter((item) => item.kind === 'artifact').map((item) => hashed.get(item));
  return { report: { ...report, evidence: evidence.map((item) => item.kind === 'artifact' ? { ...item, sha256: hashed.get(item).sha256 } : item) }, artifacts };
}
