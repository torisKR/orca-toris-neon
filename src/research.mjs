/**
 * The research stage's contract: the "findings" a passed research work report carries (the v1
 * decision and the answers to six fixed questions), the review's checklist, and the quote the
 * product brief starts from. Refusals are report-form errors (src/reportfix.mjs), so the same agent
 * adds the field instead of the stage running again. Same pattern as src/candidates.mjs.
 */
export const RESEARCH_QUESTIONS = Object.freeze([
  '목표 사용자: 누가 쓰나',
  '문제: 어떤 문제를 푸나',
  '경쟁 앱 3~5개: 각각에서 무엇을 배우나',
  '차별점: 우리 앱은 왜 다른가',
  '수익화: 어떻게 벌고 근거는 무엇인가',
  '남은 질문: 조사로 정하지 못한 것과 누가·무엇이 정하나',
]);
const MIN_COMPETITORS = 3;
const MAX_COMPETITORS = 5;
const MAX_DIFFERENTIATORS = 5;
const MAX_OPEN_QUESTIONS = 5;
const MAX_SOURCES = 999;

const fail = (message) => { throw Object.assign(new Error(message), { code: 'invalid_report' }); };
const text = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim()) fail('findings.' + label + ' 값이 필요합니다(비어 있지 않은 문자열).');
  if (value.trim().length > max) fail('findings.' + label + '가 ' + value.trim().length + '자로 너무 깁니다(최대 ' + max + '자).');
  return value.trim();
};
const texts = (value, label, min, max, chars) => {
  if (value === undefined && min === 0) return [];
  if (!Array.isArray(value) || value.length < min || value.length > max) fail('findings.' + label + '는 ' + min + '~' + max + '개의 문장 배열이어야 합니다.');
  return value.map((item, index) => text(item, label + '[' + index + ']', chars));
};
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('findings.' + label + '는 객체여야 합니다.');
  return value;
};
const count = (value, label) => {
  if (!Number.isInteger(value) || value < 0 || value > MAX_SOURCES) fail('findings.sources.' + label + '는 0~' + MAX_SOURCES + ' 정수여야 합니다.');
  return value;
};
function link(value, label) {
  const url = text(value, label, 500);
  let parsed = null;
  try { parsed = new URL(url); } catch { /* refused below */ }
  if (!parsed || !['https:', 'http:'].includes(parsed.protocol)) fail('findings.' + label + '는 http(s) 주소여야 합니다.');
  return url;
}

const SHAPE = '{"decision", "targetUser", "problem", "competitors": [{"name", "url", "takeaway", "checked"}], "differentiators", "monetization": {"hypothesis", "basis"}, "openQuestions", "sources": {"opened", "searchOnly"}}';
const rival = (letter, takeaway, checked) => '{"name": "샘플 앱 ' + letter + '", "url": "https://example.com/app-' + letter.toLowerCase() + '", "takeaway": "' + takeaway + '", "checked": ' + checked + '}';
// Valid JSON that findingsOf accepts as written (tests/research.test.mjs), so a copied example is never refused.
export const FINDINGS_EXAMPLE = '{"decision": "하루 5분 루틴만 기록하는 오프라인 습관 앱으로 v1을 만든다. 계정·소셜 기능은 뺀다.", "targetUser": "아침 루틴을 만들고 싶은 직장인", ' +
  '"problem": "기존 앱은 설정이 길어 첫 주에 그만둔다", "competitors": [' + rival('A', '첫 화면에서 바로 기록한다', true) + ', ' + rival('B', '연속 기록이 재방문 이유', true) + ', ' + rival('C', '5분 타이머', false) + '], ' +
  '"differentiators": ["설정 없이 첫 기록"], "monetization": {"hypothesis": "광고 없는 평생 이용권(추정)", "basis": "비슷한 앱 2곳이 일회성 결제"}, ' +
  '"openQuestions": ["가격대는 내부 테스트 반응으로 정한다"], "sources": {"opened": 8, "searchOnly": 4}}';

