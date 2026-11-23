/**
 * The result card: per stage and per run, what changed, which completion criteria are met, the real
 * before/after, the checks actually run, what was not verified, and "improve this result". Artifacts
 * load only when the person asks (artifacts.read), one at a time. The completion label never claims
 * more than the evidence: "published" only from Play's observed status for the approved target.
 */
import { e, button, title, goalTitle, localDate } from './kit.mjs';
import { runTokens } from './tokens.mjs';
import { kindResult } from './kindresult.mjs';

const ARTIFACT_LABELS = { screenshot: '실제 화면', mockup: '시안' };
const MEDIA = /\.(png|jpe?g|webp|gif|mp4|webm)$/i;
const TEXT = /\.(log|txt|md|json)$/i;
const fileName = (file) => String(file).split('/').pop();
const passed = (run, id) => run.nodes.some((node) => node.id === id && node.status === 'passed');
const submissions = (run) => run.nodes.filter((node) => ['internal', 'release'].includes(node.id) && node.status === 'passed' && node.approval?.submission?.developerId)
  .map((node) => node.approval.submission);

/** Play shows this exact version published on the approved account, package and track, freshly observed. */
function observedPublished(target, play) {
  const app = (play?.accounts ?? []).find((account) => account.id === target.accountId)?.apps?.find((item) => item.packageName === target.packageName);
  const track = app?.tracks?.find((item) => item.track === target.track);
  return Boolean(track && track.observedAt && !track.stale && !track.error &&
    track.releases?.some((release) => release.state === 'published' && release.versionCodes?.map(String).includes(String(target.versionCode))));
}

export function completionLabel(run, play) {
  const sent = submissions(run), production = (target) => /(^|:)production$/.test(target.track);
  if (sent.some((target) => production(target) && observedPublished(target, play))) return '프로덕션 게시 확인';
  if (sent.some((target) => !production(target))) return '내부 테스트 제출 확인';
  if (passed(run, 'release')) return '출시 준비 완료';
  if (passed(run, 'test')) return '검증 완료';
  if (run.nodes.some((node) => node.write && node.status === 'passed')) return '구현 결과 생성';
  return null;
}

const list = (items) => '<ul>' + items.map((item) => '<li>' + e(item) + '</li>').join('') + '</ul>';
const section = (heading, body) => body ? '<div class="result-part"><h5>' + heading + '</h5>' + body + '</div>' : '';
const criteria = (items) => '<ul class="criteria">' + items.map((item) => '<li class="' + (item.met ? 'is-met' : 'is-unmet') + '"><span class="criterion-state">' + (item.met ? '충족' : '미충족') + '</span> ' +
  e(item.criterion) + (item.evidence ? '<span class="criterion-evidence"> — ' + e(item.evidence) + '</span>' : '') + '</li>').join('') + '</ul>';
const beforeAfter = (rows) => '<table class="before-after"><thead><tr><th scope="col">항목</th><th scope="col">이전</th><th scope="col">이후</th></tr></thead><tbody>' +
  rows.map((row) => '<tr><th scope="row">' + e(row.label) + '</th><td>' + e(row.before) + '</td><td>' + e(row.after) + '</td></tr>').join('') + '</tbody></table>';
const checks = (evidence) => {
  const run = evidence.filter((item) => item.kind === 'command' && item.role !== 'history');
  return run.length ? '<ul class="checks">' + run.map((item) => '<li><code>' + e(item.command) + '</code> · 종료 코드 ' + e(item.exitCode) + '</li>').join('') + '</ul>' : '';
};

/** Stable element id for an artifact, so focus can land on it after it loads. */
export const artifactId = (file) => 'artifact-' + [...String(file)].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 7).toString(36);

