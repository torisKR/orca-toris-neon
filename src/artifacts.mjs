/**
 * One result artifact for the panel, on request: images, short videos and GIFs as data, logs and
 * notes as a bounded excerpt. Only files inside the run's receipt folder or workspace, resolved
 * through symlinks, are ever read. Never part of a state push.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const ARTIFACT_LIMITS = Object.freeze({ mediaBytes: 1_500_000, textChars: 20_000 });
const MEDIA = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm' };
const TEXT = new Set(['.log', '.txt', '.md', '.json']);
const refuse = (message) => Object.assign(new Error(message), { code: 'invalid_params' });
const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };

export async function readArtifact({ file, roots }) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw refuse('결과 파일 경로가 올바르지 않습니다.');
  let real;
  try { real = await fs.realpath(file); } catch { throw refuse('결과 파일을 찾을 수 없습니다.'); }
  const realRoots = await Promise.all(roots.filter(Boolean).map((root) => fs.realpath(root).catch(() => null)));
  if (!realRoots.some((root) => root && inside(root, real))) throw refuse('이 실행 결과 폴더나 작업 공간 밖의 파일은 열 수 없습니다.');
  const ext = path.extname(real).toLowerCase();
  if (!MEDIA[ext] && !TEXT.has(ext)) throw refuse('표시할 수 없는 파일 형식입니다: ' + ext);
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw refuse('일반 파일만 열 수 있습니다.');
  if (MEDIA[ext]) {
    if (stat.size > ARTIFACT_LIMITS.mediaBytes) throw refuse('파일 크기가 너무 큽니다(' + stat.size + '바이트, 최대 ' + ARTIFACT_LIMITS.mediaBytes + '바이트).');
    return { kind: MEDIA[ext].startsWith('video') ? 'video' : 'image', mime: MEDIA[ext], size: stat.size, data: (await fs.readFile(real)).toString('base64') };
  }
  const handle = await fs.open(real, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, ARTIFACT_LIMITS.textChars * 4));
    await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.toString('utf8').slice(0, ARTIFACT_LIMITS.textChars);
    return { kind: 'text', size: stat.size, text, truncated: stat.size > Buffer.byteLength(text) };
  } finally { await handle.close(); }
}

const recorded = (run, file) => (run.nodes ?? []).some((node) => [node.report, node.review].some((report) =>
  (report?.evidence ?? []).some((item) => item.kind === 'artifact' && item.path === file)));

/** The `artifacts.read` panel request: { runId, path } → one artifact a report of that run recorded. */
export function artifactReader({ runs, receiptRoot }) {
  return async ({ runId, path: file } = {}) => {
    const run = typeof runId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(runId) ? runs().find((item) => item.id === runId) : null;
    if (!run) throw refuse('실행을 찾을 수 없습니다.');
    if (!recorded(run, file)) throw refuse('보고서에 산출물로 기록된 파일만 열 수 있습니다.');
    const receiptDirectory = path.join(receiptRoot, run.id);
    const owned = await fs.lstat(receiptDirectory).then((stat) => stat.isDirectory(), () => false);
    return readArtifact({ file, roots: [owned ? receiptDirectory : null, run.workspacePath] });
  };
}
