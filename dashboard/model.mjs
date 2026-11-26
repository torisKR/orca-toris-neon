/**
 * The dashboard snapshot: Neon runs (projected with src/views.mjs like the panel), Orca projects and
 * workspaces, Play cache, git activity and the toris-docs journal, each cached with its own TTL so a
 * page load never waits on a slow source after the first one.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { projectState } from '../src/views.mjs';
import { dayKey, previousDay, readWorklogs } from '../src/today.mjs';
import { measureTree } from '../src/disk.mjs';
import { readArtifact, ARTIFACT_LIMITS } from '../src/artifacts.mjs';
import { goalTitle, nodeNames } from '../panel/kit.mjs';
import { buildApps, needsAttention, tokensByDay, projectIdOf } from './join.mjs';
import { readReleaseNotes, labelAccounts, watchFor } from './releases.mjs';
import { readBacklog, backlogSummary, backlogFor } from './backlog.mjs';
import { PATHS, HOME, cached, neonState, orcaJson, inspectSource, gitActivity, dirtyCount, mapLimited, receiptsOf } from './sources.mjs';

const TIMELINE_DAYS = 14;
const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const ACTIVE = new Set(['ready', 'running', 'paused', 'blocked']);
const days = (count, from = dayKey()) => Array.from({ length: count }, (_, index) => index).reduce((list) => [...list, previousDay(list.at(-1))], [from]).slice(0, count);

async function loadOrca() {
  const [projects, list, ps] = await Promise.all([orcaJson(['project', 'list']), orcaJson(['worktree', 'list']),
    orcaJson(['worktree', 'ps']).catch(() => ({ worktrees: [] }))]);
  const live = new Map(ps.worktrees.map((tree) => [tree.path, tree]));
  const trees = list.worktrees.filter((tree) => !tree.isArchived).map((tree) => {
    const seen = live.get(tree.path);
    return { projectId: tree.projectId, path: tree.path, name: tree.displayName, main: tree.isMainWorktree,
      branch: String(tree.branch ?? '').replace('refs/heads/', ''), lastActivityAt: seen?.lastActivityAt ?? tree.lastActivityAt ?? null,
      status: seen?.status ?? 'inactive', live: ['active', 'working'].includes(seen?.status), bot: seen?.bot ?? null,
      agents: (seen?.agents ?? []).map((agent) => ({ type: agent.agentType, state: agent.state, title: agent.taskTitle ?? agent.displayName ?? agent.conversationName ?? null, updatedAt: agent.updatedAt ?? null })) };
  });
  const roots = new Map(trees.filter((tree) => tree.main).map((tree) => [tree.projectId, tree.path]));
  const items = await mapLimited(projects.projects, 8, async (project) => {
    const root = roots.get(project.id) ?? null;
    return { id: project.id, name: project.displayName, sourceRepoIds: project.sourceRepoIds ?? [], repoName: project.gitRemoteIdentity?.canonicalKey?.split('/').pop() ?? null,
      root, ...(root ? await inspectSource(root) : { stack: null, packageIds: [] }) };
  });
  return { projects: items, worktrees: trees };
}

async function loadGit(orca) {
  const activity = await mapLimited(orca.projects.filter((project) => project.root), 6, async (project) =>
    [project.id, await gitActivity(project.root).catch(() => null)]);
  const dirty = await mapLimited(orca.worktrees, 6, async (tree) => [tree.path, await dirtyCount(tree.path)]);
  return { activity: new Map(activity), dirty: new Map(dirty) };
}

async function loadDisk() {
  const stat = await fs.statfs(HOME);
  return { free: stat.bavail * stat.bsize, total: stat.blocks * stat.bsize, receipts: await measureTree(PATHS.receipts) };
}

export function createModel() {
  const neon = cached(() => neonState(), 20_000);
  const orca = cached(loadOrca, 60_000);
  const git = cached(async () => loadGit((await orca()).value), 120_000);
  const journal = cached(() => readWorklogs(PATHS.journal, days(TIMELINE_DAYS)), 300_000);
  const disk = cached(loadDisk, 600_000);
  const notes = cached(() => readReleaseNotes(), 60_000);
  const backlog = cached(() => readBacklog(), 60_000);
  const settle = (source) => source().catch((error) => ({ value: null, at: 0, error: String(error.message) }));

  async function snapshot() {
    const [n, o, g, j, d, r, b] = await Promise.all([neon, orca, git, journal, disk, notes, backlog].map(settle));
    const work = { items: b.value?.items ?? [], error: b.error ?? b.value?.error ?? null };
    const state = n.value ?? { runs: [], archivedRuns: [], play: { accounts: [], links: [] } };
    const { projects = [], worktrees = [] } = o.value ?? {};
    const dirty = g.value?.dirty ?? new Map(), activity = g.value?.activity ?? new Map();
    const names = new Map(projects.map((project) => [project.id, project.name]));
    const summary = projectState({ version: 1, revision: 0, runs: state.runs, archivedRuns: state.archivedRuns }, 'summary');
    const owner = new Map([...state.runs, ...state.archivedRuns].map((run) => [run.id, projectIdOf(run, { projects, worktrees })]));
    const projectOf = (run) => names.get(owner.get(run.id)) ?? (path.basename(run.workspacePath ?? '') || null);
    const runs = [...summary.runs, ...summary.archivedRuns.map((run) => ({ ...run, archived: true }))]
      .map((run) => ({ ...run, projectId: owner.get(run.id) ?? run.projectId, goal: goalTitle(run.goal), projectName: projectOf(run) }));
    const trees = worktrees.map((tree) => ({ ...tree, dirty: dirty.get(tree.path) ?? null }));
    const playApps = state.play.accounts.flatMap((account, index) => account.apps.map((app) => ({ ...app, account: 'Play 계정 ' + (index + 1) })));
    const commits = new Map([...activity].map(([id, value]) => [id, value?.last ?? null]));
    const releases = releaseView(r, state.play.accounts);
    const apps = buildApps({ projects, playApps, links: state.play.links, runs, worktrees: trees, commits })
      .map((app) => ({ ...app, watch: watchFor(app, releases), backlog: backlogFor(app, work.items) }))
      .toSorted((a, b) => recentOf(b).localeCompare(recentOf(a)));
    const today = dayKey(), week = days(7);
    const tokens = tokensByDay([...state.runs, ...state.archivedRuns], (ms) => dayKey(ms));
    const playChecked = state.play.accounts.map((account) => account.checkedAt).filter(Boolean).sort()[0] ?? null;
    return {
      generatedAt: new Date().toISOString(), today,
      freshness: [
        { name: 'Neon 실행', at: n.at, source: n.value?.source ?? null, error: n.error ?? n.value?.error ?? null },
        { name: 'Play 캐시', at: playChecked ? Date.parse(playChecked) : 0, source: 'Neon Play 탭 캐시', error: null, note: 'Neon Play 탭에서 새로고침할 때만 갱신됩니다' },
        { name: 'Orca 프로젝트·작업 공간', at: o.at, source: 'orca CLI', error: o.error },
        { name: 'git', at: g.at, source: 'git log/status', error: g.error },
        { name: '작업 일지', at: j.at, source: 'toris-docs', error: j.error },
        { name: '심사 감시 목록', at: r.value?.watchAt ?? 0, source: 'auto-app memory/review-watch.md', error: releases.error, note: '파일을 고친 시각' },
        { name: '자동 개발 백로그', at: b.value?.at ?? 0, source: 'auto-app memory/backlog.md', error: work.error, note: '파일을 고친 시각' },
      ],
      build: state.build ?? null,
      overview: {
        active: runs.filter((run) => !run.archived && ACTIVE.has(run.status)).map(runRow),
        attention: needsAttention({ runs, apps }),
        tokens: { today: tokens.get(today) ?? 0, week: week.reduce((sum, day) => sum + (tokens.get(day) ?? 0), 0) },
        workingAgents: trees.flatMap((tree) => tree.agents.filter((agent) => agent.state === 'working')
          .map((agent) => ({ ...agent, project: names.get(tree.projectId) ?? tree.name, workspace: tree.name }))),
        passedToday: runs.flatMap((run) => (run.nodes ?? []).filter((node) => node.status === 'passed' && node.completedAt && dayKey(Date.parse(node.completedAt)) === today)
          .map((node) => ({ runId: run.id, project: run.projectName, stage: nodeNames[node.id] ?? node.title }))),
        autodev: { ...backlogSummary(work.items), error: work.error },
        releases: { inReview: releases.inReview, done: releases.done.slice(0, 6), outside: releases.outside, error: releases.error, deploysError: releases.deploysError },
        counts: { apps: apps.length, play: playApps.length, projects: projects.length, matched: apps.filter((app) => app.projectId && app.play.length).length },
      },
      apps,
      runs: runs.map(runRow).toSorted((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))),
      ops: {
        limits: summary.limits, resources: summary.resources, disk: d.value, diskError: d.error,
        waiting: runs.filter((run) => !run.archived && Object.keys(run.waiting ?? {}).length).map((run) => ({ runId: run.id, project: run.projectName, goal: run.goal, waiting: run.waiting })),
        workspaces: trees.filter((tree) => !tree.main || tree.live || tree.dirty).map((tree) => ({ ...tree, project: names.get(tree.projectId) ?? null }))
          .toSorted((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)),
      },
      timeline: timeline({ runs: [...state.runs, ...state.archivedRuns], names, activity, journal: j.value ?? [], deploys: releases.deploys, projectOf }),
    };
  }

  async function runDetail(id) {
    const state = (await neon()).value;
    const full = [...state.runs, ...state.archivedRuns].find((run) => run.id === id);
    if (!full) return null;
    const archived = state.archivedRuns.includes(full);
    const summary = projectState({ version: 1, revision: 0, runs: [full], archivedRuns: [] }, 'summary').runs[0];
    const cards = await receiptsOf(id);
    return {
      id, archived, goal: goalTitle(full.goal), status: full.status, updatedAt: full.updatedAt, createdAt: full.createdAt,
      workspace: full.workspacePath ? path.basename(full.workspacePath) : null,
      tokenUsage: summary?.tokenUsage ?? null, operations: summary?.operations ?? [], waiting: summary?.waiting ?? [],
      nodes: full.nodes.map((node) => ({ id: node.id, title: nodeNames[node.id] ?? node.title, deps: node.deps ?? [], status: node.status,
        agent: node.agent ?? null, reviewer: node.reviewer ?? null, attempts: node.attempts ?? 0, reviewAttempts: node.reviewAttempts ?? 0,
        failureReason: node.failureReason ?? null, completedAt: node.completedAt ?? null })),
      events: (full.events ?? []).slice(-60).toReversed().map(({ at, summary: text, nodeId }) => ({ at, text, nodeId: nodeId ?? null })),
      cards: await Promise.all(cards.map((card) => cardView(full, card))),
    };
  }

  /** Evidence image `i` of one attempt's result.json, after the path checks of src/artifacts.mjs. */
  async function file({ run: runId, dir, i }) {
    const state = (await neon()).value;
    const run = [...state.runs, ...state.archivedRuns].find((item) => item.id === runId);
    if (!run || typeof dir !== 'string' || !/^[\w-]+\/[\w.-]+$/.test(dir) || !/^\d{1,3}$/.test(i ?? '')) return null;
    const result = JSON.parse(await fs.readFile(path.join(PATHS.receipts, runId, dir, 'result.json'), 'utf8'));
    const item = result.evidence?.[Number(i)];
    const file = typeof item === 'string' ? item : item?.path;
    if (typeof file !== 'string' || !IMAGE.test(file)) return null;
    const resolved = path.isAbsolute(file) ? file : path.resolve(PATHS.receipts, runId, dir, file);
    return readArtifact({ file: resolved, roots: [path.join(PATHS.receipts, runId), run.workspacePath] });
  }

  return { snapshot, runDetail, file };
}