/** The work prompt's contract: exact field names, the limits, what "checked" means, one example. */
export function findingsContract() {
  return '보고서(result.json)에 "findings" 객체로 조사 결론을 적으세요: ' + SHAPE + '. ' +
    '"decision"은 v1을 무엇으로 만들지 1~3문장(제품 기획이 여기서 시작합니다), "targetUser"와 "problem"은 짧은 한 문단씩, ' +
    '"competitors"는 ' + MIN_COMPETITORS + '~' + MAX_COMPETITORS + '개이고 "checked"는 이번 실행에서 그 스토어·공식 페이지를 실제로 열었으면 true, 검색 결과로만 봤으면 false입니다. ' +
    '"differentiators"는 1~' + MAX_DIFFERENTIATORS + '개, "openQuestions"는 0~' + MAX_OPEN_QUESTIONS + '개(무엇이 남았고 누가·무엇이 정하는지), ' +
    '"sources"는 실제로 연 출처 수(opened)와 검색 결과로만 본 출처 수(searchOnly)입니다. 예: ' + FINDINGS_EXAMPLE + '. ' +
    'research.md에만 적으면 패널과 제품 기획이 결론을 읽지 못합니다. 같은 결론을 반드시 이 객체에도 적으세요.';
}

/**
 * A report's findings, normalized to the contract fields with length limits. Every problem is named
 * in one refusal, so the agent fixes them in one report-fix round (src/reportfix.mjs).
 */
export function findingsOf(value) {
  const findings = object(value, '(findings)');
  const problems = [];
  const take = (check, fallback = null) => {
    try { return check(); } catch (error) { if (error.code !== 'invalid_report') throw error; problems.push(error.message); return fallback; }
  };
  const competitors = take(() => {
    const items = findings.competitors;
    if (!Array.isArray(items) || items.length < MIN_COMPETITORS || items.length > MAX_COMPETITORS) {
      fail('findings.competitors는 ' + MIN_COMPETITORS + '~' + MAX_COMPETITORS + '개의 경쟁 앱 배열이어야 합니다. 각 항목: {"name", "url", "takeaway", "checked"}.');
    }
    return items;
  }, []).map((item, index) => {
    const label = 'competitors[' + index + ']';
    if (!take(() => object(item, label))) return null;
    take(() => { if (typeof item.checked !== 'boolean') fail('findings.' + label + '.checked는 true(페이지를 열어 봄) 또는 false(검색 결과만)여야 합니다.'); });
    return { name: take(() => text(item.name, label + '.name', 80)), url: take(() => link(item.url, label + '.url')),
      takeaway: take(() => text(item.takeaway, label + '.takeaway', 300)), checked: item.checked };
  });
  const monetization = take(() => object(findings.monetization, 'monetization'), {});
  const sources = take(() => object(findings.sources, 'sources'), {});
  const out = {
    decision: take(() => text(findings.decision, 'decision', 600)),
    targetUser: take(() => text(findings.targetUser, 'targetUser', 600)),
    problem: take(() => text(findings.problem, 'problem', 600)),
    competitors,
    differentiators: take(() => texts(findings.differentiators, 'differentiators', 1, MAX_DIFFERENTIATORS, 200), []),
    monetization: { hypothesis: take(() => text(monetization.hypothesis, 'monetization.hypothesis', 300)), basis: take(() => text(monetization.basis, 'monetization.basis', 500)) },
    openQuestions: take(() => texts(findings.openQuestions, 'openQuestions', 0, MAX_OPEN_QUESTIONS, 300), []),
    sources: { opened: take(() => count(sources.opened, 'opened')), searchOnly: take(() => count(sources.searchOnly, 'searchOnly')) },
  };
  const valid = competitors.filter(Boolean);
  const urls = valid.map((item) => item.url).filter(Boolean);
  if (new Set(urls).size !== urls.length) problems.push('findings.competitors에 같은 url이 두 번 있습니다. 경쟁 앱마다 그 앱의 페이지 주소를 적으세요.');
  const opened = valid.filter((item) => item.checked === true).length, searchOnly = valid.filter((item) => item.checked === false).length;
  if (Number.isInteger(out.sources.opened) && out.sources.opened < opened) problems.push('findings.sources.opened(' + out.sources.opened + ')가 checked=true인 경쟁 앱 수(' + opened + ')보다 적습니다. 실제로 연 출처 수를 적으세요.');
  if (Number.isInteger(out.sources.searchOnly) && out.sources.searchOnly < searchOnly) problems.push('findings.sources.searchOnly(' + out.sources.searchOnly + ')가 checked=false인 경쟁 앱 수(' + searchOnly + ')보다 적습니다.');
  if (problems.length) fail(problems.length === 1 ? problems[0] : 'findings에서 고칠 곳 ' + problems.length + '개: ' + problems.join(' '));
  return out;
}

