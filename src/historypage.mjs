/**
 * The static page of an exported run (roadmap item 9): opened on another PC or a phone straight from
 * the export folder. Plain HTML and inline CSS, no script, every value escaped. It says it is a
 * snapshot and when it was taken, because nothing after the export is in it.
 */
import { e, localDate } from '../panel/kit.mjs';
import { compactTokens } from '../panel/tokens.mjs';

const OUTCOMES = { passed: '통과', failed: '실패', blocked: '중단' };
const STATUS = { completed: '완료', cancelled: '취소', passed: '통과', failed: '실패', blocked: '확인 필요', pending: '대기', review: '검토', 'awaiting-approval': '승인 대기', running: '진행 중' };
const MILESTONE = { done: '완료', partial: '진행 중', not_done: '안 됨', approved: '승인' };
const STYLE = `:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--line:#d6d3d1;--ok:#166534;--bad:#b91c1c;--card:#fff}
@media (prefers-color-scheme: dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--ok:#86efac;--bad:#fca5a5;--card:#292524}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Apple SD Gothic Neo",sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}h1{font-size:1.35rem;margin:.2em 0}h2{font-size:1.1rem;margin-top:1.6em}h3{font-size:1rem;margin:.2em 0}
.snapshot{border:1px solid var(--line);background:var(--card);padding:10px 12px;border-radius:8px}.muted{color:var(--muted)}
section.stage{border-top:1px solid var(--line);padding:10px 0}table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid var(--line);padding:4px 6px;vertical-align:top}
.scroll{overflow-x:auto}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
code{font-family:ui-monospace,Menlo,monospace;font-size:.9em;overflow-wrap:anywhere}.ok{color:var(--ok)}.bad{color:var(--bad)}img{max-width:100%;height:auto;border:1px solid var(--line);border-radius:6px}
ul{padding-left:1.2em}`;

const time = (iso) => iso ? '<time datetime="' + e(iso) + '">' + e(localDate(iso)) + '</time>' : '—';
const items = (values) => values.length ? '<ul>' + values.map((value) => '<li>' + e(value) + '</li>').join('') + '</ul>' : '';
const verdict = (value) => value ? '<span class="' + (value.outcome === 'passed' ? 'ok' : 'bad') + '">' + e(OUTCOMES[value.outcome] ?? value.outcome) + '</span>' : '<span class="muted">없음</span>';
const short = (hash) => hash ? '<code>' + e(hash.slice(0, 16)) + '</code>' : '<span class="muted">기록 없음</span>';