function artifactView(runId, item, artifacts) {
  const name = fileName(item.path), label = Object.hasOwn(ARTIFACT_LABELS, item.label) ? ARTIFACT_LABELS[item.label] : MEDIA.test(name) ? '구분 없음' : '로그';
  const what = label + ': ' + (item.description ?? name), loaded = artifacts.get(item.path);
  const head = '<figcaption><span class="artifact-label is-' + e(item.label ?? 'none') + '">' + e(label) + '</span> <span class="mono">' + e(name) + '</span>' +
    (item.description ? ' · ' + e(item.description) : '') + '</figcaption>';
  const verb = MEDIA.test(name) ? '보기' : '내용 보기';
  const load = button(verb, 'load-artifact', 'data-run="' + e(runId) + '" data-path="' + e(item.path) + '" aria-label="' + e(verb + ': ' + label + ' ' + name) + '"', 'small');
  let body;
  if (!loaded) body = load;
  else if (loaded.loading) body = '<p class="hint">불러오는 중…</p>';
  else if (loaded.error) body = '<p class="callout warning">' + e(loaded.error) + '</p>' + load;
  else if (loaded.kind === 'image') body = '<img src="data:' + e(loaded.mime) + ';base64,' + e(loaded.data) + '" alt="' + e(what) + '">';
  else if (loaded.kind === 'video') body = '<video controls muted src="data:' + e(loaded.mime) + ';base64,' + e(loaded.data) + '" aria-label="' + e(what) + '"></video>';
  else body = '<pre class="artifact-text" tabindex="0" role="region" aria-label="' + e(name) + '">' + e(loaded.text) + '</pre>' + (loaded.truncated ? '<p class="hint">앞부분만 표시했습니다.</p>' : '');
  return '<figure class="artifact" id="' + artifactId(item.path) + '" tabindex="-1">' + head + body + '</figure>';
}

/** One stage's result card; empty for reports written before the result fields existed. */
export function stageResult(run, node, { artifacts }) {
  const report = node.report;
  const shown = (report?.evidence ?? []).filter((item) => item.kind === 'artifact' && (MEDIA.test(item.path) || TEXT.test(item.path)));
  if (!report || !(report.changes || report.criteria || report.beforeAfter || report.notVerified || shown.length)) return '';
  const id = 'result-' + e(run.id + '-' + node.id);
  return '<section class="result-card" aria-labelledby="' + id + '"><h4 id="' + id + '">' + e(title(node)) + ' 결과</h4>' +
    section('바뀐 것', report.changes?.length ? list(report.changes) : '') +
    section('완료 기준', report.criteria?.length ? criteria(report.criteria) : '') +
    section('이전 → 이후', (report.beforeAfter?.length ? beforeAfter(report.beforeAfter) : '') + shown.map((item) => artifactView(run.id, item, artifacts)).join('')) +
    section('실행한 검증', checks(report.evidence ?? [])) +
    section('검증하지 못한 것', report.notVerified ? (report.notVerified.length ? list(report.notVerified) : '<p class="hint">보고서에 적힌 항목이 없습니다.</p>') : '') +
    '<div class="actions">' + button('이 결과 더 개선하기', 'improve-result', 'data-run="' + e(run.id) + '" aria-label="이 결과 더 개선하기: ' + e(title(node)) + '"', 'small') + '</div></section>';
}

/** Why "published" is not shown: Play not read, the target not visible in it, or not published yet. */
function publishNote(run, play, playError) {
  if (!play) return 'Play 상태를 읽지 못해 게시 여부는 표시하지 않았습니다' + (playError ? ' (' + e(playError) + ')' : '') + '.';
  const target = submissions(run).find((item) => /(^|:)production$/.test(item.track));
  const account = (play.accounts ?? []).find((item) => item.id === target.accountId);
  const track = account?.apps?.find((item) => item.packageName === target.packageName)?.tracks?.find((item) => item.track === target.track);
  if (!track) return 'Play에서 ' + e(target.packageName) + '의 ' + e(target.track) + ' 트랙 상태를 읽지 못했습니다' + (account?.error ? ' (' + e(account.error.message ?? account.error) + ')' : '') + '.';
  if (track.error || track.stale) return 'Play 관측값이 오래됐거나 오류가 있어 게시 여부를 확인하지 않았습니다. Play 탭에서 다시 확인하세요.';
  return 'Play에서 승인한 버전(' + e(target.versionCode) + ')의 프로덕션 게시를 아직 확인하지 못했습니다. 단계적 출시 비율은 Play Console에서 확인하세요.';
}

