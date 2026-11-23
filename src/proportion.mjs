/**
 * Keeps each stage proportionate to a small app: a time and scope budget per stage, a definition of
 * "enough", and reviews of document stages that fail only on blocking defects, passing the rest on
 * to the next stage as follow-ups. Build, assets, test and submission reviews stay strict.
 */

/** Minutes per phase, the expected size of the output, and when to stop. */
export const STAGE_BUDGETS = Object.freeze({
  audit: { work: 20, review: 8, scope: 'audit.md 2~4쪽: 기준선과 깨뜨리면 안 되는 것 목록',
    enough: '빌드·테스트를 실제로 돌려 현재 상태를 확인하고, 버전·패키지·서명·의존성·스택과 보존 목록이 있으면 충분합니다. 리팩터링 제안 목록은 필요 없습니다.' },
  plan: { work: 15, review: 8, scope: 'plan.md 2~4쪽',
    enough: '선택된 영역의 변경 목록, 수용 조건, 회귀 보호, 제외 범위, 결제가 있으면 모델과 상품 제안이 있으면 충분합니다.' },
  monetization: { work: 90, review: 20, scope: 'Play 결제 연동, 페이월, 테스트 상품 검증',
    enough: '구매·확인·복원·보류 구매·권한 저장이 테스트 상품으로 검증되고 페이월이 동작하면 충분합니다. 실제 상품 등록은 사용자가 합니다.' },
  catalog: { work: 10, review: 5, scope: '상품 ID 대조와 라이선스 테스터 시험 절차',
    enough: '앱 코드의 상품 ID가 사용자가 등록한 목록과 일치함을 확인하고 시험 절차를 기록하면 충분합니다.' },
  research: { work: 15, review: 8, scope: 'research.md 2~4쪽, 경쟁 앱 3~5개, 출처 링크',
    enough: '첫 버전의 범위를 정할 수 있으면 충분합니다: 목표 사용자, 핵심 문제, 경쟁 앱 3~5개와 차별점, 수익화 가설. 목표가 요구하지 않으면 리뷰·영상 대량 수집, 통계 표본, 원본 데이터 보관을 하지 마세요.' },
  brief: { work: 15, review: 8, scope: 'brief.md 3~6쪽',
    enough: 'MVP 기능 목록, 핵심 사용자 흐름, 기능별 수용 조건, 제외 범위가 있으면 충분합니다. 수치 밸런스는 첫 값과 조정 방법만 적고, 증명·시뮬레이션은 구현과 테스트 단계에 맡기세요.' },
  architecture: { work: 20, review: 8, scope: 'architecture.md 3~6쪽',
    enough: '폴더·모듈 구조, 상태·데이터 흐름, 화면 전환, 저장 방식, 테스트 전략, 구현 순서가 있으면 충분합니다. 세부 알고리즘과 경계 조건은 구현 단계가 테스트로 확정합니다. 시험 빌드(spike)는 꼭 필요할 때만 짧게.' },
  design: { work: 25, review: 10, scope: 'design.md와 핵심 화면 시안 몇 장',
    enough: 'MVP 화면 흐름, 화면별 레이아웃·상태·피드백, 색·간격·글꼴 토큰, 에셋 목록이 있으면 충분합니다. 모든 화면의 완성 시안이나 변형은 필요 없습니다.' },
  assets: { work: 40, review: 12, scope: 'MVP 화면에 실제로 쓰는 에셋',
    enough: 'MVP 화면과 플레이에 필요한 에셋이 연결되고 규격 검사를 통과하면 충분합니다. 변형·추가 해상도·장식용 에셋은 나중에 만드세요.' },
  build: { work: 120, review: 20, scope: '작동하는 MVP와 핵심 테스트',
    enough: '수용 조건을 만족하고 빌드와 핵심 테스트가 통과하면 충분합니다. MVP 밖의 기능은 만들지 마세요.' },
  test: { work: 40, review: 15, scope: '빌드, 자동 테스트, 핵심 사용자 흐름',
    enough: '실제 빌드와 핵심 흐름을 직접 실행해 결과를 남기면 충분합니다. 실패는 재현 방법과 함께 보고하세요.' },
  policy: { work: 15, review: 8, scope: '정책·권한 점검표 1~3쪽',
    enough: '현재 소스의 권한·SDK·데이터 흐름이 정책과 맞는지와 남은 조치가 있으면 충분합니다.' },
  listing: { work: 15, review: 8, scope: '스토어 설명, 스크린샷 목록, 출시 점검표',
    enough: '실제 기능과 맞는 한국어·영어 설명, 스크린샷 촬영 목록, 출시 점검표가 있으면 충분합니다.' },
  internal: { work: 25, review: 10, scope: '내부 테스트 빌드와 설치 안내',
    enough: '버전·패키지·아티팩트가 확인된 빌드와 재현 가능한 로그가 있으면 충분합니다.' },
  release: { work: 15, review: 8, scope: '출시 준비 점검 1~2쪽',
    enough: '남은 차단 사유와 되돌리기 계획이 정리되면 충분합니다.' },
});

