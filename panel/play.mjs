/**
 * The Play Store app list: search, status filter, one row per app with its production stamps (printed
 * pixel marks, never animated) and the tracks behind a disclosure. ctx carries the links, projects and
 * internal-track checks the row needs; filtering and status classes are unchanged from studio.mjs.
 */
import { e, badge, button, localDate, statusNames, empty } from './kit.mjs';
import { playLinkBlock, linkKey } from './playlinks.mjs';

// Row stamps follow the production track only (src/playstatus.mjs); lookup_error and stale are the check stamps.
export const playStatus = {
  rejected: { label: '거부됨', priority: 0, action: true, tone: 'stop' },
  approved_not_published: { label: '승인 · 게시 전', priority: 2, action: true, tone: 'warn' },
  lookup_error: { label: '조회 오류', priority: 3, tone: 'stop' },
  draft: { label: '초안', priority: 4, tone: 'neutral' },
  stale: { label: '재확인 필요', priority: 5, tone: 'warn' },
  unknown: { label: '미확인', priority: 5, tone: 'neutral' },
  in_review: { label: '심사 중', priority: 6, tone: 'warn' },
  published: { label: '게시됨', priority: 8, tone: 'good' },
  no_production: { label: '프로덕션 없음', priority: 9, tone: 'neutral' },
};
export const playFiltersForSelect = [
  { value: 'all', label: '모든 상태' }, { value: 'action', label: '조치 필요' }, { value: 'lookup', label: '조회 확인' },
  ...['draft', 'in_review', 'published', 'rejected', 'approved_not_published', 'no_production'].map((value) => ({ value, label: playStatus[value].label })),
];
const playNameOrder = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' });
const searchable = (value) => value.normalize('NFKC').toLowerCase();

/** A 16px printed mark with its words; the words carry the meaning, the mark only repeats it. */
export const productionStamp = (status, prefix = '') => '<span class="px-stamp" data-tone="' + e(playStatus[status].tone) + '" data-status="' + e(status) + '">' +
  '<span class="px-mark" data-mark="' + e(status) + '" aria-hidden="true"></span>' + prefix + e(playStatus[status].label) + '</span>';

export function filteredPlayApps(apps, filters) {
  const words = searchable(filters.query).trim().split(/\s+/).filter(Boolean);
  return apps.filter((item) => words.every((word) => searchable((item.name ?? '') + ' ' + item.packageName).includes(word)))
    .map((item) => {
      const tracks = item.tracks ?? [];
      const check = tracks.some((track) => track.error) ? 'lookup_error' : tracks.some((track) => track.stale) ? 'stale' : null;
      const known = (Array.isArray(item.production) ? item.production : []).map((status) => Object.hasOwn(playStatus, status) ? status : 'unknown');
      const production = known.length ? known : ['unknown'];
      // An unknown production state next to a check stamp would say the same thing twice.
      const statuses = production[0] === 'unknown' && check ? [] : production;
      const priority = Math.min(...[...statuses, check].filter(Boolean).map((status) => playStatus[status].priority));
      return { item, statuses, check, priority };
    })
    .filter(({ statuses, check }) => filters.status === 'all' || statuses.includes(filters.status) ||
      (filters.status === 'action' && statuses.some((status) => playStatus[status].action)) || (filters.status === 'lookup' && (check || statuses.includes('unknown'))))
    .sort((a, b) => a.priority - b.priority || playNameOrder.compare(a.item.name || a.item.packageName, b.item.name || b.item.packageName) ||
      playNameOrder.compare(a.item.packageName, b.item.packageName));
}

export const playResultCount = (shown, total) => shown === total ? '전체 ' + total + '개' : total + '개 중 ' + shown + '개';

export function playAppList(matches, account, ctx) {
  const accountId = account.id;
  if (!matches.length) return empty('검색 결과가 없습니다', '검색어 또는 상태 필터를 바꿔 보세요.', button('검색 및 필터 초기화', 'reset-play-filters', '', 'small'));
  const production = (status) => productionStamp(status, '<span class="sr-only">프로덕션: </span>');
  return '<ul class="play-list" aria-label="Play Store 앱">' + matches.map(({ item, statuses, check }) => `<li>
    <details class="play-app" data-disclosure="play-app:${e(accountId)}:${e(item.packageName)}">
      <summary class="play-app-row">
        <span class="px-mark px-2x play-app-icon" data-mark="app" aria-hidden="true"></span>
        <span class="play-app-name">
          <span class="play-title">${e(item.name || item.packageName)}</span>
          <span class="mono play-package">${e(item.packageName)}</span>
        </span>
        <span class="play-app-status" title="프로덕션 트랙 기준">${[...statuses.map(production), ...(check ? [productionStamp(check)] : [])].join(' ')}</span>
        <span class="play-chevron" aria-hidden="true"></span>
      </summary>
      <div class="play-app-tracks">${(item.tracks ?? []).map(playTrack).join('')}
        <div class="actions">${button('스토어 페이지 ↗', 'external', 'data-url="' + e(item.storeUrl) + '"', 'small')}</div>
        ${playLinkBlock({ account, app: item, links: ctx.links, projects: ctx.projects, internal: ctx.internal(linkKey(accountId, item.packageName)) })}
      </div>
    </details></li>`).join('') + '</ul>';
}

function playTrack(track) {
  const releases = track.releases ?? [];
  return `<div class="track">
    <div class="track-header"><strong>${e(track.track)}</strong>${track.stale ? badge('stale') : `<span class="hint">${e(localDate(track.observedAt))}</span>`}</div>
    ${releases.length ? releases.map((release) => `<div class="release-row">
      <span>${e(release.name || '이름 없는 릴리스')}</span><span class="mono">v${e(release.versionCodes.join(', '))}</span>
      <span class="badge">${e(releaseState(release.state))}</span></div>`).join('') : `<p>${track.error ? '조회 결과 없음' : '활성 릴리스 없음'}</p>`}
    ${track.stale ? `<p>마지막 성공한 관측 · ${e(localDate(track.observedAt))}</p>` : ''}
    ${track.error ? `<p class="play-track-error">${e(track.error.message ?? track.error)}</p>` : ''}
  </div>`;
}

function releaseState(value) {
  const names = { RELEASE_LIFECYCLE_STATE_DRAFT: '초안', RELEASE_LIFECYCLE_STATE_NOT_SENT_FOR_REVIEW: '심사 제출 전', RELEASE_LIFECYCLE_STATE_IN_REVIEW: '심사 중', RELEASE_LIFECYCLE_STATE_APPROVED_NOT_PUBLISHED: '승인 · 게시 전', RELEASE_LIFECYCLE_STATE_NOT_APPROVED: '승인되지 않음', RELEASE_LIFECYCLE_STATE_PUBLISHED: '게시됨' };
  return names[value] ?? ({ not_sent_for_review: '심사 제출 전', not_approved: '승인되지 않음' })[value] ?? statusNames[value] ?? value;
}