/** Refuses a passed research work report with no findings; their shape is checked by findingsOf. */
export function requireFindings(nodeId, report) {
  if (nodeId !== 'research' || report.phase !== 'work' || report.outcome !== 'passed' || report.findings !== undefined) return; // a present one is checked by findingsOf
  fail('조사 보고서에 "findings" 객체가 없습니다. research.md의 결론을 ' + SHAPE + ' 형식으로 result.json의 "findings"에 옮겨 적으세요. 예: ' + FINDINGS_EXAMPLE);
}

const CRITERIA = '"criteria"에는 여섯 질문마다 하나씩 {"criterion": "' + RESEARCH_QUESTIONS[0] + '", "met": true, "evidence": "research.md의 근거 위치"}로 적으세요: ' +
  RESEARCH_QUESTIONS.join(' / ') + '.';
const REVIEW = '조사 검토 기준: findings가 여섯 질문(' + RESEARCH_QUESTIONS.join(' / ') + ')에 답하고 decision이 그 답에서 나오는지 확인하세요. ' +
  'checked=true인 경쟁 앱 링크 2개를 직접 열어(2개보다 적으면 있는 만큼) 실제로 있는 앱인지, takeaway와 맞는지 확인하고 evidence에 {"kind": "note", "text": "열어 본 주소와 확인 결과"}로 남기세요. ' +
  'decision이 없거나 여섯 질문의 답과 맞지 않는 것, 실재하지 않거나 다른 앱을 가리키는 경쟁 앱은 차단 결함입니다: followUps에 {"class": "defect"}로 적고 failed로 보고하세요. ' +
  '그 밖에 근거가 얇은 부분(출처 수, 추정 표시, 남은 질문)은 {"class": "later"}로 적고 passed로 두세요.';

const line = (value) => String(value).replace(/\s+/g, ' ').trim();
const passedFindings = (run) => {
  const research = run.nodes.find((item) => item.id === 'research');
  if (research?.status !== 'passed' || research.report?.outcome !== 'passed' || !research.report.findings) return null;
  // Stored state may be older or hand-edited; a brief must still launch, so a malformed one is not quoted.
  try { return findingsOf(research.report.findings); } catch { return null; }
};

/** The product brief starts from the research decision; quoted from the passed research report. */
function handoff(findings) {
  return '조사 결론(시장·앱 조사 findings, 이 기획은 여기서 시작합니다):\n' +
    '- 결론: ' + line(findings.decision) + '\n' +
    '- 차별점: ' + findings.differentiators.map(line).join(' / ') + '\n' +
    '- 수익화 가설: ' + line(findings.monetization.hypothesis) + ' (근거: ' + line(findings.monetization.basis) + ')\n' +
    '- 남은 질문: ' + (findings.openQuestions.length ? findings.openQuestions.map(line).join(' / ') : '없음') + '\n' +
    'MVP 범위는 이 결론을 따르세요. 다르게 정하면 brief.md에 이유를 적고, 남은 질문은 기획에서 정하거나 제외 범위·확인 사항으로 남기세요.';
}

/** What the research and brief stages add to their prompt; '' for every other stage. */
export function researchInstruction(run, node, job) {
  if (node.id === 'research') return job?.phase === 'review' ? REVIEW : findingsContract() + ' ' + CRITERIA;
  if (node.id !== 'brief') return '';
  const research = run.nodes.find((item) => item.id === 'research');
  if (research?.status !== 'passed') return '';
  const findings = passedFindings(run);
  // Said, not skipped: the brief agent must know it starts without a structured conclusion.
  return findings ? handoff(findings) : '조사 단계의 구조화된 결론(findings)이 없거나 읽을 수 없습니다. 선행 단계 결과의 조사 보고서와 research.md에서 v1 결론을 직접 확인하고, brief.md에 어떤 결론에서 시작했는지 적으세요.';
}
