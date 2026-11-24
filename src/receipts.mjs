/**
 * Files in a job's result folder (the receipt directory under ~/.toris-neon/runs): reading the
 * report without following symlinks or leaving the folder, and listing what the agent wrote.
 */
import { promises as fs, constants as FS_CONSTANTS } from 'node:fs';
import path from 'node:path';

const MAX_RECEIPT_BYTES = 256 * 1024;
const receiptError = (code, message) => Object.assign(new Error(message), { code });

export function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
export async function assertNoSymlinks(base, target, allowMissing = false) {
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw receiptError('invalid_params', '결과 파일이 실행 디렉터리 밖에 있습니다.');
  }
  let current = base;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw receiptError('invalid_params', '결과 경로에 심볼릭 링크를 사용할 수 없습니다.');
    } catch (error) {
      if (allowMissing && error.code === 'ENOENT') return;
      throw error;
    }
  }
}
export async function boundedJson(filename, base) {
  await assertNoSymlinks(base, filename);
  const file = await fs.open(filename, FS_CONSTANTS.O_RDONLY | (FS_CONSTANTS.O_NOFOLLOW || 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_RECEIPT_BYTES) {
      throw receiptError('invalid_params', '완료 보고서는 256 KiB 이하의 일반 JSON 파일이어야 합니다.');
    }
    return JSON.parse(await file.readFile('utf8'));
  } finally {
    await file.close();
  }
}

/** The files in a job's result folder; a missing folder is empty, any other error is thrown. */
export async function resultFiles(job, readdir = fs.readdir) {
  try { return await readdir(path.dirname(job.receiptPath)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
