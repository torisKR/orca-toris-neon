/**
 * Who an app is for, pinned down once in planning so later stages do not drift to generic output.
 * The product brief's passed work report carries "target" (one specific person, the job, the promise,
 * the decisions, voice, look, what to avoid and checkable signals); an improvement of design, feature
 * or release records the existing app's current target in identity.target. Design, assets, build,
 * listing and test prompts quote it and their reviews judge against it. Refusals are report-form
 * errors (src/reportfix.mjs), so the same agent fixes result.json. Same pattern as src/research.mjs.
 */
import { findingsOf } from './research.mjs';

const MIN_PRIMARY_USER = 30;
const CHARACTER_KINDS = new Set(['design', 'feature', 'release']);

const fail = (message) => { throw Object.assign(new Error(message), { code: 'invalid_report' }); };
const text = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim()) fail(label + ' 값이 필요합니다(비어 있지 않은 문자열).');
  if (value.trim().length > max) fail(label + '가 ' + value.trim().length + '자로 너무 깁니다(최대 ' + max + '자).');
  return value.trim();
};
const MIN_ITEM = 4; // an item that is only "(추정)" or punctuation says nothing a later stage can follow
const texts = (value, label, min, max, chars) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(label + '는 ' + min + '~' + max + '개의 문장 배열이어야 합니다.');
  return value.map((item, index) => {
    const entry = text(item, label + '[' + index + ']', chars);
    if (entry.replace(/\(추정\)|[\s\p{P}]/gu, '').length < MIN_ITEM) fail(label + '[' + index + ']가 내용 없이 짧습니다("' + entry + '"). 이 앱에 맞는 구체적인 문장으로 적으세요.');
    return entry;
  });
};
const object = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label + '는 객체여야 합니다.');
  return value;
};

// Words that fit every app's user (English only as the whole subject), and an age band with at most one more word: neither names a person.
const GENERIC = /누구나|누구든|모든\s*(?:사용자|사람)|전체\s*사용자|일반\s*사용자|일반인|(?<![가-힣])전\s*연령|남녀노소|^\s*(?:for\s+)?(?:everyone|everybody|anyone|all (?:users|people)|general (?:users|public))\b/i;
const AGE = /\d{1,3}\s*(?:대|세)/;
const AGE_WORDS = /\d{1,3}\s*(?:[~\-–]\s*\d{1,3}\s*)?(?:대|세)(?:\s*(?:이상|이하|초반|중반|후반))?|남녀|남성|여성|성인|사용자|사람들?|분들?|및|[,·/\s]/g;
const SPECIFIC = '한 사람을 구체적으로 적으세요: 누구인지, 어떤 상황인지, 언제·어디서 쓰는지, 지금은 무엇으로 대신하는지 한두 문장(' + MIN_PRIMARY_USER + '자 이상).';
function primaryUser(value, label) {
  const who = text(value, label, 400);
  const word = who.match(GENERIC)?.[0];
  if (word) fail(label + '에 "' + word + '"처럼 누구에게나 해당하는 말이 있습니다. ' + SPECIFIC);
  if (AGE.test(who) && who.replace(AGE_WORDS, '').length < 4) fail(label + '가 나이대(와 한 단어)만 적었습니다. ' + SPECIFIC);
  if (who.length < MIN_PRIMARY_USER) fail(label + '가 ' + who.length + '자로 너무 짧습니다. ' + SPECIFIC);
  return who;
}