/** Stages whose output is a document the next stage builds on; their reviews pass non-blocking defects on. */
export const DOCUMENT_STAGES = new Set(['research', 'brief', 'audit', 'plan', 'architecture', 'design', 'policy', 'listing', 'release']);
const MAX_FOLLOW_UPS = 12;

export const stageBudget = (nodeId, phase) => STAGE_BUDGETS[nodeId]?.[phase === 'review' ? 'review' : 'work'] ?? null;

export function budgetInstruction(node, phase) {
  const budget = STAGE_BUDGETS[node.id];
  if (!budget) return '';
  if (phase === 'review') {
    return '검토 예산: 약 ' + budget.review + '분. 산출물을 다시 만들거나 전체를 재검증하지 말고, 다음 단계에 영향을 주는 결함이 있는지 판단하세요.';
  }
  return '시간·분량 예산: 약 ' + budget.work + '분, ' + budget.scope + '. ' + budget.enough +
    ' 예산을 넘길 것 같으면 범위를 줄이고 남은 사항을 보고서 next에 적은 뒤 마치세요.';
}

export function reviewInstruction(node) {
  if (!DOCUMENT_STAGES.has(node.id)) {
    return '구현·검증 단계라 기준을 낮추지 마세요. 직접 실행해 확인하고, 결함이 있으면 failed로 보고하세요.';
  }
  return '문서 단계 검토입니다. 다음 단계가 잘못된 것을 만들게 하는 차단 결함만 failed로 보고하세요. ' +
    '세부 결함, 개선점, 구현이나 테스트에서 확인할 사항은 outcome을 passed로 두고, 보고서의 "followUps": ["…"] 배열(최대 ' + MAX_FOLLOW_UPS + '개, 항목마다 한두 문장)에 적으세요. ' +
    '후속 과제는 다음 관련 단계의 작업 지시에 전달됩니다.';
}

/** Follow-ups recorded by the passed work and review of a stage's direct dependencies. */
export function followUpsFor(run, node) {
  const seen = new Set();
  for (const dep of run.nodes.filter((item) => node.deps?.includes(item.id))) {
    for (const report of [dep.review, dep.report]) {
      if (report?.outcome !== 'passed' || !Array.isArray(report.followUps)) continue;
      for (const item of report.followUps) if (typeof item === 'string' && item.trim()) seen.add(item.trim());
    }
  }
  return [...seen].slice(0, MAX_FOLLOW_UPS);
}

export function followUpsInstruction(run, node) {
  const items = followUpsFor(run, node);
  if (!items.length) return '';
  return '선행 단계 검토가 남긴 후속 과제(이 단계에서 해결하거나 확인할 것):\n' + items.map((item) => '- ' + item).join('\n');
}
