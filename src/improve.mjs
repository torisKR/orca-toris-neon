/**
 * Improving an app that already ships (template 'improve', src/engine.mjs IMPROVE_GRAPH): the update
 * briefs, what an update run's prompts say about the app, and validation of the new-flow input.
 */
import { templateGraph } from './engine.mjs';
import { fileIo } from './ecc.mjs';
import { projectPlatform, WEB_RELEASE_DONE, WEB_NOTE } from './kinds.mjs';

export const KIND_LABELS = Object.freeze({ bugfix: '오류 수정', feature: '기능 추가', design: '디자인·에셋 개선', performance: '성능 최적화', maintenance: '유지보수', release: '출시 업데이트', listing: '스토어 설명·스크린샷 개선', policy: '정책·권한 점검' });
/** What "done" means for each kind; every brief of the run carries it. */
export const KIND_DONE = Object.freeze({
  bugfix: '같은 증상이 수정 전에는 실패하고 수정 후에는 통과함을 근거와 함께 보여야 완료입니다.',
  feature: '새 동작과 영향을 받는 기존 동작이 모두 검증돼야 완료입니다.',
  design: '같은 기기·화면 크기·언어·데이터로 찍은 실제 앱의 변경 전후 스크린샷이 있어야 하고, 시안은 시안으로 표시해야 완료입니다.',
  performance: '측정 시나리오·환경·표본 수를 적고, 같은 조건에서 잰 실제 전후 수치가 있어야 완료입니다. 개선율은 두 측정이 모두 있을 때만 계산합니다.',
  maintenance: '이 변경에 해당하는 검증을 실제로 실행해야 완료입니다.',
  release: '마지막 검증 이후 바뀐 것만 다시 검증하고, 소스·빌드·계정·패키지·트랙·버전이 서로 연결돼야 하며, 실제 제출은 사람이 승인합니다.',
  listing: '스토어 설명과 릴리스 노트는 현재 앱에 실제로 있는 기능만 말하고, 스크린샷은 기기·화면 크기·언어·데이터를 적은 실제 앱 캡처여야 완료입니다. 시안은 시안으로 표시하고, Play Console 반영은 사람이 합니다.',
  policy: '현재 소스의 권한 선언, targetSdk, 데이터 보안 양식, 결제·광고 정책 해당 여부를 공식 근거와 확인 날짜로 점검하면 완료입니다. 소스와 스토어 설정은 바꾸지 말고, 필요한 조치는 목록으로 남기세요.',
});
export const UPDATE_RULE = '이것은 이미 출시된 기존 앱입니다. 동작하는 기능과 사용자 데이터를 보존하고, 개선 기획이 정한 범위만 바꾸세요. 패키지명, 서명 키, 이미 판매한 구매·구독, 저장된 사용자 데이터 형식은 바꾸거나 무효화하지 마세요.';
const PACKAGE = /^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/;