const SHAPE = '{"primaryUser", "notFor": [1~3], "job", "promise", "decisions": [3~6], "voice": {"tone", "examples": [2~3]}, "look": {"direction", "why"}, "avoid": [3~8], "signals": [2~4]}';
// Valid JSON that targetOf accepts as written (tests/target.test.mjs): a sample app, no real names.
export const TARGET_EXAMPLE = '{"primaryUser": "출근 전 30분 안에 스트레칭과 물 마시기를 지키려는 3년 차 직장인. 지하철역까지 걸으며 한 손으로 체크하고, 지금은 메모 앱 체크리스트를 쓰다 사흘이면 잊는다.", ' +
  '"notFor": ["습관 통계를 분석하고 싶은 사람"], "job": "걸으면서 한 손으로 5초 안에 오늘 루틴을 기록하는 순간", "promise": "아침 루틴, 걸으면서 한 번 눌러 끝낸다.", ' +
  '"decisions": ["첫 화면이 오늘의 체크리스트다: 목표 설정 마법사를 넣지 않는다", "계정 없이 오프라인 저장만", "통계 화면 대신 연속 일수 한 줄"], ' +
  '"voice": {"tone": "짧은 존댓말, 과장된 칭찬 없이", "examples": ["물 한 잔, 했어요.", "오늘 남은 건 스트레칭 하나예요."]}, ' +
  '"look": {"direction": "밝은 미색 바탕, 큰 체크 버튼, 낮은 밀도, 강조색 하나", "why": "걸으면서 엄지로 누르므로 큰 터치 영역과 높은 대비가 필요하다"}, ' +
  '"avoid": ["목표 설정 마법사로 시작하지 않는다", "온보딩 캐러셀을 넣지 않는다", "어느 앱에나 맞는 문구(\\"생산성을 높여 보세요\\")를 쓰지 않는다"], ' +
  '"signals": ["앱을 열고 첫 기록까지 10초 이내", "첫 화면 버튼은 체크 외에 2개 이하"]}';
const BRIEF_DOC = 'brief.md에도 "## 타겟" 섹션으로 같은 내용을 사람이 읽을 수 있게 적으세요.';

/** The brief's contract: exact field names, the limits, what makes primaryUser specific, one example. */
export function targetContract() {
  return '보고서(result.json)에 "target" 객체로 이 앱이 누구를 위한 것인지 적으세요: ' + SHAPE + '. ' +
    '"primaryUser"는 한 사람(누구, 상황, 언제·어디서 쓰는지, 지금 대신 쓰는 것), "notFor"는 일부러 돕지 않는 사람, "job"은 이 앱을 쓰는 한 순간, ' +
    '"promise"는 그 사람이 자기 말로 할 한 문장, "decisions"는 타겟에서 나온 제품 결정(무엇을 넣고 빼는지와 이유), "voice"는 화면 문구의 말투와 이 앱의 실제 문구 예시, ' +
    '"look"은 이 사람에게 맞는 시각 방향(분위기, 정보 밀도, 색·글꼴 의도)과 이유, "avoid"는 이 앱에 넣지 않을 구체적인 흔한 패턴, "signals"는 빌드가 타겟에 맞는지 확인할 수 있는 신호입니다. ' +
    '예: ' + TARGET_EXAMPLE + '. ' + BRIEF_DOC;
}

/**
 * A target, normalized to the contract fields. `inferred` (an existing app's identity.target) needs
 * only primaryUser, promise, voice, look and avoid; values may carry "(추정)". Every problem is named
 * in one refusal, so the agent fixes them in one report-fix round.
 */
export function targetOf(value, { inferred = false } = {}) {
  const prefix = inferred ? 'identity.target' : 'target';
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(prefix + '는 객체여야 합니다: ' + SHAPE + '.');
  const problems = [];
  const take = (check, fallback = undefined) => {
    try { return check(); } catch (error) { if (error.code !== 'invalid_report') throw error; problems.push(error.message); return fallback; }
  };
  const optional = (key, check) => inferred && value[key] === undefined ? undefined : take(check);
  const at = (key) => prefix + '.' + key;
  const voice = take(() => object(value.voice, at('voice')), null);
  const look = take(() => object(value.look, at('look')), null);
  const out = {
    primaryUser: take(() => primaryUser(value.primaryUser, at('primaryUser'))),
    notFor: optional('notFor', () => texts(value.notFor, at('notFor'), 1, 3, 200)),
    job: optional('job', () => text(value.job, at('job'), 300)),
    promise: take(() => text(value.promise, at('promise'), 200)),
    decisions: optional('decisions', () => texts(value.decisions, at('decisions'), 3, 6, 300)),
    voice: voice ? { tone: take(() => text(voice.tone, at('voice.tone'), 200)), examples: take(() => texts(voice.examples, at('voice.examples'), 2, 3, 120)) } : undefined,
    look: look ? { direction: take(() => text(look.direction, at('look.direction'), 500)), why: take(() => text(look.why, at('look.why'), 300)) } : undefined,
    avoid: take(() => texts(value.avoid, at('avoid'), 3, 8, 200)),
    signals: optional('signals', () => texts(value.signals, at('signals'), 2, 4, 200)),
  };
  if (problems.length) fail(problems.length === 1 ? problems[0] : prefix + '에서 고칠 곳 ' + problems.length + '개: ' + problems.join(' '));
  return Object.fromEntries(Object.entries(out).filter(([, item]) => item !== undefined));
}