/** The release notes for the page, account names already replaced by Neon's "Play 계정 N" order. */
function releaseView(notes, accounts) {
  const labels = new Map(accounts.map((account, index) => [account.name, 'Play 계정 ' + (index + 1)]).filter(([name]) => name));
  const value = notes.value ?? {};
  const watch = value.watch ? labelAccounts(value.watch, labels) : { inReview: [], done: [], outside: [], errors: [] };
  const error = notes.error ?? value.watchError ?? (watch.errors.join(' · ') || null);
  return { ...watch, error, deploys: value.deploys ?? [], deploysError: value.deploysError ?? null };
}

const recentOf = (app) => [app.lastCommit?.at, app.lastRun?.updatedAt, ...app.play.map((play) => play.observedAt)].filter(Boolean).sort().at(-1) ?? '';
const runRow = (run) => ({ id: run.id, goal: run.goal, project: run.projectName, status: run.status, archived: Boolean(run.archived),
  passed: run.passedCount ?? 0, total: run.nodeCount ?? 0, updatedAt: run.updatedAt, tokens: run.tokenUsage?.total ?? null,
  stages: (run.nodes ?? []).map((node) => node.status) });

async function evidenceCheck(run, card, item, index) {
  const file = typeof item === 'string' ? item : item?.path;
  if (typeof file !== 'string') return null;
  const resolved = path.isAbsolute(file) ? file : path.resolve(PATHS.receipts, run.id, card.nodeId, card.dir, file);
  const roots = [path.join(PATHS.receipts, run.id), run.workspacePath].filter(Boolean);
  const real = await fs.realpath(resolved).catch(() => null);
  const inside = real && roots.some((root) => { const rel = path.relative(root, real); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); });
  const image = IMAGE.test(file);
  const size = real && inside && image ? (await fs.stat(real)).size : 0;
  const check = !real ? '파일 없음' : !inside ? '실행 폴더·작업 공간 밖' : size > ARTIFACT_LIMITS.mediaBytes ? '1.5MB 초과(미리보기 생략)' : null;
  return { path: path.basename(file), image, ok: !check, reason: check,
    url: !check && image ? '/api/file?run=' + run.id + '&dir=' + encodeURIComponent(card.nodeId + '/' + card.dir) + '&i=' + index : null };
}

