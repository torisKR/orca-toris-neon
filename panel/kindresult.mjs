/**
 * The run card's kind block (plan 4.2, 4.4): for a design improvement the screenshot conditions
 * before and after, flagged when they differ; for a performance improvement the two measurements,
 * with an improvement rate only when both exist under the same conditions; for a release update
 * the link from source commit to artifact, account, package, track and versionCode, flagged where
 * it differs from the person's approval. Also how much of a parent run's evidence was reusable.
 * Every number shown comes from a report; nothing is estimated.
 */
import { e } from './kit.mjs';

const CONDITIONS = [['device', '기기'], ['size', '화면 크기'], ['language', '언어'], ['data', '데이터']];
const passedReport = (run, id) => run.nodes.find((node) => node.id === id && node.status === 'passed')?.report ?? null;
const part = (heading, body) => '<div class="result-part"><h4>' + heading + '</h4>' + body + '</div>';
const warn = (message) => '<p class="callout warning">' + message + '</p>';
const hint = (message) => '<p class="hint">' + message + '</p>';
const table = (caption, head, rows) => '<table class="before-after"><caption class="sr-only">' + e(caption) + '</caption><thead><tr>' + head.map((cell) => '<th scope="col">' + e(cell) + '</th>').join('') + '</tr></thead><tbody>' +
  rows.map(([label, ...cells]) => '<tr><th scope="row">' + e(label) + '</th>' + cells.map((cell) => '<td>' + e(cell) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';

const sameText = (a, b) => String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim(); // as the engine compares
/** The keys whose before and after conditions differ, with both values. */
export function conditionMismatches(before, after) {
  return CONDITIONS.filter(([key]) => !sameText(before?.[key] ?? '', after?.[key] ?? ''))
    .map(([key, label]) => ({ key, label, before: before?.[key] ?? '', after: after?.[key] ?? '' }));
}

function designBlock(run) {
  const before = passedReport(run, 'design')?.comparison?.before ?? passedReport(run, 'test')?.comparison?.before;
  const after = passedReport(run, 'test')?.comparison?.after;
  if (!before && !after) return '';
  const mismatches = before && after ? conditionMismatches(before, after) : [];
  const differs = (key) => mismatches.some((item) => item.key === key) ? ' (변경 전과 다름)' : '';
  const rows = CONDITIONS.map(([key, label]) => [label, before?.[key] ?? '기록 없음', (after?.[key] ?? '기록 없음') + differs(key)]);
  const verdict = !after ? hint('변경 후 촬영 조건이 아직 없습니다. 같은 조건의 전후 비교인지 판단할 수 없습니다.')
    : !before ? warn('변경 전 촬영 조건이 기록되지 않아 같은 조건의 비교인지 확인할 수 없습니다.')
      : mismatches.length ? warn('촬영 조건이 다릅니다: ' + mismatches.map((item) => e(item.label + ' ' + item.before + ' → ' + item.after)).join(', ') + '. 이 전후 스크린샷은 같은 조건의 비교가 아닙니다.')
        : hint('변경 전후를 같은 조건에서 촬영했습니다.');
  return part('비교 조건', table('촬영 조건 비교', ['조건', '변경 전', '변경 후'], rows) + verdict);
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  const found = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return Number(found.toPrecision(12)); // no float noise such as 0.15000000000000002
}
/** Percent improvement from `before` to `after` (positive is better), or null for a zero baseline. */
export function improvementRate(before, after, better) {
  if (!Number.isFinite(before) || !Number.isFinite(after) || before === 0) return null;
  const change = (after - before) / Math.abs(before) * 100;
  return Math.round((better === 'higher' ? change : -change) * 10) / 10;
}
const rateText = (rate) => rate === null ? '계산 안 함(기준값 0)' : rate > 0 ? rate.toFixed(1) + '% 개선' : rate < 0 ? (-rate).toFixed(1) + '% 악화' : '변화 없음';
const value = (metric, samples) => metric ? median(metric.values) + ' ' + metric.unit + ' (중앙값, n=' + samples + ')' : '측정 없음';

function performanceBlock(run) {
  const before = passedReport(run, 'measure')?.measurement, after = passedReport(run, 'test')?.measurement;
  if (!before && !after) return '';
  const same = before && after && sameText(before.scenario, after.scenario) && sameText(before.environment, after.environment) && before.samples === after.samples;
  const names = [...new Set([...(before?.metrics ?? []), ...(after?.metrics ?? [])].map((metric) => metric.name))];
  let hasRate = false;
  const rows = names.map((name) => {
    const was = before?.metrics.find((metric) => metric.name === name), now = after?.metrics.find((metric) => metric.name === name);
    const comparable = same && was && now && was.unit === now.unit && was.better === now.better;
    const rate = comparable ? improvementRate(median(was.values), median(now.values), was.better) : null;
    if (rate !== null) hasRate = true;
    const change = comparable ? rateText(rate) : '계산 안 함';
    return [name, value(was, before?.samples), value(now, after?.samples), change];
  });
  const conditions = (label, item) => item ? hint(label + ': 시나리오 ' + e(item.scenario) + ' · 환경 ' + e(item.environment) + ' · 표본 ' + e(item.samples) + '회') : '';
  const verdict = !after ? hint('수정 후 측정이 없어 개선율을 표시하지 않습니다.')
    : !before ? warn('기준 측정이 없어 개선율을 표시하지 않습니다.')
      : !same ? warn('측정 조건이 달라 개선율을 계산하지 않았습니다. 같은 시나리오·환경·표본 수로 다시 재야 비교할 수 있습니다.')
        : hasRate ? hint('변화율은 비교 가능한 지표의 중앙값으로 계산했습니다.')
          : hint('변화율을 계산할 수 있는 기준값이나 비교할 수 있는 지표가 없습니다.');
  return part('측정 비교', conditions('기준 측정', before) + conditions('재측정', after) + table('성능 측정 비교', ['지표', '개선 전', '개선 후', '변화'], rows) + verdict);
}

const reviewedCommit = (run, node) => (run.jobs ?? []).find((job) => job.nonce === node.review?.nonce)?.sourceCommit ?? null;
function linkFlags(run, node) {
  const link = node.report.releaseLink, approved = node.approval?.submission, flags = [];
  for (const [key, label] of [['packageName', '패키지'], ['track', '트랙'], ['versionCode', 'versionCode']]) {
    if (approved && String(approved[key]) !== String(link[key])) flags.push('승인한 ' + label + ' ' + approved[key] + '와 보고서 ' + link[key] + '가 다릅니다');
  }
  const reviewed = reviewedCommit(run, node);
  if (reviewed && !reviewed.startsWith(link.commit.toLowerCase())) flags.push('검토한 커밋과 다릅니다(검토 ' + reviewed.slice(0, 12) + ')');
  const linked = run.improvement?.playLink?.packageName;
  if (linked && linked !== link.packageName) flags.push('연결한 Play 앱 ' + linked + '와 패키지가 다릅니다');
  return flags;
}
// What src/releaselink.mjs read from the file itself at intake, or that nothing was checked (older reports).
const binaryLine = (binary) => binary ? [binary.format?.toUpperCase(), 'sha256 ' + binary.sha256.slice(0, 12), binary.packageName, 'versionCode ' + binary.versionCode,
  binary.signingCertSha256 ? '서명 인증서 ' + binary.signingCertSha256.slice(0, 12) : '서명 인증서 없음(v1 서명 미확인)'].filter(Boolean).join(' · ') : '확인 기록 없음';
function releaseRows(run, node) {
  const link = node.report.releaseLink, approved = node.approval?.submission;
  const account = approved ? approved.accountId + (approved.developerId ? ' · 개발자 ' + approved.developerId : '') : run.improvement?.playLink?.accountName ?? '승인 전(미정)';
  return table('출시 연결: ' + node.title, ['항목', node.title], [['소스 커밋', link.commit.slice(0, 12)], ['빌드 아티팩트', link.artifact + (link.sha256 ? ' · sha256 ' + link.sha256.slice(0, 12) : '')],
    ['계정', account], ['패키지', link.packageName], ['트랙', link.track], ['versionCode', link.versionCode], ['Neon이 읽은 파일', binaryLine(link.binary)]]);
}
function releaseBlock(run) {
  const last = run.improvement?.lastVerified;
  const scope = hint(last?.commit ? '재검증 기준: 마지막 검증 커밋 ' + e(last.commit.slice(0, 12)) + ' 이후 변경분만 재검증하도록 지시했습니다.' : '재검증 기준: Neon에 이전 검증 기록이 없어 전체를 다시 검증하도록 지시했습니다.');
  const linked = run.nodes.filter((node) => ['internal', 'release'].includes(node.id) && node.report?.releaseLink);
  if (!linked.length && !passedReport(run, 'test')) return '';
  const body = linked.map((node) => { const flags = linkFlags(run, node); return releaseRows(run, node) + (flags.length ? warn(e(flags.join('; ')) + '.') : ''); }).join('');
  return part('출시 연결', scope + body);
}

function reuseBlock(run) {
  const check = [...(run.jobs ?? [])].reverse().find((job) => job.parentEvidence?.items?.length)?.parentEvidence;
  if (!check) return '';
  const items = check.items;
  const fresh = items.filter((item) => item.freshness === 'fresh'), stale = items.filter((item) => item.freshness !== 'fresh');
  return part('이전 결과 근거', '<p>재사용 ' + fresh.length + '개 · 오래됨 ' + stale.length + '개</p>' +
    (stale.length ? hint('오래됨: ' + stale.map((item) => e(item.title)).join(', ') + (check.changedBeforeDelivery ? ' — 작업 지시를 전달하기 직전에 소스가 바뀌어 재사용하지 않았습니다. 다시 검증해야 합니다.' : check.reason ? ' — 현재 소스를 잴 수 없어 같은지 확인하지 못했습니다(' + e(check.reason) + ').' : ' — 소스가 바뀌어 다시 검증해야 합니다.')) : ''));
}

const BLOCKS = { design: designBlock, performance: performanceBlock, release: releaseBlock };
/** The kind block and the parent-evidence line of an improvement run; '' for anything else. */
export function kindResult(run) {
  if (run?.template !== 'improve') return '';
  return (BLOCKS[run.improvement?.kind]?.(run) ?? '') + reuseBlock(run);
}