/** Improvements that must keep the app's own character record its current target at identity. */
const keepsCharacter = (run) => run?.template === 'improve' && CHARACTER_KINDS.has(run.improvement?.kind);
const IDENTITY_FIELDS = '"target": {"primaryUser", "promise", "voice": {"tone", "examples"}, "look": {"direction", "why"}, "avoid"}';
const IDENTITY_CONTRACT = 'identity에 이 앱의 현재 타겟도 적으세요: ' + IDENTITY_FIELDS + '는 필수이고, "notFor", "job", "decisions", "signals"는 알면 적으세요(형식은 새 앱의 기획 타겟과 같습니다). ' +
  'README·스토어 설명·실제 화면에서 읽은 대로 적고, 확인하지 못하고 추론한 값에는 "(추정)"을 붙이세요. 이후 단계는 이 타겟으로 앱의 성격을 지킵니다.';

/** A passed identity of a run that keeps character holds its current target, once its form is valid. */
export function identityTargetOf(run, nodeId, identity, report) {
  const target = report.identity?.target;
  // Only the runs whose later stages quote it keep it: elsewhere it would be shown but never followed.
  if (target === undefined || nodeId !== 'identity' || !keepsCharacter(run) || report.phase !== 'work' || report.outcome !== 'passed') return identity;
  return { ...identity, target: targetOf(target, { inferred: true }) };
}

/** Refuses a passed brief without a target, and a character-keeping identity without one. */
export function requireTarget(run, nodeId, report) {
  if (report.phase !== 'work' || report.outcome !== 'passed') return;
  if (nodeId === 'brief' && report.target === undefined) { // a present one is checked by targetOf
    fail('제품 기획 보고서에 "target" 객체가 없습니다. 이 앱이 누구를 위한 것인지 ' + SHAPE + ' 형식으로 result.json의 "target"에 적고, ' + BRIEF_DOC + ' 예: ' + TARGET_EXAMPLE);
  }
  if (nodeId === 'identity' && keepsCharacter(run) && report.identity?.target === undefined) {
    fail('정체성 보고서에 identity.target이 없습니다. ' + IDENTITY_CONTRACT);
  }
}

const line = (value) => String(value).replace(/\s+/g, ' ').trim();
const LABELS = { primaryUser: '주 사용자', notFor: '대상이 아닌 사람', job: '쓰는 순간', promise: '약속', decisions: '제품 결정', voice: '말투', look: '시각 방향', avoid: '피할 것(avoid)', signals: '맞는지 보는 신호(signals)' };
const show = (key, value) => {
  if (key === 'voice') return line(value.tone) + ' (예시 문구: ' + value.examples.map((item) => '"' + line(item) + '"').join(' / ') + ')';
  if (key === 'look') return line(value.direction) + ' (이유: ' + line(value.why) + ')';
  return Array.isArray(value) ? value.map(line).join(' / ') : line(value);
};
const quote = (target, fields) => fields.filter((key) => target[key] !== undefined).map((key) => '- ' + LABELS[key] + ': ' + show(key, target[key])).join('\n');

