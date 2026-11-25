/**
 * Pure joins for the dashboard: the app list is the union of Orca projects and Play apps, matched
 * by Neon's Play link first, then the package id found in the project's source, then the name.
 * A Play app or project nothing matched still gets its own row. No I/O here (tests/dashboard.test.mjs).
 */
import { productionStatus } from '../src/playstatus.mjs';
import { summarizeApp } from '../src/play.mjs';

export const normName = (value) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const GENERIC = new Set(['com', 'kr', 'org', 'net', 'io', 'app', 'android', 'toris', 'toriskr', 'godot', 'mobile']);

/** The name parts of a package that can match a project name: com.toris.waxBalls → ['waxballs']. */
export function packageWords(packageName) {
  const parts = String(packageName ?? '').split('.').map(normName).filter((part) => part && !GENERIC.has(part));
  return [...new Set(parts)];
}

/** Which project a Play app belongs to, and why: link | package | name; null unless exactly one project fits. */
export function matchProject(app, projects, links = []) {
  const link = links.find((item) => item.packageName === app.packageName && !item.problem);
  const linked = link && projects.find((project) => project.id === link.projectId);
  if (linked) return { project: linked, by: 'link' };
  const byPackage = projects.filter((project) => (project.packageIds ?? []).includes(app.packageName));
  if (byPackage.length === 1) return { project: byPackage[0], by: 'package' };
  const words = packageWords(app.packageName);
  const byName = projects.filter((project) => words.includes(normName(project.name)) || words.includes(normName(project.repoName)));
  return byName.length === 1 ? { project: byName[0], by: 'name' } : null;
}

/**
 * The Orca project of a Neon run. Neon stores the repo id (Orca's sourceRepoIds), not the project id,
 * so this tries the id, the repo ids, the run's workspace path, then the folder name under workspaces/.
 */
export function projectIdOf(run, { projects = [], worktrees = [] }) {
  const id = run.projectId;
  const direct = projects.find((project) => project.id === id || project.id === 'repo:' + id || (project.sourceRepoIds ?? []).includes(id));
  if (direct) return direct.id;
  const tree = worktrees.find((item) => item.path && item.path === run.workspacePath);
  if (tree) return tree.projectId;
  const folder = /\/workspaces\/([^/]+)\/[^/]+\/?$/.exec(run.workspacePath ?? '')?.[1] ?? /\/projects\/([^/]+)\/?$/.exec(run.workspacePath ?? '')?.[1];
  const byFolder = folder && projects.find((project) => project.root && project.root.split('/').pop() === folder);
  return byFolder?.id ?? null;
}

const newest = (items, key) => items.filter((item) => item?.[key]).toSorted((a, b) => String(b[key]).localeCompare(String(a[key])))[0] ?? null;

/**
 * One row per app. `projects`: [{id, name, repoName?, stack?, packageIds?}]; `playApps`: [{packageName,
 * name, tracks, account}] from the Play cache; `runs`: summary runs (archived ones flagged);
 * `worktrees`: [{projectId, live, dirty, agents}]; `commits`: Map projectId → newest commit.
 */
export function buildApps({ projects = [], playApps = [], links = [], runs = [], worktrees = [], commits = new Map(), now = Date.now() }) {
  const rows = new Map(projects.map((project) => [project.id, { key: 'p:' + project.id, project, play: [], match: null }]));
  const loose = [];
  for (const app of playApps) {
    const found = matchProject(app, projects, links);
    if (!found) { loose.push({ key: 'play:' + app.packageName, project: null, play: [app], match: null }); continue; }
    const row = rows.get(found.project.id);
    rows.set(found.project.id, { ...row, play: [...row.play, app], match: row.match ?? found.by });
  }
  return [...rows.values(), ...loose].map((row) => appRow(row, { runs, worktrees, commits, now }));
}

const STALE_PLAY_MS = 3 * 86_400_000;
function playView(app, now) {
  const tracks = app.tracks ?? [];
  const summary = summarizeApp(tracks);
  return { packageName: app.packageName, name: app.name ?? app.packageName, account: app.account ?? null,
    status: summary.status, production: productionStatus(tracks), needsAttention: summary.needsAttention,
    // Neon marks every cached track stale after an hour; here only an error or a 3-day-old read counts.
    stale: tracks.some((track) => track.error || !track.observedAt || now - Date.parse(track.observedAt) > STALE_PLAY_MS),
    observedAt: tracks.map((track) => track.observedAt).filter(Boolean).sort().at(-1) ?? null };
}

