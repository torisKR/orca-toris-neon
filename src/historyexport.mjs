/**
 * Roadmap item 9: export finished runs for another PC, only when the person presses export. Each run
 * goes to <chosen folder>/<run id>/ (run.json, index.html, thumbs/), so two Macs writing to one synced
 * folder never collide. A folder inside a Git repository whose remote is public is refused; when the
 * visibility cannot be read (no gh, another host) the person must confirm before anything is written.
 * Thumbnails are made only from images whose SHA-256 still matches intake (src/artifacts.mjs).
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { historyRecord } from './history.mjs';
import { historyPage } from './historypage.mjs';
import { readArtifact, recordedArtifact } from './artifacts.mjs';

export const EXPORT_SETTING = 'historyExportDir';
const EXEC_MS = 10_000;
const MAX_THUMBS = 8;
const THUMB_PIXELS = '320';
const COPY_BYTES = 300 * 1024; // without sips an image this small is copied as its own thumbnail
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const RUN_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const FINISHED = new Set(['completed', 'cancelled']);
const fail = (code, message) => Object.assign(new Error('[' + code + '] ' + message), { code });

const run = promisify(execFile);
const defaultExec = (file, args) => run(file, args, { encoding: 'utf8', timeout: EXEC_MS, windowsHide: true,
  env: { ...process.env, PATH: [process.env.PATH, '/opt/homebrew/bin', '/usr/local/bin'].filter(Boolean).join(path.delimiter), GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } });

/** none (not in git), local (no remote), private, public, or unknown, with each remote's visibility and why it is unknown. */
export async function repositoryVisibility(dir, exec = defaultExec) {
  let top;
  try { top = String((await exec('git', ['-C', dir, 'rev-parse', '--show-toplevel'])).stdout).trim(); }
  catch (error) {
    if (error?.code === 'ENOENT') return { state: 'unknown', remotes: [], detail: 'git을 실행하지 못해 Git 저장소 안인지 확인하지 못했습니다' };
    const said = String(error?.stderr ?? '') + ' ' + String(error?.message ?? '');
    // Only git's own answer means "not a repository"; a timeout or a refused (dubious ownership) repository is unknown.
    return /not a git repository/i.test(said) ? { state: 'none', remotes: [] } : { state: 'unknown', remotes: [], detail: 'Git이 이 폴더를 확인하지 못했습니다(' + said.trim().split('\n')[0].slice(0, 160) + ')' };
  }
  let names;
  try { names = String((await exec('git', ['-C', top, 'remote'])).stdout).split('\n').map((name) => name.trim()).filter(Boolean); }
  catch { return { state: 'unknown', remotes: [], detail: 'Git 원격 목록을 읽지 못했습니다.' }; }
  const remotes = [];
  for (const name of names) {
    let visibility = 'unknown', detail = '';
    try {
      const url = String((await exec('git', ['-C', top, 'remote', 'get-url', name])).stdout).trim();
      const answer = String((await exec('gh', ['repo', 'view', url, '--json', 'visibility', '-q', '.visibility'])).stdout).trim().toLowerCase();
      if (['public', 'private', 'internal'].includes(answer)) visibility = answer;
      else detail = 'gh가 공개 여부를 알려 주지 않았습니다';
    } catch (error) { detail = error?.code === 'ENOENT' ? 'gh가 설치돼 있지 않습니다' : 'gh가 이 원격의 공개 여부를 확인하지 못했습니다(GitHub가 아니거나 로그인 필요)'; }
    remotes.push({ name, visibility, ...(detail ? { detail } : {}) });
  }
  const state = !remotes.length ? 'local' : remotes.some((item) => item.visibility === 'public') ? 'public' : remotes.some((item) => item.visibility === 'unknown') ? 'unknown' : 'private';
  return { state, remotes };
}

async function targetFolder(settings, home) {
  let value;
  try { value = await settings?.get?.(EXPORT_SETTING); }
  catch (error) { throw fail('settings_unreadable', '플러그인 설정을 읽지 못했습니다: ' + String(error?.message ?? error)); }
  value = typeof value === 'string' ? value.trim() : '';
  if (!value) throw fail('settings_required', '플러그인 설정의 "기록 내보내기 폴더"에 다른 PC가 열 수 있는 폴더(비공개 저장소나 동기화 폴더)를 지정하세요.');
  const dir = value.startsWith('~/') ? path.join(home, value.slice(2)) : value;
  if (!path.isAbsolute(dir)) throw fail('invalid_params', '기록 내보내기 폴더는 절대 경로(또는 ~/로 시작)여야 합니다.');
  return dir;
}
/** The nearest folder that exists, so a target not created yet is still checked against its repository. */
async function existingAncestor(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    if (await fs.stat(current).then((stat) => stat.isDirectory(), () => false)) return current;
    if (path.dirname(current) === current) return current;
  }
}
async function writeAtomic(file, text) {
  await fs.writeFile(file + '.tmp', text, { mode: 0o644 });
  await fs.rename(file + '.tmp', file);
}