/** What each stage of an update does; replaces the new-app brief for the same stage id. */
export const IMPROVE_BRIEFS = Object.freeze({
  identity: '이 앱이 무엇인지 확인하세요(소스는 바꾸지 마세요): 현재 커밋과 미커밋 변경 여부, 스택(Kotlin/Compose, Flutter, Godot 등), applicationId/패키지명, 실제 빌드 대상과 검증 방법(명령·기기·에뮬레이터), 이번 변경이 건드리는 사용자 흐름, 저장 데이터와 광고·결제를 건드리는지, 기존 출시 도구와 대상. 빌드와 기존 테스트를 실제로 실행해 확인하세요. 보고서에 "identity": {"commit", "dirty", "stack", "packageName", "buildTarget", "verify", "flows": [...], "storedData": true|false, "billing", "ads", "releaseTooling", "releaseTarget"}를 넣으세요. 서명 비밀값은 적지 마세요.',
  diagnose: '정체성 확인 결과를 바탕으로 이 앱의 개선 후보 3~5개를 찾으세요(소스는 바꾸지 마세요). 각 후보는 보고서 "candidates" 배열에 {"title", "kind": bugfix|feature|design|performance|maintenance|release, "problem", "evidence"(실제로 확인한 근거), "impact"(사용자 영향), "scope"(바꿀 범위), "verify"(어떻게 검증할지)}로 적고, 근거가 약한 추측은 넣지 마세요.',
  reproduce: '보고된 증상을 실제로 재현하세요. 재현 절차, 수정 전 실패를 보여 주는 테스트나 로그·스크린샷을 결과 디렉터리에 남기고, 같은 절차를 수정 후에 다시 쓸 수 있게 적으세요. 재현되지 않으면 그 사실과 시도한 조건을 blocked가 아닌 근거와 함께 보고하세요.',
  measure: '개선 전 기준 성능을 측정하세요: 측정 환경(기기·빌드 종류·데이터 양), 측정 방법과 명령, 여러 번 잰 실제 수치. 같은 조건으로 수정 후에 다시 잴 수 있게 절차를 남기세요.',
  plan: '진단 결과로 선택된 개선 영역의 범위를 plan.md에 정하세요: 영역별 변경 목록, 수용 조건, 회귀 위험과 보호 방법, 제외 범위. 결제 추가가 선택됐다면 모델(일회성 잠금 해제, 소모성, 구독, 광고 제거, 보상형 광고)을 근거와 함께 고르고, 상품 제안(productId, type inapp|subs, 가격, 구독이면 basePlanId)을 보고서의 "products" 배열로도 제출하세요. 가격은 제안이며 상품 등록은 사용자가 합니다.',
  design: '현재 앱을 실행해 바뀔 화면의 스크린샷을 결과 디렉터리에 남기고, 그 화면에서 출발해 개선 디자인을 만드세요. 바뀌는 화면만, 기존 정보 구조와 사용자 습관을 지키며 토큰·컴포넌트 단위로 변경점을 명세하세요. 결제가 포함되면 페이월도 같은 디자인 언어로 설계하세요.',
  assets: '개선 디자인에 필요한 에셋만 새로 만들거나 교체하세요. 기존 에셋은 지우지 말고, 교체 목록과 이유, 크기·해상도·투명도 검증을 기록하세요.',
  build: '바꿀 영역의 현재 동작을 고정하는 특성화 테스트(characterization tests)를 먼저 쓰고 통과를 확인한 뒤 기획·재현·측정이 정한 범위만 구현하세요. 변경은 이 실행 브랜치에 커밋하세요. 저장 데이터 형식이 바뀌면 마이그레이션과 그 테스트를 함께 만드세요. 기존 테스트와 새 테스트를 모두 실행해 결과를 남기세요.',
  monetization: 'Google Play Billing Library를 Play가 현재 요구하는 버전으로 연동하세요. 구매 흐름, 구매 확인(acknowledge) 또는 소비, 복원(재설치·기기 변경), 보류(pending) 구매, 권한(entitlement) 저장과 앱 시작 시 재검증, 실패·취소 처리, 개선 디자인과 일관된 페이월 UI를 구현하고 테스트하세요. 기획이 광고를 골랐을 때만 AdMob을 넣고 테스트 광고 단위만 쓰세요. Play 테스트 상품 ID(android.test.purchased 등)와 라이선스 테스터로 검증하고 실제 상품은 만들지 마세요. 최종 상품 목록을 보고서 "products" 배열로 제출하세요.',
  test: '기존 기능 회귀 테스트와 새 기능 테스트를 모두 실행하고 릴리스 APK/AAB를 빌드하세요. versionCode가 현재 배포보다 큰지, 패키지명·서명 설정이 그대로인지, 이전 버전이 저장한 사용자 데이터가 업데이트 후에도 읽히는지 확인하세요. 코드를 고치지 말고 실패는 재현 방법과 함께 failed로 보고하세요.',
  policy: 'Play 결제 정책(디지털 상품은 Play 결제), 결제·광고·새 SDK로 바뀌는 데이터 보안 양식 항목, 현재 targetSdk 요구, 광고가 있으면 광고·가족 정책을 현재 소스 기준으로 점검하세요. 공식 근거와 확인 날짜를 남기세요.',
  listing: '업데이트에 맞춰 스토어 설명, 스크린샷 촬영 목록, 한국어·영어 릴리스 노트를 갱신하세요. 실제로 바뀐 기능만 쓰고, 결제·구독이 있으면 그 사실과 가격 표기 규칙을 지키세요.',
  catalog: '사용자가 Play Console에 등록했다고 확인한 상품 ID가 앱 코드·설정과 정확히 일치하는지 확인하고, 라이선스 테스터로 실제 상품 구매·복원을 시험하는 절차를 기록하세요. Play Console이나 API로 상품을 만들거나 바꾸지 마세요.',
  internal: 'versionCode를 올리고 패키지명과 서명 키를 그대로 둔 업데이트 빌드, 내부 테스트 안내, 릴리스 노트를 준비하세요. 업로드는 사용자가 승인한 대상에만 합니다.',
  release: '업데이트 빌드를 진단 기준선과 대조해 "깨뜨리면 안 되는 것"이 지켜졌는지, 단계적 출시 비율과 되돌리기 계획을 검토하세요.',
});