function appRow({ key, project, play, match }, { runs, worktrees, commits, now }) {
  const own = project ? runs.filter((run) => run.projectId === project.id) : [];
  const lastRun = newest(own, 'updatedAt');
  const spaces = project ? worktrees.filter((tree) => tree.projectId === project.id) : [];
  const plays = play.map((app) => playView(app, now));
  return {
    key, match,
    name: plays[0]?.name ?? project?.name ?? '이름 없음',
    projectId: project?.id ?? null, projectName: project?.name ?? null, stack: project?.stack ?? null,
    play: plays,
    lastRun: lastRun && { id: lastRun.id, goal: lastRun.goal, status: lastRun.status, archived: Boolean(lastRun.archived),
      passed: lastRun.passedCount ?? 0, total: lastRun.nodeCount ?? 0, updatedAt: lastRun.updatedAt },
    runCount: own.length,
    lastCommit: project ? commits.get(project.id) ?? null : null,
    workspaces: spaces.length,
    activeWorkspaces: spaces.filter((tree) => tree.live).length,
    workingAgents: spaces.reduce((sum, tree) => sum + (tree.agents ?? []).filter((agent) => agent.state === 'working').length, 0),
    dirty: spaces.filter((tree) => tree.dirty > 0).length,
  };
}

/** What needs the owner, most urgent first: blocked runs, approvals, unclear agents, Play rejections and reviews. */
export function needsAttention({ runs = [], apps = [] }) {
  const items = [];
  for (const run of runs) {
    if (run.archived) continue;
    if (run.status === 'blocked') items.push({ level: 'red', kind: 'run', runId: run.id, text: (run.projectName ? run.projectName + ' · ' : '') + '실행이 막혔습니다', detail: run.goal });
    for (const node of run.nodes ?? []) {
      if (node.status === 'awaiting-approval') items.push({ level: 'amber', kind: 'run', runId: run.id, text: '승인 대기: ' + (node.title ?? node.id), detail: run.goal });
    }
    for (const job of run.operations ?? []) {
      if (['unclear', 'error', 'needs-user'].includes(job.condition)) items.push({ level: job.condition === 'needs-user' ? 'amber' : 'red', kind: 'run', runId: run.id, text: '에이전트 확인 필요(' + job.condition + '): ' + job.nodeId, detail: run.goal });
    }
  }
  for (const app of apps) {
    for (const play of app.play) {
      if (play.status === 'rejected') items.push({ level: 'red', kind: 'play', text: 'Play 거부됨: ' + play.name, detail: play.packageName });
      else if (play.production.includes('in_review')) items.push({ level: 'amber', kind: 'play', text: 'Play 심사 중: ' + play.name, detail: play.packageName });
    }
  }
  const rank = { red: 0, amber: 1 };
  return items.toSorted((a, b) => rank[a.level] - rank[b.level]);
}

/** Map day → tokens of counted sessions, by the day their first assignment started (`dayOf(ms)`). */
export function tokensByDay(runs, dayOf) {
  const out = new Map();
  for (const run of runs) {
    for (const entry of run.usage?.sessions ?? []) {
      const counted = Number.isSafeInteger(entry.latest) && Number.isSafeInteger(entry.baseline) && entry.latest > entry.baseline;
      if (!counted) continue;
      const started = Math.min(...(entry.owners ?? []).map((owner) => Date.parse(owner.startedAt ?? '')).filter(Number.isFinite));
      if (!Number.isFinite(started)) continue;
      const day = dayOf(started);
      out.set(day, (out.get(day) ?? 0) + entry.latest - entry.baseline);
    }
  }
  return out;
}

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const DEVELOPER_ID = /\b\d{19}\b/g; // Play developer account ids are 19 digits
const HIDDEN_KEYS = new Set(['developerId', 'accountName', 'client_email', 'email', 'userEmail']);

/** `value` safe for the phone: home paths as ~, no emails or Play developer ids; numbers and booleans kept. */
export function scrub(value, { home }) {
  if (typeof value === 'string') {
    return (home ? value.split(home).join('~') : value).replace(/\/Users\/[^/\s"'<>]+/g, '~')
      .replace(EMAIL, '(이메일 숨김)').replace(DEVELOPER_ID, '(ID 숨김)');
  }
  if (Array.isArray(value)) return value.map((item) => scrub(item, { home }));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !HIDDEN_KEYS.has(key)).map(([key, item]) => [key, scrub(item, { home })]));
  }
  return value;
}
