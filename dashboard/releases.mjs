/**
 * The auto-app bot's Play release notes, read-only: memory/review-watch.md (「심사 중」, 「끝난 것」,
 * 「감시 밖에서 본 것」) and memory/deploys.md (one deploy per line or table row). Columns are found by
 * their header words, so a reordered or renamed column degrades to null instead of breaking the page;
 * a missing section or file becomes an error the page shows as "읽지 못함".
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { HOME } from './sources.mjs';

export const NOTES_DIR = path.join(HOME, '.orca/bots/auto-app/memory');
const MAX_BYTES = 512 * 1024;

const COLUMNS = {
  app: /^(앱|app|이름|name)/i, packageName: /package|패키지/i, account: /계정|account/i, version: /버전|version/i,
  memo: /메모|memo|note|다음/i, result: /결과|result|상태/i, checked: /확인|checked/i,
  date: /날짜|일자|date/i, track: /트랙|track/i, commit: /커밋|commit/i,
};
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim());
const isTableLine = (line) => line.trim().startsWith('|');
const isRule = (line) => /^[\s:|-]+$/.test(line) && line.includes('-');

/** First markdown table in `lines` as objects keyed by `columns` (unknown headers dropped); null when there is none. */
export function parseTable(lines, columns = COLUMNS) {
  const start = lines.findIndex(isTableLine);
  if (start < 0) return null;
  const block = lines.slice(start);
  const end = block.findIndex((line) => !isTableLine(line));
  const [head, ...body] = (end < 0 ? block : block.slice(0, end)).filter((line) => !isRule(line));
  const keys = cells(head).map((title) => Object.keys(columns).find((key) => columns[key].test(title)) ?? null);
  return body.map((line) => Object.fromEntries(cells(line).flatMap((value, index) => keys[index] && value ? [[keys[index], value]] : [])));
}

