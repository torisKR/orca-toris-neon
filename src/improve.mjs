/**
 * Improving an app that already ships (template 'improve', src/engine.mjs IMPROVE_GRAPH): the update
 * briefs, what an update run's prompts say about the app, and validation of the new-flow input.
 */
import { IMPROVEMENT_AREAS, templateGraph } from './engine.mjs';

export const AREA_LABELS = Object.freeze({ design: '디자인 개선', features: '기능 추가', payments: '결제 추가' });
export const UPDATE_RULE = '이것은 이미 출시된 기존 앱입니다. 동작하는 기능과 사용자 데이터를 보존하고, 개선 기획이 정한 범위만 바꾸세요. 패키지명, 서명 키, 이미 판매한 구매·구독, 저장된 사용자 데이터 형식은 바꾸거나 무효화하지 마세요.';
const PACKAGE = /^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/;

/** What each stage of an update does; replaces the new-app brief for the same stage id. */
export const IMPROVE_BRIEFS = Object.freeze({
  audit: '코드를 읽고 기존 빌드와 테스트를 실제로 실행해 기준선을 audit.md에 기록하세요: 현재 versionName/versionCode, 패키지명, 서명 설정(키스토어 위치와 키 별칭만, 비밀값은 적지 마세요), 스택과 주요 의존성의 버전·나이와 업데이트 필요 여부, targetSdk/minSdk, 테스트 현황. Play 연결 정보가 있으면 스토어 상태를 반영하세요. 마지막에 "깨뜨리면 안 되는 것" 목록(저장된 사용자 데이터, 이미 판매한 구매·구독, 패키지명, 서명 키, 딥링크·공개 동작)을 쓰세요. 소스는 바꾸지 마세요.',
  plan: '진단 결과로 선택된 개선 영역의 범위를 plan.md에 정하세요: 영역별 변경 목록, 수용 조건, 회귀 위험과 보호 방법, 제외 범위. 결제 추가가 선택됐다면 모델(일회성 잠금 해제, 소모성, 구독, 광고 제거, 보상형 광고)을 근거와 함께 고르고, 상품 제안(productId, type inapp|subs, 가격, 구독이면 basePlanId)을 보고서의 "products" 배열로도 제출하세요. 가격은 제안이며 상품 등록은 사용자가 합니다.',
  design: '현재 앱을 실행해 바뀔 화면의 스크린샷을 결과 디렉터리에 남기고, 그 화면에서 출발해 개선 디자인을 만드세요. 바뀌는 화면만, 기존 정보 구조와 사용자 습관을 지키며 토큰·컴포넌트 단위로 변경점을 명세하세요. 결제가 포함되면 페이월도 같은 디자인 언어로 설계하세요.',
  assets: '개선 디자인에 필요한 에셋만 새로 만들거나 교체하세요. 기존 에셋은 지우지 말고, 교체 목록과 이유, 크기·해상도·투명도 검증을 기록하세요.',
  build: '바꿀 영역의 현재 동작을 고정하는 특성화 테스트(characterization tests)를 먼저 쓰고 통과를 확인한 뒤 기획 범위만 구현하세요. 저장 데이터 형식이 바뀌면 마이그레이션과 그 테스트를 함께 만드세요. 기존 테스트와 새 테스트를 모두 실행해 결과를 남기세요.',
  monetization: 'Google Play Billing Library를 Play가 현재 요구하는 버전으로 연동하세요. 구매 흐름, 구매 확인(acknowledge) 또는 소비, 복원(재설치·기기 변경), 보류(pending) 구매, 권한(entitlement) 저장과 앱 시작 시 재검증, 실패·취소 처리, 개선 디자인과 일관된 페이월 UI를 구현하고 테스트하세요. 기획이 광고를 골랐을 때만 AdMob을 넣고 테스트 광고 단위만 쓰세요. Play 테스트 상품 ID(android.test.purchased 등)와 라이선스 테스터로 검증하고 실제 상품은 만들지 마세요. 최종 상품 목록을 보고서 "products" 배열로 제출하세요.',
  test: '기존 기능 회귀 테스트와 새 기능 테스트를 모두 실행하고 릴리스 APK/AAB를 빌드하세요. versionCode가 현재 배포보다 큰지, 패키지명·서명 설정이 그대로인지, 이전 버전이 저장한 사용자 데이터가 업데이트 후에도 읽히는지 확인하세요. 코드를 고치지 말고 실패는 재현 방법과 함께 failed로 보고하세요.',
  policy: 'Play 결제 정책(디지털 상품은 Play 결제), 결제·광고·새 SDK로 바뀌는 데이터 보안 양식 항목, 현재 targetSdk 요구, 광고가 있으면 광고·가족 정책을 현재 소스 기준으로 점검하세요. 공식 근거와 확인 날짜를 남기세요.',
  listing: '업데이트에 맞춰 스토어 설명, 스크린샷 촬영 목록, 한국어·영어 릴리스 노트를 갱신하세요. 실제로 바뀐 기능만 쓰고, 결제·구독이 있으면 그 사실과 가격 표기 규칙을 지키세요.',
  catalog: '사용자가 Play Console에 등록했다고 확인한 상품 ID가 앱 코드·설정과 정확히 일치하는지 확인하고, 라이선스 테스터로 실제 상품 구매·복원을 시험하는 절차를 기록하세요. Play Console이나 API로 상품을 만들거나 바꾸지 마세요.',
  internal: 'versionCode를 올리고 패키지명과 서명 키를 그대로 둔 업데이트 빌드, 내부 테스트 안내, 릴리스 노트를 준비하세요. 업로드는 사용자가 승인한 대상에만 합니다.',
  release: '업데이트 빌드를 진단 기준선과 대조해 "깨뜨리면 안 되는 것"이 지켜졌는지, 단계적 출시 비율과 되돌리기 계획을 검토하세요.',
});