async function cardView(run, card) {
  const result = card.result ?? {};
  const evidence = (await Promise.all((Array.isArray(result.evidence) ? result.evidence : []).slice(0, 40).map((item, index) => evidenceCheck(run, card, item, index)))).filter(Boolean);
  return { nodeId: card.nodeId, stage: nodeNames[card.nodeId] ?? card.nodeId, dir: card.dir, at: card.mtime, error: card.error,
    attempt: result.attempt ?? null, phase: result.phase ?? null, outcome: result.outcome ?? null, failureClass: result.failureClass ?? null,
    summary: result.summary ?? null, criteria: Array.isArray(result.criteria) ? result.criteria.slice(0, 30) : [],
    notVerified: result.notVerified ?? null, evidence };
}

function timeline({ runs, names, activity, journal, deploys = [], projectOf }) {
  const span = new Set(days(TIMELINE_DAYS));
  const byDay = new Map([...span].map((day) => [day, []]));
  const add = (day, item) => byDay.get(day)?.push(item);
  for (const run of runs) {
    const groups = new Map();
    for (const event of run.events ?? []) {
      const at = Date.parse(event.at ?? '');
      if (!Number.isFinite(at)) continue;
      const day = dayKey(at);
      if (!span.has(day)) continue;
      const group = groups.get(day) ?? { at: event.at, count: 0, last: '' };
      groups.set(day, { at: event.at > group.at ? event.at : group.at, count: group.count + 1, last: event.at >= group.at ? event.summary : group.last });
    }
    for (const [day, group] of groups) add(day, { kind: 'neon', at: group.at, project: projectOf(run), runId: run.id, title: goalTitle(run.goal), count: group.count, text: group.last });
  }
  for (const [projectId, value] of activity) {
    const groups = new Map();
    for (const commit of value?.recent ?? []) {
      const day = dayKey(Date.parse(commit.at));
      groups.set(day, [...(groups.get(day) ?? []), commit]);
    }
    for (const [day, commits] of groups) add(day, { kind: 'git', at: commits[0].at, project: names.get(projectId), count: commits.length,
      text: commits.slice(0, 3).map((commit) => commit.subject).join(' · '), branches: [...new Set(commits.map((commit) => commit.refs).filter(Boolean))].slice(0, 3) });
  }
  for (const log of journal) {
    const heading = log.text.split('\n').map((line) => line.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
    add(log.day, { kind: 'journal', at: log.day + 'T23:59:00+09:00', project: log.project, text: heading.slice(0, 140), count: log.text.split('\n').filter((line) => /^\s*[-*]\s/.test(line)).length });
  }
  for (const deploy of deploys) {
    add(deploy.date, { kind: 'deploy', at: deploy.date + 'T12:00:00+09:00', project: deploy.app, text: [deploy.version, deploy.track, deploy.result, deploy.commit].filter(Boolean).join(' · ') });
  }
  return [...byDay].map(([day, items]) => ({ day, items: items.toSorted((a, b) => String(b.at).localeCompare(String(a.at))) })).filter((entry) => entry.items.length);
}