/** Exactly what was observed; Play's "published" is not a 100% rollout. */
function observedLine(run, play) {
  const target = submissions(run).find((item) => /(^|:)production$/.test(item.track) && observedPublished(item, play));
  const track = play.accounts.find((item) => item.id === target.accountId).apps.find((item) => item.packageName === target.packageName).tracks.find((item) => item.track === target.track);
  return '<p class="hint">Play 관측: ' + e(target.track) + ' · versionCode ' + e(target.versionCode) + ' · 게시됨 · 관측 ' + e(localDate(track.observedAt)) +
    '. 게시됨은 모든 사용자 배포를 뜻하지 않습니다. 단계적 출시의 배포 비율은 Neon이 확인하지 않으니 Play Console에서 보세요.</p>';
}

const chainLink = (item) => button(e(goalTitle(item.goal)), 'open-run', 'data-run="' + e(item.id) + '"', 'small link');

/** The run's result: completion label, totals across passed stages, the improvement chain. */
export function runResult(run, { runs, play, playError, tokens = null }) {
  const label = completionLabel(run, play);
  const reports = run.nodes.filter((node) => node.status === 'passed' && node.report).map((node) => node.report);
  const criteriaAll = reports.flatMap((report) => report.criteria ?? []);
  const notVerified = reports.flatMap((report) => report.notVerified ?? []);
  const parent = run.parentRunId && runs.find((item) => item.id === run.parentRunId);
  const children = runs.filter((item) => item.parentRunId === run.id);
  const kind = kindResult(run); // design conditions, measurements, release link, reused evidence
  if (!label && !parent && !children.length && !kind) return '';
  return '<section class="card run-result" aria-labelledby="run-result-' + e(run.id) + '"><div class="section-heading"><h3 id="run-result-' + e(run.id) + '">실행 결과</h3>' +
    (label ? '<span class="completion-label">' + e(label) + '</span>' : '') + '</div>' +
    (label !== '프로덕션 게시 확인' && submissions(run).some((target) => /(^|:)production$/.test(target.track))
      ? '<p class="hint">' + publishNote(run, play, playError) + '</p>' : '') +
    (label === '프로덕션 게시 확인' ? observedLine(run, play) : '') +
    (criteriaAll.length ? '<p>완료 기준 ' + criteriaAll.filter((item) => item.met).length + ' / ' + criteriaAll.length + ' 충족</p>' : '') +
    (notVerified.length ? '<p class="hint">검증하지 못한 것 ' + notVerified.length + '개 · 각 단계 결과에서 확인하세요.</p>' : '') +
    kind +
    // Failed attempts, fixes and reviews included: the stored summary, never a fresh estimate.
    (tokens && (tokens.counts?.sessions || tokens.counts?.unmapped || tokens.scope === 'unavailable') ? runTokens(tokens, { id: run.id, label: '집계된 토큰' }) : '') +
    (parent || children.length ? '<div class="result-chain"><h4>개선 이력</h4>' + (parent ? '<p>이전 결과: ' + chainLink(parent) + '</p>' : '') +
      (children.length ? '<p>이어서 개선: ' + children.map(chainLink).join(' ') + '</p>' : '') + '</div>' : '') +
    (label ? '<div class="actions">' + button('이 결과 더 개선하기', 'improve-result', 'data-run="' + e(run.id) + '"', 'small primary') + '</div>' : '') + '</section>';
}