// What each stage that shapes what the person sees reads from the target, and what it does with it.
const STAGES = {
  plan: { fields: ['primaryUser', 'promise', 'decisions', 'avoid'], work: '개선 범위가 이 타겟과 맞는지, 피할 것을 깨지 않는지 plan.md에 적으세요.' },
  design: { fields: ['primaryUser', 'job', 'promise', 'voice', 'look', 'avoid'],
    work: '화면 흐름·레이아웃·색·글꼴·문구를 이 사람에게 맞춰 정하고, design.md에 주요 결정이 타겟의 어느 항목에서 나왔는지 적으세요. 피할 것과 어느 앱에나 들어갈 기본 요소(기본 그라데이션, 이모지 제목, 장식용 온보딩 캐러셀)는 쓰지 마세요.' },
  assets: { fields: ['primaryUser', 'look', 'voice', 'avoid'], work: '에셋의 분위기·색·스타일을 시각 방향에 맞추고, 에셋 안 문구는 말투를 따르세요. 피할 것과 어느 앱에나 쓸 일반 스톡 이미지·기본 그라데이션은 쓰지 마세요.' },
  build: { fields: ['primaryUser', 'job', 'decisions', 'voice', 'avoid', 'signals'],
    work: '화면 문구는 말투 예시와 같은 목소리로 쓰고, 제품 결정에 없는 기능(온보딩 캐러셀, 목표 설정 마법사, 지어낸 통계·후기 등)은 만들지 마세요. 신호가 구현에서 지켜지게 하세요.' },
  listing: { fields: ['primaryUser', 'notFor', 'promise', 'voice', 'avoid'],
    work: '스토어 설명과 스크린샷 문구는 이 사람이 자기 말로 할 법한 말(약속·말투)로 쓰세요. 지어낸 수치·사용자 수·후기와 어느 앱에나 맞을 문구("생산성을 높여 보세요")는 쓰지 마세요.' },
  test: { fields: ['primaryUser', 'signals'], work: '신호(signals) 중 직접 잴 수 있는 것은 실제로 재서 criteria에 {"criterion": "타겟 신호: …", "met": true|false, "evidence": "잰 방법과 값"}로 적고, 재지 못한 것은 notVerified에 적으세요.' },
};
const FIT_REVIEW = '타겟 검토: 산출물(화면·에셋·문구)을 위 타겟과 대조하세요. 문구와 시각이 주 사용자·말투·시각 방향에 맞는지 보고, 피할 것(avoid) 목록에 있는 것, 지어낸 수치·사용자 수·후기, ' +
  '어느 앱에나 들어갈 문구나 시각(기본 그라데이션, 이모지 제목, 장식용 온보딩 캐러셀)이 MVP에서 사용자에게 보이면 차단 결함입니다: followUps에 {"text": "무엇이 타겟과 어긋나는지", "class": "defect", "criterion": "타겟 적합성"}로 적고 failed로 보고하세요. ' +
  '사소한 취향 의견은 {"class": "later"}로 적으세요.';
const REVIEWS = {
  design: FIT_REVIEW, assets: FIT_REVIEW, listing: FIT_REVIEW,
  test: '타겟 신호 검토: 위 signals 중 직접 잴 수 있는 것(시간, 탭 수, 화면 요소 수 등)은 실제로 재서 evidence에 남기고, 깨진 신호는 {"class": "defect", "criterion": "타겟 신호"}로 적으세요. 잴 수 없는 신호는 notVerified에 적으세요.',
};
const BRIEF_REVIEW = '타겟 검토: target.primaryUser가 한 사람을 구체적으로 가리키는지(누구, 상황, 언제·어디서, 지금 대신 쓰는 것), 조사 findings의 targetUser·problem·differentiators와 맞는지, ' +
  'decisions가 MVP 기능 목록·제외 범위와 맞는지, avoid가 이 앱에 맞게 구체적인지, brief.md에 "## 타겟" 섹션이 있는지 확인하세요. ' +
  '누구에게나 맞을 일반적인 타겟, 조사와 다른 사람, 빠진 "## 타겟" 섹션은 차단 결함입니다: followUps에 {"class": "defect", "criterion": "타겟 명확성"}로 적고 failed로 보고하세요. 문장 다듬기는 {"class": "later"}입니다.';