/** The identity stage's findings, for every later brief: the app must stay what it is. */
export function identityInstruction(run) {
  const identity = run.nodes?.find((node) => node.id === 'identity');
  const report = identity?.status === 'passed' ? identity.report : null;
  if (!report) return '';
  const facts = report.identity ? JSON.stringify(report.identity).slice(0, 2000) : '';
  return ['앱 정체성(정체성 확인 단계 결과): ' + String(report.summary ?? '').slice(0, 1000) + (facts ? '\n' + facts : ''),
    '이 스택·패키지·빌드 대상을 유지하세요. 다른 스택으로 다시 만들지 마세요.',
    report.identity?.storedData === true ? '필수 검증 항목: 기존 사용자 데이터가 새 버전에서 열리는지 확인하세요(이전 버전이 저장한 데이터로 시작).' : ''].filter(Boolean).join('\n');
}

/** What an update run's prompts say about the app: the rule, the kind and its done criteria, Play, identity. */
export function improvementContext(run) {
  if (!['improve', 'diagnose'].includes(run?.template)) return '';
  const info = run.improvement ?? {};
  const play = info.playLink;
  const store = play
    ? 'Play 연결: ' + play.accountName + ' · ' + play.packageName + ' · 상태 ' + (play.status ?? '미확인') +
      (play.tracks?.length ? ' · ' + play.tracks.map((track) => track.track + ' versionCode ' + (track.versionCodes?.join('/') || '없음') + (track.state ? ' (' + track.state + ')' : '')).join(', ') : '') +
      (play.observedAt ? ' · 관측 ' + play.observedAt : '') + '. 평점·리뷰는 플러그인이 수집하지 않으니 필요하면 Play Console에서 확인할 항목으로 남기세요.'
    : 'Play 연결 없음: 패키지명과 배포 버전은 저장소와 빌드 설정에서 확인하세요.';
  const done = info.platform === 'web' && info.kind === 'release' ? WEB_RELEASE_DONE : KIND_DONE[info.kind];
  const kind = info.kind ? '개선 종류: ' + KIND_LABELS[info.kind] + (info.options?.payments ? ' + 결제' : '') + (info.options?.design ? ' + 디자인' : '') + '. ' + done : '진단만 하기: 개선 후보를 찾고 바꾸지는 않습니다.';
  const parent = info.parent ? '이전 결과(' + info.parent.runId + ')에서 이어서 개선합니다. 이전 보고서는 바꾸지 말고 새 결과로 남기세요:\n' + info.parent.summary : '';
  return [UPDATE_RULE, '기존 앱: ' + (info.projectName ?? '프로젝트') + ' · ' + kind, info.platform === 'web' ? WEB_NOTE : store, identityInstruction(run), parent].filter(Boolean).join('\n');
}

