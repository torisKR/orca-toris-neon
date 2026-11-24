/**
 * Roadmap item 2: a release link must point at the build that is uploaded. When a passed report
 * names a release file, Neon reads that file itself (src/buildid.mjs) and records its hash and build
 * identity on the link; a link whose file differs from what it claims, from the approved Play target,
 * or from an earlier link of the same versionCode blocks the stage. Before an approved submission is
 * typed, a file recorded for the approved versionCode is read again and must be unchanged.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { readBuildIdentity } from './buildid.mjs';

const conflict = (message) => Object.assign(new Error(message), { code: 'conflict' });
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };
const short = (hash) => String(hash ?? '없음').slice(0, 12);

/** The identity of `artifact`, a path relative to the workspace (or absolute) inside the workspace or result folder. */
export async function readReleaseFile(artifact, { workspacePath, receiptDirectory } = {}) {
  const file = path.resolve(workspacePath, artifact);
  let real;
  try { real = await fs.realpath(file); } catch { throw conflict('출시 링크의 파일을 찾을 수 없습니다: ' + artifact); }
  const roots = await Promise.all([workspacePath, receiptDirectory].filter(Boolean).map((root) => fs.realpath(root).catch(() => null)));
  if (!roots.some((root) => root && inside(root, real))) throw conflict('출시 링크의 파일이 작업 공간이나 실행 결과 폴더 밖에 있습니다: ' + artifact);
  return readBuildIdentity(real);
}

/** Binaries recorded on other passed stages of `run`, with the stage title. */
const earlierBinaries = (run, nodeId) => (run.nodes ?? []).filter((node) => node.id !== nodeId && node.status === 'passed' && node.report?.releaseLink?.binary)
  .map((node) => ({ title: node.title ?? node.id, binary: node.report.releaseLink.binary }));

function mismatches(identity, { link, submission, earlier }) {
  const problems = [];
  const differs = (label, claimed, actual) => { if (claimed !== undefined && claimed !== null && String(claimed) !== String(actual)) problems.push(label + ' ' + claimed + '인데 실제 파일은 ' + actual + '입니다.'); };
  differs('보고서의 패키지가', link.packageName, identity.packageName);
  differs('보고서의 versionCode가', link.versionCode, identity.versionCode);
  if (link.sha256 && String(link.sha256).toLowerCase() !== identity.sha256) problems.push('보고서의 sha256 ' + short(link.sha256) + '와 실제 파일 ' + short(identity.sha256) + '이 다릅니다.');
  if (submission) {
    differs('승인한 패키지가', submission.packageName, identity.packageName);
    differs('승인한 versionCode가', submission.versionCode, identity.versionCode);
  }
  for (const { title, binary } of earlier) {
    if (binary.versionCode === identity.versionCode && binary.packageName === identity.packageName && binary.sha256 !== identity.sha256) {
      problems.push(title + '에서 기록한 같은 versionCode ' + identity.versionCode + '의 파일(sha256 ' + short(binary.sha256) + ')과 다른 빌드입니다(' + short(identity.sha256) + ').');
    }
    if (binary.packageName === identity.packageName && binary.signingCertSha256 && identity.signingCertSha256 && binary.signingCertSha256 !== identity.signingCertSha256) {
      problems.push('서명 인증서가 ' + title + '의 기록(' + short(binary.signingCertSha256) + ')과 다릅니다(' + short(identity.signingCertSha256) + ').');
    }
  }
  return problems;
}

/**
 * At intake: the identity of the file a passed report's release link points to, or null when there
 * is no link; a file that cannot be read or does not match throws a conflict that blocks the stage.
 * `read(artifact)` is readReleaseFile bound to the run's folders.
 */
export async function recordReleaseBinary(run, node, report, { read, at }) {
  const link = report?.outcome === 'passed' ? report.releaseLink : null;
  if (!link || typeof link !== 'object' || typeof link.artifact !== 'string' || !link.artifact.trim()) return null; // src/kinds.mjs refuses a malformed link
  let identity;
  try { identity = await read(link.artifact.trim()); }
  catch (error) { throw conflict('출시 링크의 파일(' + link.artifact + ')을 AAB/APK로 읽지 못했습니다: ' + String(error?.message ?? error)); }
  const problems = mismatches(identity, { link, submission: node.approval?.submission, earlier: earlierBinaries(run, node.id) });
  if (problems.length) {
    throw conflict('출시 링크가 가리키는 실제 파일이 맞지 않아 이 결과를 받지 않았습니다: ' + problems.join(' ') + ' 실제로 올린(올릴) 파일을 가리키도록 보고서를 고치거나, 승인한 대상과 같은 빌드를 다시 만든 뒤 이 단계를 재시도하세요.');
  }
  return { ...identity, artifact: link.artifact.trim(), checkedAt: at };
}

/** Before an approved submission is typed: every recorded file of the approved package and versionCode is unchanged. */
export async function recheckBeforeSubmission(run, node, { read }) {
  const target = node.approval?.submission;
  if (!target) return;
  const recorded = earlierBinaries(run, node.id).filter(({ binary }) => binary.packageName === target.packageName && binary.versionCode === String(target.versionCode));
  for (const { title, binary } of recorded) {
    let now;
    try { now = await read(binary.artifact); }
    catch (error) { throw conflict('제출 전에 ' + title + '에서 기록한 출시 파일(' + binary.artifact + ')을 다시 읽지 못했습니다: ' + String(error?.message ?? error) + ' 파일을 되돌리거나 새 실행에서 다시 빌드·검증하세요.'); }
    if (now.sha256 !== binary.sha256) {
      throw conflict('제출 전에 다시 확인했더니 ' + title + '에서 기록한 출시 파일(' + binary.artifact + ')이 기록 이후 바뀌었습니다(sha256 ' + short(binary.sha256) + ' → ' + short(now.sha256) + '). 검증한 빌드가 아니므로 제출하지 않았습니다.');
    }
  }
}
