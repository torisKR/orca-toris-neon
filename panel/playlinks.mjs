/**
 * Plan 5.3 on the Play Store tab, inside each app row: link the app (this account + this package)
 * to a local Orca project the person picks (src/playlinks.mjs), then start from it 다음 버전 준비,
 * 스토어 설명·스크린샷 개선, 정책·권한 점검 or 내부 테스트 결과 확인. Shows the account, package,
 * observed versionCodes, when they were observed and whether that observation is old. A rejected
 * app asks for the actual Play Console reason; the worker refuses a fix without it.
 */
import { e, button, options, localDate } from './kit.mjs';

export const linkKey = (accountId, packageName) => accountId + '|' + packageName;
const domId = (prefix, accountId, packageName) => prefix + '-' + (accountId + '-' + packageName).replace(/[^\w-]/g, '-');
/** Buttons repeat in every app row: the accessible name starts with the visible text and adds the package. */
const named = (label, packageName) => 'aria-label="' + e(label + ' · ' + packageName) + '"';
const ACTIONS = [['release', '다음 버전 준비'], ['listing', '스토어 설명·스크린샷 개선'], ['policy', '정책·권한 점검']];
const INTERNAL_LABELS = { confirmed: '제출 확인', not_seen: '아직 보이지 않음', stale: '오래된 관측', no_build: '기록된 빌드 없음', untracked: 'internal 미관측' };
const ageBadge = (stale) => stale ? '<span class="badge stale">오래된 관측값</span>' : '<span class="badge fresh">최신 관측</span>';
const versions = (track) => [...new Set((track.releases ?? []).flatMap((release) => release.versionCodes ?? []))].join('/') || '없음';

/** The result of 내부 테스트 결과 확인 (src/playactions.mjs internalTestStatus). */
export function internalResult(result) {
  if (!result) return '';
  return '<div class="track play-internal" role="status"><div class="track-header"><strong>내부 테스트 · ' + e(INTERNAL_LABELS[result.state] ?? result.state) + '</strong>' +
    (result.observedAt ? ageBadge(result.stale) : '') + '</div><p>' + e(result.text) + '</p>' +
    (result.observed?.length ? '<p class="hint">internal 관측 versionCode ' + e(result.observed.join('/')) + ' · ' + e(localDate(result.observedAt)) + '</p>' : '') + '</div>';
}

function linkForm(account, app, projects) {
  if (!account.developerId) return '<p class="hint">Play 계정 설정에 19자리 개발자 계정 ID를 입력해야 프로젝트에 연결할 수 있습니다. 계정이 여럿이라 ID 없이 연결하지 않습니다.</p>';
  if (!(account.packages ?? []).includes(app.packageName)) return '<p class="hint">이 패키지를 계정 설정의 패키지 목록에 추가해야 프로젝트에 연결할 수 있습니다.</p>';
  const local = projects.filter((project) => (!project.hostId || project.hostId === 'local') && project.path).map((project) => ({ value: project.id, label: project.displayName ?? project.name ?? project.id }));
  const id = domId('play-link', account.id, app.packageName);
  return '<form class="play-link-form" id="' + e(id) + '" data-form="play-link" data-account="' + e(account.id) + '" data-package="' + e(app.packageName) + '">' +
    '<label class="label" for="' + e(id) + '-project">연결할 Orca 프로젝트</label><select class="field" id="' + e(id) + '-project" name="projectId" required><option value="">프로젝트 선택</option>' + options(local, '') + '</select>' +
    '<p class="hint">' + e(account.name) + ' · ' + e(account.developerId) + '의 ' + e(app.packageName) + '를 고른 프로젝트에 연결합니다. 앱 이름으로 자동 연결하지 않습니다.</p>' +
    '<div class="actions"><button class="button small primary" type="submit">이 프로젝트에 연결</button></div></form>';
}

function linkedBlock(link, app, internal) {
  const key = linkKey(link.accountId, link.packageName), data = 'data-account="' + e(link.accountId) + '" data-package="' + e(link.packageName) + '"';
  const unlink = button('연결 해제', 'play-unlink', data + ' ' + named('연결 해제', link.packageName), 'small danger');
  if (link.problem) return '<div class="callout warning">' + e(link.problem) + '</div><div class="actions">' + unlink + '</div>';
  const tracks = app.tracks ?? []; // a configured track never observed is named and counts as old
  const stale = !tracks.length || tracks.some((track) => track.stale || !track.observedAt);
  const facts = '<dl class="play-link-facts"><dt>계정</dt><dd>' + e(link.accountName) + ' · <span class="mono">' + e(link.developerId) + '</span></dd><dt>패키지</dt><dd class="mono">' + e(link.packageName) + '</dd>' +
    '<dt>관측</dt><dd>' + (tracks.length ? tracks.map((track) => e(track.track) + (track.observedAt ? ' · versionCode ' + e(versions(track)) + ' · ' + e(localDate(track.observedAt)) : ' · 관측 없음')).join('<br>') : '아직 관측한 트랙이 없습니다') + ' ' + ageBadge(stale) + '</dd></dl>';
  const reasonId = domId('play-reason', link.accountId, link.packageName);
  const rejected = app.status === 'rejected' ? '<div class="callout warning" id="' + e(reasonId) + '-help">승인되지 않은 릴리스가 있습니다. 실제 반려 사유 없이 원인을 추정해 고치지 않습니다. Play Console의 반려 사유를 붙여 넣으면 다음 버전 준비와 스토어 자료 개선을 시작할 수 있습니다.</div>' +
    '<label class="label" for="' + e(reasonId) + '">Play Console 반려 사유</label><textarea class="field" id="' + e(reasonId) + '" aria-describedby="' + e(reasonId) + '-help" data-play-reason="' + e(key) + '" maxlength="2000" placeholder="Play Console의 정책 알림이나 거부 이메일 원문을 붙여 넣으세요."></textarea>' : '';
  return '<div class="play-link"><p class="note-label">연결된 프로젝트 · ' + e(link.projectName) + '</p>' + facts + rejected +
    '<p class="hint">계획만 만들고 시작하지 않습니다. 같은 작업을 다시 누르면 진행 중인 실행이 열립니다. Play 조회 키는 작업자에게 전달하지 않습니다.</p>' +
    '<div class="actions">' + ACTIONS.map(([kind, label]) => button(label, 'play-action', 'data-kind="' + kind + '" ' + data + ' ' + named(label, link.packageName), 'small')).join('') +
    button('내부 테스트 결과 확인', 'play-internal', data + ' ' + named('내부 테스트 결과 확인', link.packageName), 'small') + unlink + '</div>' +
    internalResult(internal) + '</div>';
}

/** The link block of one app row: its link and actions, or the form that links it. */
export function playLinkBlock({ account, app, links = [], projects = [], internal = null }) {
  const link = links.find((item) => item.accountId === account.id && item.packageName === app.packageName);
  return '<section class="play-link-block" aria-label="' + e(app.packageName) + ' 프로젝트 연결">' + (link ? linkedBlock(link, app, internal) : linkForm(account, app, projects)) + '</section>';
}