/** The research answers the target starts from, quoted when the research report holds them. */
function briefWork(run) {
  const research = run.nodes.find((item) => item.id === 'research');
  let findings = null, unreadable = false;
  // Stored state may be older or hand-edited; the brief must still launch, so a malformed one is not quoted but named.
  try { findings = research?.status === 'passed' && research.report?.findings ? findingsOf(research.report.findings) : null; }
  catch (error) { if (error.code !== 'invalid_report') throw error; unreadable = true; }
  const from = findings
    ? '조사 findings에서: targetUser "' + line(findings.targetUser) + '", problem "' + line(findings.problem) + '", competitors ' +
      findings.competitors.map((item) => line(item.name) + '(' + line(item.takeaway) + ')').join(' / ') + ', differentiators ' + findings.differentiators.map(line).join(' / ') + '.'
    : (unreadable ? '저장된 조사 findings의 형식이 맞지 않아 인용하지 않았습니다. ' : '') + '조사 findings(targetUser, problem, competitors, differentiators)를 선행 단계 결과와 research.md에서 확인하세요.';
  return '타겟: 이 앱이 누구를 위한 것인지 조사 결론에서 정하세요. ' + from + ' targetUser를 한 사람과 그 상황으로 좁히고, problem은 그 사람이 겪는 순간으로, competitors는 그 사람이 지금 쓰는 것과 아쉬운 점으로, differentiators는 decisions로 옮기세요. ' +
    '누구에게나 맞는 일반적인 타겟("모든 사용자", "누구나", 나이대만)은 결함입니다: 이후 디자인·에셋·구현·스토어 문구가 모두 이 타겟을 기준으로 만들고 검토합니다.\n' + targetContract();
}

/** The target a run's later stages follow: the brief's, or for a character-keeping improvement the identity's. */
function storedTarget(run) {
  const inferred = keepsCharacter(run);
  if (!inferred && ['improve', 'diagnose'].includes(run.template)) return null;
  const node = run.nodes.find((item) => item.id === (inferred ? 'identity' : 'brief'));
  if (!node) return null; // a custom graph without a brief has no target to follow
  if (node.status !== 'passed') return { inferred, target: null, why: '그 단계가 아직 통과하지 않음, 상태 ' + node.status };
  const value = inferred ? node.report?.identity?.target : node.report?.target;
  if (!value) return { inferred, target: null, why: '보고서에 없습니다' };
  try { return { inferred, target: targetOf(value, { inferred }) }; }
  catch (error) { if (error.code !== 'invalid_report') throw error; return { inferred, target: null, why: error.message.slice(0, 300) }; }
}

/** What the brief, identity and target-following stages add to their prompt; '' for every other stage. */
export function targetInstruction(run, node, job) {
  const review = job?.phase === 'review';
  if (node.id === 'brief') return review ? BRIEF_REVIEW : briefWork(run);
  if (node.id === 'identity') return keepsCharacter(run) && !review ? IDENTITY_CONTRACT : '';
  const stage = STAGES[node.id];
  const source = stage && storedTarget(run);
  if (!source) return '';
  const name = source.inferred ? '기존 앱의 현재 타겟(identity.target)' : '제품 기획의 타겟';
  // Said, not skipped: the agent must know it has nothing structured to follow.
  if (!source.target) return name + '이 없거나 형식이 맞지 않습니다(' + source.why + '). ' + (source.inferred ? '정체성 확인 결과와 현재 앱 화면' : 'brief.md의 "## 타겟" 섹션') + '을 직접 읽고 따르세요. 찾지 못하면 그 사실을 보고서 notVerified에 적으세요.';
  const header = source.inferred
    ? '현재 타겟(정체성 확인 단계가 기존 앱에서 읽은 것, "(추정)"은 추정): 이 개선은 앱의 성격을 지킵니다. 다른 사람을 위한 앱으로 바꾸지 마세요.'
    : '제품 기획의 타겟(이 앱이 누구를 위한 것인지, 모든 결정의 기준):';
  return header + '\n' + quote(source.target, stage.fields) + '\n' + (review ? REVIEWS[node.id] ?? '' : stage.work);
}
