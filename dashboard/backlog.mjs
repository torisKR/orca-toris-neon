/**
 * The auto-app bot's development backlog, read-only: memory/backlog.md is one Markdown table
 * (우선 | 앱(Orca 프로젝트) | 종류 | 목표 | 상태 | 메모). 상태 is ready, running(item N), pr(link), done(link)
 * or blocked(reason). Columns are found by their header words like releases.mjs; an unknown 상태 is kept
 * as 'unknown' with its text, and a missing file becomes an error the page shows as "읽지 못함".
 */
import path from 'node:path';
import { NOTES_DIR, parseTable, readSmall } from './releases.mjs';

const COLUMNS = {
  priority: /우선|priority/i, app: /^(앱|app|프로젝트|project)/i, kind: /종류|kind|type/i,
  goal: /목표|goal/i, state: /상태|state|status/i, memo: /메모|memo|note/i,
};
export const STATES = ['running', 'pr', 'blocked', 'ready', 'done'];
const URL_IN = /https?:\/\/[^\s)<>"'`\]]+/;

/** `running(item 3, https://…/pull/7)` → { state: 'running', detail: 'item 3', link: 'https://…/pull/7' }; an unknown word → 'unknown' with the whole text. */
export function parseState(text = '') {
  const match = /^\s*`?([a-z_]+)`?\s*(?:\((.*)\))?/i.exec(text);
  const word = match?.[1].toLowerCase();
  const link = URL_IN.exec(text)?.[0] ?? null;
  if (!STATES.includes(word)) return { state: 'unknown', detail: text.trim() || null, link };
  const detail = (match[2] ?? '').replace(link ?? '\0', '').replace(/^[\s,·:-]+|[\s,·:-]+$/g, '');
  return { state: word, detail: detail || null, link };
}

/** backlog.md → { items, errors }; items in priority order (rows without a number last, in file order). */
export function parseBacklog(text) {
  const rows = parseTable(text.split('\n'), COLUMNS);
  if (!rows) return { items: [], errors: ['백로그 표를 찾지 못했습니다'] };
  const items = rows.filter((row) => row.app || row.goal).map((row) => {
    const priority = Number.parseInt(row.priority ?? '', 10);
    return { priority: Number.isFinite(priority) ? priority : null, app: row.app ?? null, kind: row.kind ?? null,
      goal: row.goal ?? null, memo: row.memo ?? null, ...parseState(row.state) };
  });
  const errors = rows.length && !items.length ? ['백로그 표에서 앱·목표 열을 찾지 못했습니다'] : [];
  return { items: items.toSorted((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity)), errors };
}

/** Overview block: the job in flight (running/pr), the next ready item and counts per state. */
export function backlogSummary(items) {
  const counts = Object.fromEntries([...STATES, 'unknown'].map((state) => [state, items.filter((item) => item.state === state).length]));
  return { active: items.filter((item) => item.state === 'running' || item.state === 'pr'),
    next: items.find((item) => item.state === 'ready') ?? null, counts, total: items.length };
}

const key = (name) => String(name ?? '').replace(/\(.*?\)/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const rank = (item) => STATES.includes(item.state) ? STATES.indexOf(item.state) : STATES.length;
/** An app's backlog rows (by project, app or Play name, ignoring case, spaces, `_`/`-` and a `(…)` note), most urgent state first. */
export function backlogFor(app, items) {
  const names = new Set([app.name, app.projectName, ...app.play.map((item) => item.name)].map(key).filter(Boolean));
  return items.filter((item) => names.has(key(item.app))).toSorted((a, b) => rank(a) - rank(b));
}

/** { items, at, error }; never throws. */
export async function readBacklog(dir = NOTES_DIR) {
  try {
    const { text, at } = await readSmall(path.join(dir, 'backlog.md'));
    const { items, errors } = parseBacklog(text);
    return { items, at, error: errors.join(' · ') || null };
  } catch (error) {
    return { items: [], at: 0, error: error.code === 'ENOENT' ? 'backlog.md가 없습니다' : String(error.message) };
  }
}
