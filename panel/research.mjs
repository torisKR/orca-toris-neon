/**
 * The research result block (src/research.mjs findings): the v1 decision first, then who and what
 * problem, the competitors with what was learned and whether their page was opened, the
 * differentiators, the monetization hypothesis, the open questions and the source count. Empty for
 * reports without findings, so older runs keep their card unchanged.
 */
import { e, button } from './kit.mjs';

const part = (heading, body) => '<div class="result-part"><h5>' + heading + '</h5>' + body + '</div>';
const list = (items) => '<ul>' + items.map((item) => '<li>' + e(item) + '</li>').join('') + '</ul>';
const https = (url) => { try { return new URL(url).protocol === 'https:'; } catch { return false; } };

// Opens through the panel's existing external-link action, which accepts only HTTPS.
const appName = (item) => https(item.url)
  ? button(e(item.name) + ' ↗', 'external', 'data-url="' + e(item.url) + '" aria-label="' + e(item.name + ' 페이지 열기') + '"', 'small link')
  : e(item.name);
const checked = (item) => '<span class="research-check ' + (item.checked ? 'is-opened' : 'is-search') + '">' + (item.checked ? '확인함' : '검색 결과만') + '</span>';
const competitors = (items) => '<table class="research-competitors"><thead><tr><th scope="col">경쟁 앱</th><th scope="col">배울 점</th><th scope="col">확인</th></tr></thead><tbody>' +
  items.map((item) => '<tr><th scope="row">' + appName(item) + '</th><td>' + e(item.takeaway) + '</td><td>' + checked(item) + '</td></tr>').join('') + '</tbody></table>';

const strings = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];

/** Reads stored state defensively: older or hand-edited findings render what is well-formed. */
export function researchFindings(report) {
  const findings = report?.findings;
  if (!findings || typeof findings !== 'object' || typeof findings.decision !== 'string' || !findings.decision) return '';
  const rivals = Array.isArray(findings.competitors) ? findings.competitors.filter((item) => item && typeof item === 'object') : [];
  const differentiators = strings(findings.differentiators), openQuestions = strings(findings.openQuestions);
  const money = findings.monetization && typeof findings.monetization === 'object' ? findings.monetization : null;
  return '<div class="research-findings">' +
    '<p class="research-decision"><strong>결론</strong> ' + e(findings.decision) + '</p>' +
    '<p class="research-who"><strong>대상 사용자</strong> ' + e(findings.targetUser) + '</p>' +
    '<p class="research-who"><strong>문제</strong> ' + e(findings.problem) + '</p>' +
    (rivals.length ? part('경쟁 앱', competitors(rivals)) : '') +
    (differentiators.length ? part('차별점', list(differentiators)) : '') +
    (money ? part('수익화 가설', '<p>' + e(money.hypothesis) + '</p><p class="hint">근거: ' + e(money.basis) + '</p>') : '') +
    (openQuestions.length ? part('남은 질문', list(openQuestions)) : '') +
    (findings.sources && typeof findings.sources === 'object' ? '<p class="hint research-sources">출처 ' + e(findings.sources.opened) + '곳 열어 봄 · ' + e(findings.sources.searchOnly) + '곳 검색 결과만</p>' : '') +
    '</div>';
}
