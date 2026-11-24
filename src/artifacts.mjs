/**
 * One result artifact for the panel, on request: images, short videos and GIFs as data, logs and
 * notes as a bounded excerpt. Only files inside the run's receipt folder or workspace, resolved
 * through symlinks, are ever read. Never part of a state push. A relative path is resolved against
 * the receipt folder of the report that recorded it, as at intake; a file whose SHA-256 is no longer
 * the one stored at intake is shown as 변경됨, never as its content (roadmap item 5).
 */
import { promises as fs, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

export const ARTIFACT_LIMITS = Object.freeze({ mediaBytes: 1_500_000, textChars: 20_000 });
const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const TEXT = new Set(['.log', '.txt', '.md', '.json']);
const refuse = (message) => Object.assign(new Error(message), { code: 'invalid_params' });
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };

async function digest(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** `sha256`: the hash stored at intake; the file is shown only while it still has it. */
export async function readArtifact({ file, roots, sha256 = null }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw refuse('결과 파일 경로가 올바르지 않습니다.');
  let real;
  try { real = await fs.realpath(file); } catch { throw refuse('결과 파일을 찾을 수 없습니다.'); }
  const realRoots = await Promise.all(roots.filter(Boolean).map((root) => fs.realpath(root).catch(() => null)));
  if (!realRoots.some((root) => root && inside(root, real))) throw refuse('이 실행 결과 폴더나 작업 공간 밖의 파일은 열 수 없습니다.');
  const ext = path.extname(real).toLowerCase();
  if (!MEDIA[ext] && !TEXT.has(ext)) throw refuse('표시할 수 없는 파일 형식입니다: ' + ext);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw refuse('일반 파일만 열 수 있습니다.');
  if (sha256) {
    const now = await digest(real);
    if (now !== sha256) return { kind: 'changed', size: stat.size, text: '변경됨: 보고서를 받은 뒤 이 파일이 바뀌어 내용을 표시하지 않습니다 (접수 sha256 ' + sha256.slice(0, 12) + ', 현재 ' + now.slice(0, 12) + ').' };
  }
  const verified = Boolean(sha256);
  if (MEDIA[ext]) {
    if (stat.size > ARTIFACT_LIMITS.mediaBytes) throw refuse('파일 크기가 너무 큽니다(' + stat.size + '바이트, 최대 ' + ARTIFACT_LIMITS.mediaBytes + '바이트).');
    return { kind: MEDIA[ext].startsWith('video') ? 'video' : 'image', mime: MEDIA[ext], size: stat.size, verified, data: (await fs.readFile(real)).toString('base64') };
  }
  const handle = await fs.open(real, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, ARTIFACT_LIMITS.textChars * 4));
    await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8').slice(0, ARTIFACT_LIMITS.textChars);
    return { kind: 'text', size: stat.size, verified, text, truncated: stat.size > Buffer.byteLength(text) };
  } finally { await handle.close(); }
}

/** The report item that recorded `file` and where it is: absolute as written, or under that report's receipt folder. */
export function recordedArtifact(run, file, receiptRoot) {
  for (const node of run.nodes ?? []) {
    for (const report of [node.report, node.review]) {
      const item = (report?.evidence ?? []).find((entry) => entry.kind === 'artifact' && entry.path === file);
      if (!item) continue;
      const folder = report.nonce && report.phase && report.attempt !== undefined ? path.join(receiptRoot, run.id, report.nodeId ?? node.id, report.attempt + '-' + report.phase + '-' + report.nonce) : null;
      const resolved = path.isAbsolute(file) ? file : folder ? path.resolve(folder, file) : null;
      const sha256 = item.sha256 ?? node.receipt?.artifacts?.find((entry) => entry.path === resolved)?.sha256 ?? null;
      return { item, resolved, sha256 };
    }
  }
  return null;
}

/** The `artifacts.read` panel request: { runId, path } → one artifact a report of that run recorded. */
export function artifactReader({ runs, receiptRoot }) {
  return async ({ runId, path: file } = {}) => {
    const run = typeof runId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId) ? runs().find((item) => item.id === runId) : null;
    if (!run) throw refuse('실행을 찾을 수 없습니다.');
    const found = typeof file === 'string' ? recordedArtifact(run, file, receiptRoot) : null;
    if (!found) throw refuse('보고서에 산출물로 기록된 파일만 열 수 있습니다.');
    if (!found.resolved) throw refuse('상대 경로를 기록한 보고서의 결과 폴더를 알 수 없습니다.');
    const receiptDirectory = path.join(receiptRoot, run.id);
    const owned = await fs.lstat(receiptDirectory).then((stat) => stat.isDirectory(), () => false);
    return readArtifact({ file: found.resolved, roots: [owned ? receiptDirectory : null, run.workspacePath], sha256: found.sha256 });
  };
}