/** What an update run's prompts say about the app: the rule, the areas, the linked Play app. */
export function improvementContext(run) {
  if (run?.template !== 'improve') return '';
  const info = run.improvement ?? {};
  const areas = (info.areas ?? []).map((area) => AREA_LABELS[area] ?? area).join(', ');
  const play = info.playLink;
  const store = play
    ? 'Play 연결: ' + play.accountName + ' · ' + play.packageName + ' · 상태 ' + (play.status ?? '미확인') +
      (play.tracks?.length ? ' · ' + play.tracks.map((track) => track.track + ' versionCode ' + (track.versionCodes?.join('/') || '없음') + (track.state ? ' (' + track.state + ')' : '')).join(', ') : '') +
      (play.observedAt ? ' · 관측 ' + play.observedAt : '') + '. 평점·리뷰는 플러그인이 수집하지 않으니 필요하면 Play Console에서 확인할 항목으로 남기세요.'
    : 'Play 연결 없음: 패키지명과 배포 버전은 저장소와 빌드 설정에서 확인하세요.';
  return [UPDATE_RULE, '기존 앱 디벨롭: ' + (info.projectName ?? '프로젝트') + ' · 개선 영역: ' + areas, store].join('\n');
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
 * Validates the new-flow input for an update: chosen areas, an Orca project that is a local Git
 * repository with commits, and an optional Play package that belongs to a configured account.
 */
export async function prepareImprovement(input, { call, inspectRepository, readPlayApp }) {
  try { templateGraph('improve', { areas: input?.areas }); }
  catch (error) { throw invalid(error.message); }
  const areas = IMPROVEMENT_AREAS.filter((area) => input.areas.includes(area));
  const { projects = [] } = await call('project.list', {});
  const project = projects.find((item) => item.id === input.projectId);
  if (!project) throw invalid('선택한 프로젝트를 찾을 수 없습니다.');
  if ((project.hostId && project.hostId !== 'local') || !project.path) throw invalid('로컬 Git 프로젝트만 디벨롭할 수 있습니다.');
  if (!(await inspectRepository(project.path))?.hasCommit) throw invalid('기존 앱 디벨롭에는 커밋이 있는 저장소가 필요합니다. 프로젝트의 기존 코드를 커밋한 뒤 다시 시도하세요.');
  let playLink = null;
  if (input.playLink !== undefined && input.playLink !== null) {
    const { accountId, packageName } = input.playLink;
    if (typeof accountId !== 'string' || !accountId || accountId.length > 200) throw invalid('Play 계정을 선택하세요.');
    if (typeof packageName !== 'string' || !PACKAGE.test(packageName)) throw invalid('Play 패키지 이름 형식이 올바르지 않습니다.');
    if (!readPlayApp) throw invalid('Play 계정 정보를 읽을 수 없습니다.');
    try { playLink = await readPlayApp({ accountId, packageName }); }
    catch (error) { throw invalid(String(error?.message ?? error)); }
  }
  return { template: 'improve', areas, improvement: { areas, projectName: project.name ?? null, playLink } };
}