/** createHistoryExport(...).export({ runIds?, confirmUnknownVisibility? }); only on the person's action. */
export function createHistoryExport({ getRuns, settings, receiptRoot, readPlay = async () => null, exec = defaultExec, now = Date.now, home = homedir(), platform = process.platform }) {
  const makeThumbnail = async (source, target, loaded) => {
    if (platform === 'darwin') {
      try { await exec('sips', ['-Z', THUMB_PIXELS, source, '--out', target]); return true; } catch { /* fall back to a small copy */ }
    }
    if (loaded.size > COPY_BYTES) return false;
    await fs.writeFile(target, Buffer.from(loaded.data, 'base64'));
    return true;
  };
  const thumbnailsOf = async (item, folder) => {
    const marks = {};
    const roots = [path.join(receiptRoot, item.id), item.workspacePath];
    let count = 0;
    for (const node of item.nodes ?? []) {
      for (const evidence of (node.report?.evidence ?? []).filter((entry) => entry.kind === 'artifact' && IMAGE.test(entry.path ?? ''))) {
        const key = node.id + ':' + evidence.path, missing = (reason) => { marks['missing:' + key] = reason; };
        if (count >= MAX_THUMBS) { missing('실행당 축소본 ' + MAX_THUMBS + '장 한도를 넘었습니다.'); continue; }
        const found = recordedArtifact(item, evidence.path, receiptRoot);
        if (!found?.resolved || !found.sha256) { missing('접수할 때의 해시 기록이 없어 축소본을 만들지 않았습니다.'); continue; } // never verified at intake
        let loaded;
        try { loaded = await readArtifact({ file: found.resolved, roots, sha256: found.sha256 }); }
        catch (error) { missing('파일을 읽지 못했습니다: ' + String(error?.message ?? error)); continue; } // missing, outside or too large
        if (loaded.kind === 'changed') { marks['changed:' + key] = true; continue; }
        const name = 'thumbs/' + node.id + '-' + (count + 1) + path.extname(found.resolved).toLowerCase();
        if (await makeThumbnail(found.resolved, path.join(folder, name), loaded)) { marks[key] = name; count++; }
        else missing('sips로 줄이지 못했고 원본이 커서 축소본을 만들지 않았습니다.');
      }
    }
    return marks;
  };
  return {
    async export({ runIds, confirmUnknownVisibility = false } = {}) {
      if (runIds !== undefined && (!Array.isArray(runIds) || runIds.length > 100 || !runIds.every((id) => typeof id === 'string'))) throw fail('invalid_params', 'runIds는 실행 ID 문자열 배열이어야 합니다.');
      const dir = await targetFolder(settings, home);
      const visibility = await repositoryVisibility(await existingAncestor(dir), exec);
      if (visibility.state === 'public') throw fail('public_repository', '내보낼 폴더가 공개 저장소(' + visibility.remotes.filter((item) => item.visibility === 'public').map((item) => item.name).join(', ') + ') 안에 있습니다. 실행 기록에는 코드 경로·로그·패키지 이름이 들어 있으니 비공개 저장소나 동기화 폴더를 고르세요.');
      if (visibility.state === 'unknown' && confirmUnknownVisibility !== true) {
        const why = visibility.detail ?? visibility.remotes.filter((item) => item.visibility === 'unknown').map((item) => item.name + ': ' + item.detail).join('; ');
        throw fail('confirmation_required', '내보낼 폴더가 있는 Git 저장소의 공개 여부를 확인하지 못했습니다(' + why + '). 비공개임을 직접 확인했다면 확인하고 다시 내보내세요.');
      }
      const all = getRuns();
      const wanted = runIds ?? all.filter((item) => FINISHED.has(item.status)).map((item) => item.id);
      const exportedAt = new Date(now()).toISOString();
      let play = null, playError = null;
      try { play = await readPlay(); } catch (error) { playError = 'Play 관측값을 읽지 못했습니다: ' + String(error?.message ?? error); } // said in the record, never read as "none observed"
      const exported = [], skipped = [];
      for (const id of wanted) {
        const item = all.find((entry) => entry.id === id);
        if (!item || !RUN_ID.test(id)) { skipped.push({ runId: id, reason: '실행을 찾을 수 없습니다.' }); continue; }
        if (!FINISHED.has(item.status)) { skipped.push({ runId: id, reason: '끝난 실행(완료·취소)만 내보냅니다.' }); continue; }
        const folder = path.join(dir, id);
        await fs.rm(path.join(folder, 'thumbs'), { recursive: true, force: true });
        await fs.mkdir(path.join(folder, 'thumbs'), { recursive: true });
        const thumbnails = await thumbnailsOf(item, folder);
        const record = historyRecord(item, { exportedAt, receiptRoot, home, play, playError, thumbnails });
        await writeAtomic(path.join(folder, 'run.json'), JSON.stringify(record, null, 2) + '\n');
        await writeAtomic(path.join(folder, 'index.html'), historyPage(record));
        exported.push({ runId: id, thumbnails: Object.keys(thumbnails).filter((key) => !/^(changed|missing):/.test(key)).length });
      }
      return { folder: dir, exportedAt, visibility: visibility.state, exported, skipped };
    },
  };
}