/** Monetization: installed billing skills found at launch (src/visual.mjs), else the official docs. */
export function billingSkillInstruction(job) {
  if (job?.phase !== 'work' || job.visual?.stage !== 'monetization') return '';
  const skills = job.visual.skills ?? [];
  return [
    skills.length ? '설치된 결제 관련 스킬:\n' + skills.map((item) => '- ' + item.name + ' — ' + item.why).join('\n')
      : '설치된 결제 관련 스킬이 없습니다.',
    'Billing Library 버전과 API는 https://developer.android.com/google/play/billing 의 현재 요구 사항을 확인해 정하세요. 버전을 추측하지 마세요.',
  ].join('\n');
}

const invalid = (message) => Object.assign(new Error(message), { code: 'invalid_params' });

/**
 * Validates the new-flow input for an update (or a diagnosis, which needs no kind): a known kind and
 * options, an Orca project that is a local Git repository with commits, and an optional Play package
 * that belongs to a configured account. A web project (src/kinds.mjs projectPlatform) gets no Play stages,
 * Play billing or Play link.
 */
export async function prepareImprovement(input, { call, inspectRepository, readPlayApp, detectPlatform = (root) => projectPlatform(root, fileIo) }, { diagnose = false } = {}) {
  const kind = diagnose ? null : input?.kind;
  const options = { design: Boolean(input?.options?.design), payments: Boolean(input?.options?.payments) };
  const graph = (web) => {
    if (diagnose) return;
    try { templateGraph('improve', { kind, ...options, web }); } catch (error) { throw invalid(error.message); }
  };
  graph(false);
  const { projects = [] } = await call('project.list', {});
  const project = projects.find((item) => item.id === input.projectId);
  if (!project) throw invalid('선택한 프로젝트를 찾을 수 없습니다.');
  if ((project.hostId && project.hostId !== 'local') || !project.path) throw invalid('로컬 Git 프로젝트만 개선할 수 있습니다.');
  if (!(await inspectRepository(project.path))?.hasCommit) throw invalid('기존 앱 개선에는 커밋이 있는 저장소가 필요합니다. 프로젝트의 기존 코드를 커밋한 뒤 다시 시도하세요.');
  const platform = await detectPlatform(project.path);
  graph(platform === 'web');
  let playLink = null;
  if (input.playLink !== undefined && input.playLink !== null) {
    if (platform === 'web') throw invalid('웹 프로젝트에는 Play 앱을 연결하지 않습니다.');
    const { accountId, packageName } = input.playLink;
    if (typeof accountId !== 'string' || !accountId || accountId.length > 200) throw invalid('Play 계정을 선택하세요.');
    if (typeof packageName !== 'string' || !PACKAGE.test(packageName)) throw invalid('Play 패키지 이름 형식이 올바르지 않습니다.');
    if (!readPlayApp) throw invalid('Play 계정 정보를 읽을 수 없습니다.');
    try { playLink = await readPlayApp({ accountId, packageName }); }
    catch (error) { throw invalid(String(error?.message ?? error)); }
  }
  // Plan 5.3: a rejected release gets no fix without the reason Play Console gave; checking it (policy, diagnosis) may run.
  const reason = typeof input.rejectionReason === 'string' ? input.rejectionReason.trim() : '';
  if (playLink?.status === 'rejected' && kind && kind !== 'policy' && !reason) {
    throw invalid('연결한 Play 앱의 최근 릴리스가 승인되지 않았습니다. 실제 반려 사유 없이 고치지 않습니다. Play Store 탭에서 Play Console의 반려 사유를 붙여 넣고 시작하세요.');
  }
  return { kind, options, improvement: { kind, options, projectName: project.name ?? null, playLink, platform } };
}
