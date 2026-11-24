/**
 * Roadmap item 9: what a finished run looks like when it leaves this Mac for another PC. Built from
 * an explicit list of fields, never by copying the run: stage verdicts, the result card, the checks
 * that ran, the token summary, the release link and Play observations. Every string then goes
 * through redactText: paths become relative to the workspace (or the result folder), the home
 * folder becomes ~, and keys, tokens, passwords and service-account values are removed. Play
 * account ids, names and credentials are never read into the record. Pure.
 */
import path from 'node:path';
import { stageCosts } from './costs.mjs';
import { usageSummary } from './usage.mjs';
import { milestones } from './milestones.mjs';

export const HISTORY_FORMAT = 'toris-neon.history.v1';
const REMOVED = '[제거됨]';
const MAX_TEXT = 4000;
const SECRETS = [
  [/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g, '[비공개 키 제거됨]'], // a key cut off before END too
  [/"(private_key(?:_id)?|client_secret|refresh_token|access_token)"\s*:\s*"[^"]*"/gi, REMOVED],
  [/[\w.+-]+@[\w-]+\.iam\.gserviceaccount\.com/g, '[서비스 계정 제거됨]'],
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z._-]+|xox[abpr]-[0-9A-Za-z-]{10,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{36})\b/g, REMOVED],
  [/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, REMOVED], // JWT
  [/(\b[a-z][\w+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, '$1' + REMOVED + '@'], // user:password@ in a URL
  [/(\b(?:Bearer|Basic)\s+)[^\s"'<>]+/gi, '$1' + REMOVED],
  [/(--(?:ks-pass|key-pass|storepass|keypass)[\s=]+(?:pass:|env:|file:)?)[^\s"']+/gi, '$1' + REMOVED],
  // NAME=value, name: "value", Gradle's storePassword "value"; names like KEYSTORE_PASSWORD or MY_SECRET_TOKEN too.
  [/((?:^|[^A-Za-z0-9])[A-Za-z0-9_]*?(?:pass(?:word|wd)?|secret|token|api[_-]?key)[A-Za-z0-9_]*)(\s*[:=]\s*|\s+(?=["']))("[^"]*"|'[^']*'|[^\s,;"'<>]+)/gi, '$1$2' + REMOVED],
];

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `text` with the run's folders made relative, the home folder as ~, and secrets removed. */
export function redactText(text, { workspacePath, receiptRoot, runId, home }) {
  let out = String(text ?? '');
  const at = (root) => new RegExp('(?<![\\w./~-])' + escapeRegex(root.replace(/\/+$/, '')) + '(?=/|$|[\\s"\'<>),;:])', 'g'); // an absolute start, never inside a relative path
  const swap = (from, to) => { if (from) out = out.replace(at(from), to); };
  if (receiptRoot && runId) swap(path.join(receiptRoot, runId), '결과 폴더');
  if (receiptRoot) swap(receiptRoot, '결과 폴더');
  if (workspacePath) out = out.replace(new RegExp(at(workspacePath).source + '/?', 'g'), '').replace(at(workspacePath), '.');
  if (home) swap(home, '~');
  out = out.replace(/(?<![\w./~-])(?:\/Users|\/home)\/[^/\s"'<>]+/g, '~').replace(/[A-Za-z]:\\Users\\[^\\\s"'<>]+/g, '~');
  for (const [pattern, replacement] of SECRETS) out = out.replace(pattern, replacement);
  return out.slice(0, MAX_TEXT); // cut only after removing secrets, so no half-matched secret survives
}

/** Every string inside `value` redacted; numbers, booleans and null kept. */
function redactDeep(value, context) {
  if (typeof value === 'string') return redactText(value, context);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, context)]));
  return value;
}

/** Where a recorded file is, as the other PC reads it: workspace-relative, 결과 폴더/…, or the file name only. */
export function displayPath(file, { workspacePath, receiptRoot, runId }) {
  if (typeof file !== 'string') return '';
  if (!path.isAbsolute(file)) return '결과 폴더/' + file;
  const inside = (root) => { const relative = root ? path.relative(root, file) : '..'; return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative : null; };
  const inWorkspace = inside(workspacePath);
  if (inWorkspace) return inWorkspace;
  const inRun = inside(receiptRoot && runId ? path.join(receiptRoot, runId) : null);
  return inRun ? '결과 폴더/' + inRun.split(path.sep).slice(-1)[0] : path.basename(file);
}

const verdict = (report) => report ? { outcome: report.outcome ?? null, ...(report.failureClass ? { failureClass: report.failureClass } : {}) } : null;
const list = (value) => Array.isArray(value) ? value : [];
function stageOf(node, context, thumbnails) {
  const report = node.report ?? null, evidence = list(report?.evidence);
  const link = report?.releaseLink;
  const submission = node.approval?.submission;
  return {
    id: node.id, title: node.title ?? node.id, status: node.status, work: verdict(report), review: verdict(node.review),
    summary: report?.summary ?? null, changes: list(report?.changes), notVerified: list(report?.notVerified),
    criteria: list(report?.criteria).map((item) => ({ criterion: item.criterion, met: Boolean(item.met), evidence: item.evidence ?? null })),
    beforeAfter: list(report?.beforeAfter).map((row) => ({ label: row.label, before: row.before, after: row.after })),
    checks: evidence.filter((item) => item.kind === 'command' && item.role !== 'history').map((item) => ({ command: item.command, exitCode: item.exitCode })),
    files: evidence.filter((item) => item.kind === 'artifact').map((item) => ({
      path: displayPath(item.path, context), sha256: item.sha256 ?? null, ...(item.label ? { label: item.label } : {}),
      ...(thumbnails[node.id + ':' + item.path] ? { thumbnail: thumbnails[node.id + ':' + item.path] } : {}),
      ...(thumbnails['changed:' + node.id + ':' + item.path] ? { changed: true } : {}),
      ...(thumbnails['missing:' + node.id + ':' + item.path] ? { thumbnailMissing: thumbnails['missing:' + node.id + ':' + item.path] } : {}),
    })),
    submission: submission ? { packageName: submission.packageName, track: submission.track, versionCode: String(submission.versionCode) } : null,
    // A link's artifact is workspace-relative (src/releaselink.mjs), not a result-folder file.
    releaseLink: link ? { commit: link.commit, artifact: path.isAbsolute(String(link.artifact)) ? displayPath(link.artifact, context) : link.artifact, packageName: link.packageName, track: link.track, versionCode: String(link.versionCode),
      ...(link.binary ? { binary: { format: link.binary.format, sha256: link.binary.sha256, packageName: link.binary.packageName, versionCode: link.binary.versionCode,
        signingCertSha256: link.binary.signingCertSha256 ?? null, checkedAt: link.binary.checkedAt ?? null } } : {}) } : null,
  };
}

/** Play tracks Neon observed for the packages this run submitted or linked; never the account. */
function playObservations(run, play) {
  const packages = new Set([run.improvement?.playLink?.packageName, ...(run.nodes ?? []).flatMap((node) => [node.approval?.submission?.packageName, node.report?.releaseLink?.packageName])].filter(Boolean));
  return (play?.accounts ?? []).flatMap((account) => account.apps ?? []).filter((app) => packages.has(app.packageName)).map((app) => ({
    packageName: app.packageName,
    tracks: (app.tracks ?? []).map((track) => ({ track: track.track, observedAt: track.observedAt ?? null, stale: Boolean(track.stale),
      releases: (track.releases ?? []).map((release) => ({ state: release.state, versionCodes: list(release.versionCodes) })) })),
  }));
}

/**
 * The exported record of `run`. `thumbnails` maps 'nodeId:path' to a thumbnail path inside the run's
 * export folder, and 'changed:nodeId:path' marks a file that changed since intake.
 */
export function historyRecord(run, { exportedAt, receiptRoot, home, play = null, playError = null, thumbnails = {} }) {
  const context = { workspacePath: run.workspacePath, receiptRoot, runId: run.id, home };
  const record = {
    format: HISTORY_FORMAT, snapshot: true, exportedAt,
    run: { id: run.id, goal: run.goal, template: run.template ?? 'new-app', kind: run.improvement?.kind ?? null, status: run.status,
      createdAt: run.createdAt ?? null, updatedAt: run.updatedAt ?? null, archivedAt: run.archivedAt ?? null, parentRunId: run.parentRunId ?? null },
    milestones: milestones(run).map(({ id, label, state, detail }) => ({ id, label, state, detail })),
    stages: (run.nodes ?? []).map((node) => stageOf(node, context, thumbnails)),
    tokens: run.usage ? usageSummary(run.usage) : null,
    costs: stageCosts(run, { now: Date.parse(exportedAt) || Date.now() }), // minutes worked/waiting and tokens per stage (src/costs.mjs)
    play: playObservations(run, play), ...(playError ? { playError } : {}),
  };
  return redactDeep(record, context);
}