/** The lines under the first `## heading` that matches `pattern`; null when there is none. */
function sectionOf(text, pattern) {
  const found = text.split(/^##\s+/m).slice(1).find((part) => pattern.test(part.split('\n')[0]));
  return found ? found.split('\n').slice(1) : null;
}

const FOLLOW_UP = /공개되면|출시되면|승인 뒤|승인 후|후속|확대|필요/;
/** The follow-up part of a memo: its sentences about what happens next, else the whole memo. */
export function nextStep(memo) {
  if (!memo) return null;
  const sentences = memo.split(/(?<=\.)\s+/).filter((sentence) => FOLLOW_UP.test(sentence));
  return (sentences.length ? sentences.join(' ') : memo).slice(0, 300);
}

const dayOf = (text) => /(\d{4}-\d{2}-\d{2})/.exec(text ?? '')?.[1] ?? null;

/** review-watch.md → { inReview, done, outside, aliases, errors }; aliases: account name → handles seen as `Name(handle) = /u/N`. */
export function parseWatch(text) {
  const errors = [];
  const table = (title, pattern) => {
    const rows = parseTable(sectionOf(text, pattern) ?? []);
    if (!rows) { errors.push('「' + title + '」 표를 찾지 못했습니다'); return []; }
    const usable = rows.filter((row) => row.app);
    if (rows.length && !usable.length) errors.push('「' + title + '」 표에서 앱 열을 찾지 못했습니다');
    return usable;
  };
  const inReview = table('심사 중', /심사\s*중/).map((row) => ({ app: row.app, packageName: row.packageName ?? null,
    account: row.account ?? null, version: row.version ?? null, memo: row.memo ?? null, next: nextStep(row.memo) }));
  const done = table('끝난 것', /끝난/).map((row) => ({ app: row.app, version: row.version ?? null, result: row.result ?? null,
    checked: row.checked ?? null, day: dayOf(row.checked) })).toSorted((a, b) => String(b.day ?? '').localeCompare(String(a.day ?? ''))); // stable: file order within a day
  const outside = (sectionOf(text, /감시\s*밖/) ?? []).filter((line) => /^\s*[-*]\s/.test(line)).map((line) => line.replace(/^\s*[-*]\s+/, '').trim());
  const aliases = {};
  for (const [, name, handle] of text.matchAll(/([^\s(),:]+)\(([\w.-]+)\)\s*=\s*\/u\/\d/g)) aliases[name] = [...(aliases[name] ?? []), handle];
  return { inReview, done, outside, aliases, errors };
}

const DEPLOY_ORDER = ['app', 'version', 'track', 'commit', 'result'];
/** deploys.md → [{ date, app, version, track, commit, result }], newest first; a table or `- 2026-11-25 · app · …` lines. */
export function parseDeploys(text) {
  const lines = text.split('\n');
  const rows = parseTable(lines) ?? lines.filter((line) => dayOf(line) && !line.trim().startsWith('#')).map((line) => {
    const [date, ...rest] = line.replace(/^\s*[-*]\s+/, '').split(/\s+[·—]\s+|\s*\|\s*|\s*,\s+/).map((part) => part.trim()).filter(Boolean);
    return Object.fromEntries([['date', date], ...rest.slice(0, DEPLOY_ORDER.length).map((value, index) => [DEPLOY_ORDER[index], value])]);
  });
  return rows.map((row) => ({ date: dayOf(row.date), app: row.app ?? null, version: row.version ?? null,
    track: row.track ?? null, commit: row.commit ?? null, result: row.result ?? null }))
    .filter((row) => row.date && row.app).toSorted((a, b) => b.date.localeCompare(a.date));
}

const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Account names (and their handles) replaced by "Play 계정 N" in every field. `labels`: name → label from
 * Neon's Play accounts in order; a name Neon does not know gets the next free number.
 */
export function labelAccounts(watch, labels = new Map()) {
  const known = new Map(labels);
  for (const name of [...watch.inReview.map((row) => row.account), ...Object.keys(watch.aliases)]) {
    if (name && !known.has(name)) known.set(name, 'Play 계정 ' + (known.size + 1));
  }
  const words = [...known].flatMap(([name, label]) => [name, ...(watch.aliases[name] ?? [])].map((word) => [word, label]))
    .toSorted((a, b) => b[0].length - a[0].length);
  const hide = (text) => text == null ? text : words.reduce((out, [word, label]) =>
    out.replace(new RegExp('(?<![\\w가-힣])' + escape(word) + '(?:\\s*계정)?(?![\\w가-힣])', 'g'), label), text);
  return {
    inReview: watch.inReview.map((row) => ({ ...row, account: known.get(row.account) ?? hide(row.account), memo: hide(row.memo), next: hide(row.next) })),
    done: watch.done.map((row) => ({ ...row, app: hide(row.app), result: hide(row.result) })),
    outside: watch.outside.map(hide),
    errors: watch.errors,
  };
}

export async function readSmall(file) {
  const stat = await fs.stat(file);
  if (stat.size > MAX_BYTES) throw new Error(path.basename(file) + '이 512KB를 넘어 읽지 않았습니다');
  return { text: await fs.readFile(file, 'utf8'), at: stat.mtimeMs };
}

/** Both files, every failure kept as a message: { watch, watchAt, watchError, deploys, deploysError }. */
export async function readReleaseNotes(dir = NOTES_DIR) {
  const out = { watch: null, watchAt: 0, watchError: null, deploys: [], deploysError: null };
  try { const { text, at } = await readSmall(path.join(dir, 'review-watch.md')); out.watch = parseWatch(text); out.watchAt = at; }
  catch (error) { out.watchError = error.code === 'ENOENT' ? 'review-watch.md가 없습니다' : String(error.message); }
  try { out.deploys = parseDeploys((await readSmall(path.join(dir, 'deploys.md'))).text); }
  catch (error) { if (error.code !== 'ENOENT') out.deploysError = String(error.message); } // deploys.md is optional
  return out;
}

/** An app's place on the watch list: in review (by package id), else its newest finished entry (by exact name). */
export function watchFor(app, watch) {
  const review = watch.inReview.find((row) => row.packageName && app.packageIds.includes(row.packageName));
  if (review) return { state: 'review', version: review.version, account: review.account, next: review.next };
  const names = new Set([app.name, app.projectName, ...app.play.map((item) => item.name)].filter(Boolean));
  const done = watch.done.find((row) => names.has(row.app));
  return done ? { state: 'done', version: done.version, result: done.result, day: done.day } : null;
}