function file(item, title) {
  const name = e(item.path);
  return '<li><code>' + name + '</code> · sha256 ' + short(item.sha256) + (item.changed ? ' · <strong class="bad">변경됨: 접수 이후 파일이 바뀌어 내보내지 않았습니다</strong>' : '') +
    (item.thumbnail ? '<br><img src="' + e(item.thumbnail) + '" alt="' + e(title + ' · ' + (item.label === 'mockup' ? '시안: ' : '실제 화면: ') + item.path) + '" loading="lazy">' : '') +
    (item.thumbnailMissing ? ' · <span class="muted">축소본 없음: ' + e(item.thumbnailMissing) + '</span>' : '') + '</li>';
}
function release(stage) {
  const link = stage.releaseLink, target = stage.submission;
  if (!link && !target) return '';
  const binary = link?.binary;
  return '<h4>출시 연결</h4><ul>' + (target ? '<li>승인한 대상: ' + e(target.packageName) + ' · ' + e(target.track) + ' · versionCode ' + e(target.versionCode) + '</li>' : '') +
    (link ? '<li>보고한 빌드: <code>' + e(link.artifact) + '</code> · 커밋 <code>' + e(String(link.commit).slice(0, 12)) + '</code> · versionCode ' + e(link.versionCode) + '</li>' : '') +
    (binary ? '<li>Neon이 읽은 파일: ' + e(String(binary.format).toUpperCase()) + ' · sha256 ' + short(binary.sha256) + ' · ' + e(binary.packageName) + ' · versionCode ' + e(binary.versionCode) +
      ' · 서명 인증서 ' + short(binary.signingCertSha256) + '</li>' : link ? '<li class="muted">Neon이 파일을 직접 확인한 기록 없음</li>' : '') + '</ul>';
}
function stage(item) {
  const criteria = item.criteria.map((row) => (row.met ? '충족: ' : '미충족: ') + row.criterion + (row.evidence ? ' — ' + row.evidence : ''));
  return '<section class="stage"><h3>' + e(item.title) + ' <span class="muted">· ' + e(STATUS[item.status] ?? item.status) + '</span></h3>' +
    '<p>작업 ' + verdict(item.work) + ' · 검토 ' + verdict(item.review) + '</p>' + (item.summary ? '<p>' + e(item.summary) + '</p>' : '') +
    (item.changes.length ? '<h4>바뀐 것</h4>' + items(item.changes) : '') + (criteria.length ? '<h4>완료 기준</h4>' + items(criteria) : '') +
    (item.beforeAfter.length ? '<h4>이전 → 이후</h4><div class="scroll"><table><caption class="sr-only">' + e(item.title) + ' 이전과 이후</caption><thead><tr><th scope="col">항목</th><th scope="col">이전</th><th scope="col">이후</th></tr></thead><tbody>' +
      item.beforeAfter.map((row) => '<tr><th scope="row">' + e(row.label) + '</th><td>' + e(row.before) + '</td><td>' + e(row.after) + '</td></tr>').join('') + '</tbody></table></div>' : '') +
    (item.checks.length ? '<h4>실행한 검증</h4><ul>' + item.checks.map((check) => '<li><code>' + e(check.command) + '</code> · 종료 코드 ' + e(check.exitCode) + '</li>').join('') + '</ul>' : '') +
    (item.notVerified.length ? '<h4>검증하지 못한 것</h4>' + items(item.notVerified) : '') +
    (item.files.length ? '<h4>파일</h4><ul>' + item.files.map((entry) => file(entry, item.title)).join('') + '</ul>' : '') + release(item) + '</section>';
}
function tokens(summary) {
  if (!summary) return '<p class="muted">토큰 기록 없음</p>';
  const total = summary.total === null || summary.total === undefined ? '집계 없음' : compactTokens(summary.total) + ' (' + Math.round(summary.total).toLocaleString('ko-KR') + ' 토큰)';
  return '<p>토큰 ' + e(total) + ' · 범위 ' + e(summary.scope) + '</p>';
}
function play(observations) {
  if (!observations.length) return '<p class="muted">이 실행과 연결된 Play 관측값 없음</p>';
  return observations.map((app) => '<h3>' + e(app.packageName) + '</h3><ul>' + app.tracks.map((track) => '<li>' + e(track.track) + ' · 관측 ' + time(track.observedAt) + (track.stale ? ' (오래된 관측값)' : '') +
    (track.releases.length ? ' · ' + track.releases.map((item) => e(item.state) + ' ' + e(item.versionCodes.join('/'))).join(', ') : ' · 릴리스 없음') + '</li>').join('') + '</ul>').join('') +
    '<p class="muted">Play의 게시됨은 100% 배포를 뜻하지 않습니다. 단계적 출시 비율은 Play Console에서 확인하세요.</p>';
}

/** The page for one exported record (src/history.mjs). */
export function historyPage(record) {
  const run = record.run;
  return '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Neon 실행 기록</title><style>' + STYLE + '</style></head><body><main>' +
    '<p class="snapshot"><strong>내보낸 시점의 스냅샷</strong>입니다. 내보낸 시각 ' + time(record.exportedAt) + ' 이후의 진행은 들어 있지 않습니다. 읽기 전용이며, 이 페이지에서 실행을 바꿀 수 없습니다.</p>' +
    '<h1>' + e(run.goal) + '</h1><p class="muted">실행 ' + e(run.id) + ' · ' + e(STATUS[run.status] ?? run.status) + ' · 만든 시각 ' + time(run.createdAt) + ' · 마지막 변경 ' + time(run.updatedAt) + '</p>' +
    (record.milestones.length ? '<p>' + record.milestones.map((item) => e(item.label) + ' ' + e(MILESTONE[item.state] ?? item.state) + (item.detail ? ' (' + e(item.detail) + ')' : '')).join(' · ') + '</p>' : '') +
    '<h2>단계</h2>' + record.stages.map(stage).join('') + '<h2>토큰</h2>' + tokens(record.tokens) + '<h2>Play 관측</h2>' + (record.playError ? '<p class="bad">' + e(record.playError) + ' 아래 값은 비어 있을 수 있습니다.</p>' : '') + play(record.play) +
    '<p class="muted">파일 경로는 작업 공간 기준이며, 결과 폴더의 파일은 "결과 폴더/"로 표시합니다. 비밀값·키·토큰·서비스 계정과 Play 계정 정보는 내보내지 않습니다.</p></main></body></html>\n';
}
