# Neon 작업실 · 픽셀 UI 시안

오른쪽 사이드바의 첫 화면에 작업 신호, 시작 지연, 사람에게 필요한 조치를 보여준다. 각 단계는 해당 팀이 사용하는 도구가 놓인 작업 자리로 나타난다. 상태 문구는 언제나 HTML 텍스트로 표시한다.

| 탭 | 340px | 520px |
| --- | --- | --- |
| 오늘 이어하기 | [시안](mockups/today-340-시안.png) | [시안](mockups/today-520-시안.png) |
| Auto App · 시작 지연 | [시안](mockups/auto-340-시안.png) | [시안](mockups/auto-520-시안.png) |
| Auto App · 두 단계 병렬 작업 | [시안](mockups/auto-parallel-340-시안.png) | [시안](mockups/auto-parallel-520-시안.png) |
| Play Store | [시안](mockups/play-340-시안.png) | [시안](mockups/play-520-시안.png) |
| 에이전트 | [시안](mockups/agents-340-시안.png) | [시안](mockups/agents-520-시안.png) |

모든 시안은 합성 데이터다. 단계 카드를 실시간 동작과 함께 검토하려면 [로컬 스프라이트 데모](../../../panel/pixel/demo.html)를 브라우저에서 파일로 연다.

## 상태 판정에 쓰는 데이터

- 기준은 최신 `projectState(state, 'summary')`의 `runs[].nodes`, `jobs`, `waiting`, `operations`, `limits`다. 현재 배정은 `node.active.nonce` 또는 `node.pendingReceipt.nonce`로 `job.nonce`와 연결한다. `operations[]`의 `condition`과 `lastProgressAt`도 같은 nonce로 연결한다. `node.active.phase`는 검토/작업 역할을 정한다. `active.state`가 있을 때 초기 `launching` 힌트로만 쓴다. 엔진의 기본 active에는 state가 없고, 런타임이 복제한 값이 현재 job보다 뒤처질 수 있다.
- **작업 신호 확인**은 현재 job의 `agentState === 'working'`, `promptSeen === true`, 현재 job의 `sessionId`, 유효한 `lastAgentEventAt` 조합을 쓴다. 자체 전달 job은 `promptRecovery.state === 'sent'`도 필요하다. agent event가 배정 시작과 확인 가능한 전송 시각 `promptRecovery.at`보다 오래됐으면 제외한다. `promptSeen` 단독은 시작 모달에서도 올라갈 수 있다. 세션/시각이 없는 구형 job은 확실해질 때까지 정지 화면으로 표시한다.
- `lastAgentEventAt`은 기록된 에이전트 상태 시각이다. ms 숫자와 ISO 시각을 처리하고 유효한 양의 값만 사용한다. `operations[].lastProgressAt`은 배정/준비/지시 전송/상태/실패의 마지막 기록이라 보조 표시에는 쓸 수 있다. `updatedAt`과 준비/전송 시각으로 작업 신호의 유효기간을 갱신하지 않는다. 상태가 오래 유지되는 에이전트는 실제로 작업 중이어도 새 신호를 보내지 않을 수 있으므로 `조용함`은 관측 상태다. 툴팁에는 «최근 에이전트 상태 기록 기준. 작업 내용은 측정하지 않습니다.»를 쓴다.
- `run.events`는 summary push에서 빠진다. 이미 읽은 상세 `runs.get`의 `events[].id/type/at/nodeId/phase/nonce`는 검사 내역/같은 배정의 보조 시각과 단발 전환 중복 방지에 사용한다. 예를 들어 `task.redispatch`, `task.blocked`, `task.launched`, `task.retry-requested`, `run.cancelled`는 원인을 설명하는 이력이다. 이전 nonce의 이벤트나 로딩 중인 stale detail이 최신 상태를 덮어쓰면 안 된다. 지표를 만들기 위한 추가 상세 RPC나 작업 공간 폴링은 필요 없다.
- 준비 실패와 자율 재시도는 별도 카운터다. `node.deliveryRetries`는 연속으로 준비되지 않았거나 입력 전에 거절된 시작 횟수다. 현재 런타임은 재배정 2회, 처음을 포함해 최대 3번의 준비 확인을 한다. `run.autonomy.retries[node.id]`는 별도의 자율 재실행 횟수로, 기본 상한은 단계별 3, 실행 전체 12(`autonomy.total`)다. `node.attempts`, `node.reviewAttempts`, `job.attempt`는 작업/검토의 시도 표시용이다. 시작 전 실패가 환급될 수 있다. 상세에 세 항목을 분리해 표시하고 두 값을 합치지 않는다.

## 상태표

각 항목은 `.px-sprite[data-team][data-pose]`의 pose와 해당 아틀라스 행에 대응한다. 프레임은 왼쪽부터 0–3이다. `정지`는 0번 프레임이다. 위쪽의 명시적 상태를 먼저 확인한다. 아래쪽의 대기 분기는 배정이 없을 때만 적용한다.

| 상태와 표시 문구 | 포즈 · 행 | 프레임과 타이밍 | 근거와 화면 동작 |
| --- | --- | --- | --- |
| 실행 완료 | `completed` · 14 | 0 · 정지, 트로피 | `run.status === 'completed'`. 실행 헤더와 목록에서만 트로피. 각 단계는 통과/건너뜀을 유지한다. 기존 개선 이어하기와 결과 열기를 표시한다. |
| 취소 요청 처리 중 / 취소 완료 / 종료 확인 필요 | `cancelled` · 13 또는 `blocked` · 11 | 0 · 정지, 정지 표식 또는 자물쇠 | `ui.cancelling`이면 요청 처리 중, `run.status === 'cancelled'`이면 `cancelUnsaved/stopFailures` 확인. 저장 또는 종료가 확인되지 않으면 `취소 저장 대기` / `종료 확인 필요`와 기존 터미널 확인 버튼. 이미 통과하거나 건너뛴 단계는 그대로 둔다. 미완료 단계의 엔진 `blocked`를 취소로 표시한다. |
| 통과 | `passed` · 9 | 0 · 정지, 책상 위 체크 | `node.status === 'passed'`. `completedAt`은 단계 완료 시각. 에이전트 턴 종료만으로 통과가 되지 않는다. |
| 건너뜀 | `skipped` · 12 | 0 · 정지, 우회 화살표 | `node.status === 'skipped'`. 통과 수의 분자에 포함하지 않는다. |
| 확인 필요 · 시작 여부 불명 / 작업 신호 종료 불명 | `blocked` · 11 | 0 · 정지, 잠긴 문 | `node.launchUncertain`, `job.state === 'uncertain'`, `promptRecovery.state === 'uncertain'`, 또는 같은 nonce의 `operation.condition === 'unclear'`. 기존 확인/동기화 동작을 노출한다. 화면이 확인되지 않았다면 시작 대화상자를 특정하지 않는다. |
| 멈춤 · 시작 화면 / 로그인 필요 / 사용 한도 | `blocked` · 11 | 0 · 정지, 잠긴 문 | `job.blocker.kind`: `hook-review` → `멈춤 · 시작 화면`, `login` → `로그인 필요`, `usage-limit` → `사용 한도`. 미래의 구조화된 시작 모달 kind도 같은 pose. blocked/uncertain 상태가 함께 있으면 확인된 원인을 먼저 쓰고 종료 확인 필요 여부를 덧붙인다. 세부 조치는 `runtimeMessage/failureReason`이나 `pendingReceipt.blocker`에서 확인한다. |
| 멈춤 · 시작 준비 실패 / 확인 필요 | `blocked` · 11 | 0 · 정지, 잠긴 문 | `node.status === 'blocked'`; `deliveryRetries >= 3`이면 `시작 준비 실패 · 3/3`. `job.promptRecovery.state === 'rejected'`도 확인 필요. `run.runtimeMessage`나 `run.workspaceCreation.state === 'uncertain'`만 있는 실행은 헤더에서 확인 필요. 남은 단계가 시작할 수 없으면 기존 대기 사유를 보여준다. |
| 실패 | `failed` · 10 | 0 · 정지, 책상 위 X | `node.status === 'failed'` 또는 현재 job의 명시적 실패 `agentOutcome === 'failure'`. job 수준이면 `에이전트 오류 · 처리 대기`로 표시하고 확정 실패는 단계 상태를 기다린다. `operation.condition === 'error'`에 구체적인 실패 근거가 부족하면 `배정 확인 필요`를 쓴다. |
| 확인 필요 · 승인 대기 | `approval` · 7 | 0 · 정지, 손 든 사람 | `node.status === 'awaiting-approval'` 또는 `waiting[id] === '승인 대기'`. 승인/반려/범위 확인은 기존 승인 폼을 연다. 터미널의 `job.agentState === 'blocked'`는 같은 손 포즈에 `확인 필요 · 터미널 응답`, `waiting`은 `응답 대기`로 표시한다. 일반 터미널 대기를 승인 권한으로 간주하지 않는다. 자체 전달 전 상태라면 명시적 blocker를 제외하고 아래 시작 규칙을 우선한다. |
| 시작 지연 · 재시도 2/3 | `retry` · 3 | 0–3, 960ms 1회 · 손 듦/노크/표시/손 내림 | `0 < deliveryRetries < 3`이고 해당 단계가 시작 전이거나 배정 대기 중. 표시 수는 기록된 시작 실패 횟수다. 예시는 «준비 실패 2회 · 세 번째 시작 확인 중» 또는 아직 배정이 없으면 «재배정 대기». 실제 카운터 증가에 한 번만 노크하고 같은 카운터 동안 닫힌 문을 정지시킨다. 3회 실패는 blocked. `waiting[id]`도 함께 표시해 슬롯 대기를 숨기지 않는다. |
| 자율 재시도 n/3 | `retry` · 3 | 960ms 한 번, 이어서 정지 | 동일 단계 `autonomy.retries[id]`가 늘고 현재 상태가 새 작업/검토 배정을 기다리거나 수락을 확인하는 동안. 현재 재실행은 `attempts/reviewAttempts` 또는 배정 nonce로 확인한다. 현재 작업이 확인되면 정상 작업 포즈로 전환하고 «자율 재시도 n/3»은 상세 이력에 남긴다. 복구 상태가 불명확하면 해당 표시를 우선한다. |
| 시작 중 | `start` · 1 | 0–3, 800ms 1회 · 자리로 3px 걸어감 | 활성 배정이 생겼고 job이 launch 중, 또는 자체 전달에서 `promptRecovery`가 없거나 `sending`, 혹은 최근 수락 증거를 기다리는 경우. `active.startedAt`/동일 job의 `startedAt` 기준 **15초 미만**. 이후 동작 없이 자리에서 대기하다 아래 포즈로 바뀐다. |
| 시작 신호 대기 | `start-slow` · 2 | 0 · 정지, 시계 | 위 시작 상태가 **15초 이상** 이어짐. 별도 오류 근거가 없으면 `준비 신호 대기`, 전송했으나 확인 전이면 `작업 시작 확인 대기`. 런타임의 실제 준비 확인(최대 60회, 1초 간격)과 전송 확인 지연(45초)을 그대로 둔다. 시각이 없으면 `시작 시각 미확인`. |
| 보고서 확인 대기 / 턴 종료 · 보고서 대기 | `report` · 15 | 0 · 정지, 문서 | job의 `state === 'awaiting-report'`, `operation.condition === 'report'`, 또는 수락한 턴이 `agentState === 'done'`. 위쪽 차단/승인/실패가 우선이다. |
| 검토 중 | `review` · 8 | 0–3, 1,200ms 루프 · 문서 위 돋보기 | current nonce의 작업 신호 확인 조건과 최근 기록(<3분), `active.phase === 'review'`. 담당자는 `node.reviewer`이고 같은 팀/책상을 쓴다. 기존 결과의 독립 검토 인계 연결을 유지한다. |
| 작업 중 | `work` · 0 | 0–3, 800ms 루프 · 손/작업 도구/작은 틱 | current nonce의 작업 신호 확인 조건과 최근 기록(<3분), `active.phase === 'work'`. 팀 소품이 작업 내용을 구분한다. 애니메이션은 «작업 신호가 확인됐음»을 나타낸다. |
| x분째 조용함 | `quiet` · 4 | 0 · 정지, 책상에 기댐 | 같은 신뢰 조건의 `agentState === 'working'`에서 마지막 신호 **180초 이상**, 분 단위 내림. 검토도 동일하게 정지하고 «검토 · 3분째 조용함»으로 역할 유지. 아직 실제 정지/실패로 단정할 수 없다. |
| 작업 신호 미확인 | `unknown` · 18 | 0 · 정지, 물음표 | active나 잔여 reservation은 있으나 job/세션/시각/상태를 아직 확인할 수 없고 런타임이 launch 중임도 확인하지 못한 경우. «기록 없음»과 기존 동기화 버튼. |
| 새 배정 멈춤 | `paused` · 17 | 0 · 정지, 일시정지 표식 | `run.status === 'paused'` 또는 `waiting[id] === '일시 정지'`이고 배정 없음. 실행 헤더에 정지 문구와 함께 실제 활성 작업 수가 확인되면 «새 배정 멈춤 · 작업 1개 계속»으로 표시한다. 이미 실행 중인 단계에는 실제 pose를 유지한다. |
| 선행 단계 대기 | `dependency` · 6 | 0 · 정지, 모래시계 | `waiting[id] === '선행 단계 대기'` 또는 `deps`에 미통과 노드. 카드에는 «선행 대기», 툴팁에는 미통과한 단계명, 근거가 있으면 «해당 단계 처리 대기». `확인이 필요한 단계 처리 대기`는 «다른 단계 확인 대기»를 쓴다. |
| 슬롯 대기 / 차례 대기 / 검토 배정 대기 | `queue` · 5 | 0 · 정지, 순번표 | `waiting[id]`의 `전체 작업 n개 실행 중`, `빌드 작업 완료 대기`, `실행별 한도`, `쓰기 작업 완료 대기`, `배정 순서 대기`. active 없이 `node.status === 'review'`이고 특별한 사유가 없으면 «검토 배정 대기». 숫자는 실제 점유/한도(예: «전체 2/2»)만 표시한다. 스케줄러는 고정 순번을 노출하지 않으므로 대기 위치는 표시하지 않는다. |
| 시작 전 / 미배정 | `idle` · 16 | 0 · 정지, 기본 캐릭터 | `!run.started`, `waiting[id] === '시작 전'`, 혹은 팀에 실제 배정 및 대상 단계가 없음. 사용자 정의 단계는 `other` 팀으로 표시한다. |

자율 재시도 카운터는 누적값이다. 누적값만 보고 이미 종료된 재시도를 다시 표시하면 안 된다. 비교 가능한 이전 push 또는 현재 배정과 이어진 타입/nonce가 일치하는 이벤트가 없으면 단계의 시작/대기 상태를 표시하고 자율 카운터는 상세에 남긴다.

**전환 제한.** 처음 진입, 재렌더, 탭 복귀에 `once`를 새로 붙이지 않는다. 초기 로딩에서 pending 상태를 추정해 걷거나 노크하지 않는다. 새로운 배정 nonce 또는 실제 준비 실패 횟수 증가가 관측될 때만 한 번 재생한다. 같은 nonce/카운터에서 `once`가 유지되도록 해당 노드를 재사용하거나 한 번의 모션 창에서만 원래 이벤트 시각을 기준으로 negative delay를 적용한다. 동작 중 탭을 나가면 숨겨진 스프라이트의 애니메이션은 중단한다. 도움말/일반 페이지 전환/Play 배지/날짜의 자동 모션은 사용하지 않는다.

## 네 탭 배치

### 공통

상단은 픽셀 Neon 심볼, 제품 이름, 새로고침, 기존 네 탭 순서다. 활성 탭은 3px 밑줄과 굵기로 구분하고 `aria-current="page"` 또는 현재 키보드 패턴에 맞게 `aria-selected`를 적용한다. 시안에만 `시안` 라벨을 넣는다. 본문의 긴 한글은 단어 단위로 줄바꿈하고 폭이 좁으면 `overflow-wrap:anywhere`를 허용한다. 목적지 링크, 비용과 완료 근거의 원래 시맨틱을 유지한다.

| 항목 | 340px | 520px |
| --- | --- | --- |
| 가로 바깥 여백 / 내부 패널 | 12px / 8–9px | 16px / 10–12px |
| 세로 흐름 | 단일 열. 패널 간 8–12px | 동일. 팀 작업실만 2열 |
| 컨트롤 | 최소 36px, 카드 버튼 최소 44px, 메뉴 37px | 같은 높이 기준 |
| 요약 행 / 작업실 | 32px 캐릭터, 중요한 시작 실패 헤더는 64px. Play 아이콘 32px | 요약/팀 카드 32px, 작업실과 시작 실패 헤더 64px |

### 오늘 이어하기

1. «내가 봐야 할 것»을 가장 먼저 배치한다. 명시적 사람 조치를 맨 앞에 두고(시작 창, 승인, 불확실 종료, 실패), 자동 재시도/조용함은 이유를 알 수 있는 관찰 항목으로 그 뒤에 둔다. 자동으로 복구 중이면 사용자 액션이 필수인 것처럼 표시하지 않는다. 항목을 누르면 해당 실행의 단계 상세로 이동한다.
2. «실행 현황»은 실행당 한 개의 article. 제목, 통과 수, 같은 에이전트의 32px 자세와 단계·상태 버튼을 표시한다. 병렬 작업을 각각 표시하고 좁을 때 버튼들이 다음 줄로 접힌다. 예약 슬롯을 작업 중으로 표시하지 않는다. «이어서 할 일» 버튼과 완료 결과, 기록, 보관, 인계 메모를 그 다음에 배치한다. 상세 버튼이 없는 실행은 기존 흐름 열기 동작을 제공한다.

### Auto App

1. 실행 목록과 동기화 다음에 지금 상태 배너를 놓는다. 340px에서도 «화면 설계 · 시작 지연 · 재시도 2/3»가 한 줄 안에 들어가는 길이를 기준으로 쓴다. 긴 프로젝트/단계명, 번역 및 확대 시 두 줄을 허용하고 상태·횟수·행동 이유를 자르지 않는다. 아래 보조 줄은 원인/조치(예: «준비 신호 대기 · 반복되면 시작 화면 확인»). 이어서 `경과 1분 18초 · 마지막 기록 18초 전`을 붙인다. 복수 활성은 «구조·화면 설계 · 2개 작업 중»처럼 요약하고 개별 단계 카드를 연결한다. 차단과 실제 작업이 같이 있으면 긴급 원인 먼저, 보조 줄에 작업 중 수 표기. `경과`는 현재 최우선 단계 배정 시각 기준, 병렬 배너에서 가장 오래된 활성 배정 기준이다. `run.started`는 불리언이므로 실행 전체 시간처럼 표시하지 않는다. 활성 배정이 없고 보류 기록에 시작 시각도 없으면 «경과 미확인». `마지막 기록`은 배너가 가리키는 단계의 최근 job/이벤트 시각이며 없으면 «기록 없음».
2. 배너 바로 아래 실행 당 하나의 `제작 작업실`. 경로는 다음과 같이 편다. 시장·앱 조사 → 제품 기획은 가로. 둘 아래 두 열로 `architecture`와 `design`. 에셋은 design 아래. 설계 레일은 에셋을 피해 통과하고 에셋과 합쳐져 앱 구현으로 이어진다. 테스트는 구현 바로 아래. 실제 의존선은 `node.deps`만 사용한다. 홈 폭이 440px 이상이면 등장인물 64px, 그보다 좁으면 32px. 단계/팀/상태 문구는 두 폭에서 유지한다.
3. 새 앱 후반 `policy → listing → internal → release`는 같은 작업실 하단의 «출시 준비» 접기로 이어진다. `listing`의 `test` 의존선도 선택한 단계의 연결 내역에서 확인된다. 후반에 실제 시작/재시도/실패/승인이 있으면 자동으로 열린 상태가 기본이다. 시작부터 배포까지 하나의 scene 내에서 탐색한다.
4. 쉬운 개선이나 진단 그래프는 같은 컴포넌트의 단일 경로로 따라간다(예: `identity → diagnose`). 커스텀 그래프는 topological rank를 줄로 배치하고 rank 안에 최대 두 열씩 접는다. 기존 범위 제외와 QA→build 수정 요청은 구분된 역방향 선과 «수정 요청 n/m» 텍스트를 쓴다. 경로 색은 해당 선의 선행 단계가 통과하면 민트 실선, 다음 활성으로 진입할 때는 민트 끝점, 복구/거절은 앰버, 미완료 의존은 점선 또는 회청색 고정선이다. 상태 설명은 station의 라벨과 상세로 제공한다.
5. 단계 카드를 누르면 같은 경로 아래에 기존 단계 상세가 열리고 바로 접근할 수 있다. 사전 점검/결과/토큰/비용/실행 방법은 기존 내용을 유지하며 배너나 작업실을 화면 아래로 밀지 않도록 해당 구역 뒤의 펼침 영역으로 옮긴다. 시작 불가 사유, 현행 버튼과 실패 안내는 사용할 수 있어야 한다.

### Play Store

1. 연결 계정, 마지막 실측 시각, 지금 점검 버튼. 이어서 앱/패키지 검색과 상태 필터, 앱 목록. 340px에서 검색/필터의 열 폭은 대략 198/110px, 520px에서 약 310/166px. 32px 픽셀 앱 아이콘, 앱 이름/패키지, 상태 스탬프, 펼침 표시 순. 긴 패키지는 일반 텍스트로 줄바꿈. 트랙이 펼쳐지면 기존 상세/링크/제출 조작에 그대로 접근한다.
2. 스탬프는 16px 인쇄 표식과 문구를 같이 둔다. 여러 프로덕션 상태가 있는 앱은 지우거나 하나로 합쳐 표시하지 않는다. 340px에서는 배지 그룹이 필요시 앱 이름 밑 줄로 내려간다. 조회 오류/노후 관측은 별도의 조회 상태다. Play에 애니메이션은 없다.

| 코드 | 문구 | 스탬프 |
| --- | --- | --- |
| `draft` | 초안 | 종이 · 회청 실선 |
| `in_review` | 심사 중 | 모래시계 · 앰버 파선 |
| `published` | 게시됨 | 체크 · 민트 실선 |
| `rejected` | 거부됨 | X · 산호색 실선 |
| `approved_not_published` | 승인 · 게시 전 | 인장 · 앰버 이중선 |
| `no_production` | 프로덕션 없음 | 빈 상자 · 회청 점선 |
| `lookup_error / stale / unknown` | 조회 오류 / 재확인 필요 / 미확인 | 느낌표 / 시계 / 물음표 |

### 에이전트

1. «Neon 작업 자리»에 `limits.active/activeJobs`와 `limits.heavy/heavyJobs`를 숫자와 책상 그림으로 표시한다. 기본이 2/1이며 설정값이 있으면 그 값을 사용한다. occupied는 배정/아직 종료가 확인되지 않은 job도 포함한다. 현재 점유가 한도보다 높으면 숫자를 그대로 표시하고 «한도 초과 n»을 쓴다. 전체 자리 안에 heavy가 포함되므로 두 값을 합산하지 않는다. 숫자가 미확인이면 «집계 없음». 모형만 꽉 채우지 않는다.
2. 팀 작업실은 340px에서 1열, 520px에서 2열이다. 선택한 실행 또는 전체 실행의 7개 팀을 표시한다. 실시간 대표는 해당 팀 내 사람이 확인해야 하는 단계/작업 중/배정 중/대기/최근 완료 순으로 고르되, 다른 활성 단계는 «+n개»와 상세의 목록으로 남긴다. 사용자 정의 팀은 노드가 있을 때 추가한다. 해당 팀에 배정된 단계가 없어도 기본 캐릭터와 «미배정»을 표시한다. 작업자와 검토자를 개별 역할로 표시하는 기존 roster는 팀 펼침에서 제공한다. 상세, 운영 현황, 배정 양식, 외부 Orca 에이전트는 아래에서 접근한다.

## 디자인 토큰과 간격

| CSS 변수 | 지정값 | 용도 |
| --- | --- | --- |
| `--px-bg`, `--px-panel`, `--px-raised`, `--px-well` | `#10141F #181F2E #202A3D #111927` | 페이지, 카드, 입력 및 호버, 작업실 |
| `--px-line`, `--px-strong-line`, `--px-shadow` | `#34425B #677C9B #090D16` | 구획, 인터랙티브 외곽, 하단 픽셀 그림자 |
| `--px-text`, `--px-muted`, `--px-neutral` | `#F1F4FA #AAB8CF #BAC5D8` | 본문, 보조, 정지/대기 |
| `--px-focus`, `--px-good`, `--px-review` | `#88EBFA #7CE9C6 #D7C8FF` | 포커스, 작업/통과, 검토 |
| `--px-warn`, `--px-stop` | `#FFCE80 #FF9CA5` | 확인/지연, 실패/차단 |
| `--px-warn-bg`, `--px-stop-bg`, `--px-work-bg` | `#2C241E #302129 #182E35` | 해당 상태 배경 |

팀 색은 `teams.css`의 다크 모드를 그대로 사용한다. `plan #A9D1FF` 문서와 모자, `arch #D7C8FF` 격자와 바이저, `design #FFC1E3` 팔레트와 베레모, `build #FFCEAA` 터미널과 헤드셋, `money #FFBFD9` 동전과 리본, `qa #A9EAD9` 파형 모니터와 고글, `ship #F2DE9E` 상자와 후드. 문서 배경에 쓸 때 같은 색을 채움으로 쓰지 않고 테두리 또는 팀명에 사용한다. 담당 팀 색과 작업 상태 색의 역할을 구분한다.

- 한국어는 `system-ui, -apple-system, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`. 페이지 제목 24/30px 750, 섹션 15/22px 700, 카드 제목/본문 13/19px, 상태 12/16px 굵게, 메타/시간 11/16px. 10px는 짧은 스탬프·시안 라벨과 작업실의 보조 팀 이름에 한정한다. 패키지·숫자·브랜드용 설치된 시스템 모노 폰트 `ui-monospace, SFMono-Regular, Consolas, monospace`. 시간에 `tabular-nums`. 폰트 번들 없음, 별도 폰트 라이선스가 필요한 파일 없음.
- 2px 픽셀 그리드 기준. 4/8/12/16/24px 간격, 사각 1px 테두리와 2px 수직 그림자. 선택은 안쪽 2px 테두리, 키보드 포커스는 바깥쪽 2px 하늘색 + 2px offset. 픽셀 이미지에는 32/64px 또는 16/32px 정수배와 `image-rendering: pixelated`를 고정한다.
- 텍스트/배경 대비 목표 4.5:1 이상, 포커스와 필요한 컨트롤 경계 3:1 이상. 옅은 구획선(`--px-line`)은 패널 구분에 쓰며 입력/조작 경계에는 `--px-strong-line` 또는 확인/성공 상태의 경계 색을 쓴다. 포커스, 선택, 클릭 가능 여부, 상태를 색 하나에 의존하지 않는다. 시안 토큰 대비는 본문/카드 14.96:1, 보조/입력 7.17:1, 작업/작업 면 9.67:1, 확인/확인 면 10.44:1, 실패/실패 면 7.67:1, 포커스/입력 10.49:1, 컨트롤 외곽/입력 3.38:1이다. 라이트 모드는 기존 토큰의 전경 대비를 보존하고 스프라이트는 동일한 다크 작업대 위에 두는 형태로 현행 용도를 유지한다.

## 키보드, 툴팁, 시간과 모션

- 각 station과 요약 칩은 단일 `button`이다. 기존 `data-action="select-node"`, `data-node`와 필요시 `data-run`을 쓴다. `Enter/Space`로 활성화, `Escape`로 tooltip 닫기. `aria-controls`로 상세 연결, 선택 카드에 `aria-expanded`나 기존 선택 의미를 적용한다. 카드 안에 별도 버튼을 중첩하지 않는다. 에이전트와 Play 패널은 `details/summary`의 기존 키보드 동작을 유지한다.
- 마우스 hover와 키보드 focus에 동일한 설명을 노출한다. 내용은 팀명, 전체 단계명, 현재 상태, 긴 대기 이유, 마지막 기록 시각. 설명은 `role="tooltip"`, `aria-describedby`로 연결하고 스프라이트/경로/장식은 `aria-hidden="true"`. 설명 없이도 상태를 읽을 수 있다. 클릭 후 기존 inspector heading으로 포커스를 옮기고 복귀 시 원래 station을 포커스한다. 배경 push 중 누르던 폼, 입력, 열어 둔 접기 상태와 포커스를 유지한다.
- 기존 `#announcer`에는 실제 상태 변화에만 한 번 알리고 같은 경과 시각과 무의미한 일괄 리렌더를 읽지 않는다. `time datetime`과 기존 로컬 ticker로 시간 문구만 바꾼다. 15초/3분 경계에서 포즈와 텍스트를 함께 바꿔 정지 화면과 실제 설명이 일치하도록 한다. 표시 여부나 동일 nonce 검사를 시각 계산과 분리한다. 프레임별 JS, 캔버스, 폴링으로 애니메이션을 만들지 않는다.
- `prefers-reduced-motion: reduce`에서는 CSS가 0번 프레임을 유지한다. 대기/재시도/검토/작업의 기본 자세와 글자 정보, 포커스 및 상세 조작이 전부 남는다. 기존 `pulse-*` / 상태 배경 전환 및 이동 모션도 같은 미디어 규칙에 맞춘다.

## 개발자 구현 메모

| 파일 | 적용 범위 |
| --- | --- |
| `panel/pixel/sprites.css`와 PNG | 이 브랜치 산출물을 그대로 참조. CSS는 한 행을 4열로 잘라 보여준다. `data-team="design" data-pose="retry"` 등에만 연결한다. `data-motion="live"`는 작업/검토, `once`는 시작/노크 전용. `px-2x`는 2배수. 호스트의 배경색을 추가하려면 `background-color`만 사용한다. 바깥 CSS에서 `background` 단축 속성으로 아틀라스 경로를 덮어쓰면 이미지가 사라질 수 있다. |
| `panel/pixelview.mjs` (신규) | `pixelStage(run,node,{now,limits})`, `pixelRun(run,ctx)`, `sprite(view,{size})`, `productionStamp(status)`와 같은 순수 어댑터. 위 판정표를 한 곳에서 구현. 출력은 `pose, tone, label, reason, phase, attempt, startedAt, activityAt, retryKind, retryCount, action`과 읽기용 추가 값. 상한 정책은 기존 런타임 설정과 확인하고 준비 실패/자율/단계 시도는 별도. UI 전용으로 스케줄러/승인/취소 동작을 변경할 필요는 없다. |
| `panel/teams.mjs` | `teamOf/currentJob`과 기존 로스터 공유. 새로운 pixel adapter는 최신 summary의 `waiting/operations`를 읽는다. 기존 `stageState`와 이벤트 transition 계약을 inspector 등에서 쓴다면 그대로 두고 작업실 derivation에 추가한다. `currentJob`이 찾지 못한 현재 예약은 `operations`로 확인한다. |
| `panel/flow.mjs` | 작업실 `.px-workshop`, `.px-rail`, `.px-station`, `.px-stage-detail`을 구성. 실제 deps부터 연결선을 만들고 기존 선택/열람 액션을 호출한다. 에이전트 탭에 `.px-team-room` 및 `.px-team-card`를 추가하고 기존 `people`, `assignmentForm`, `collabStrip` 및 수정 요청/인계 세부 내용을 펼침으로 유지한다. |
| `panel/studio.mjs` | `renderToday` 위에 `.px-attention`, `.px-run-list` / `.px-run-row`. `renderStudio`에서 runPicker 뒤 `.px-run-banner`와 작업실을 먼저 그리고 기존 결과/대화상자/작업 등록 유지. `renderPlay`의 `playAppList`에서 `.px-stamp` 및 `data-mark`만 적용, `filteredPlayApps`와 상태 분류 유지. `renderAgents`에 `.px-desks` 다음 `.px-team-room`. timer는 `tickTimes` 확장 및 임계점만 갱신. 화면 상태와 애니메이션 트리거는 각 `run.id/node.id/phase/nonce`에 귀속한다. |
| `panel/index.html`, `panel/pixel-layout.css` (신규) | 기존 CSS 뒤에 `./pixel/sprites.css`와 새 레이아웃 CSS를 연결. 모든 공통 색/포커스/타입과 상태별 레이아웃은 `.px-*` 스코프로 유지한다. 앱 내부 폭 최소 340px에서도 overflow가 생기지 않게 minmax(0,1fr)를 사용한다. |
| `panel/teams.css`, `panel/refinement.css`, `panel/studio.css` | 팀 액센트 재사용. 기존 rounded/그림자/transition 규칙이 신규 작업실·스탬프·팀 방 상태를 덮지 않도록 우선순위 조정. 결과, 사전 점검, 배정 폼이 쓰는 기본 스타일 유지. |
| `panel/result.mjs`, `panel/costs.mjs`, `panel/operations.mjs` | 보고/검수/승인 상태 근거와 비용·시간 렌더링을 보존. 상태 배너 아래의 세부 구획에 레이아웃만 연결한다. `costs`의 합계 변화는 에이전트 활동 신호로 쓰지 않는다. |
| `tools/preview.mjs` | 로컬 프리뷰가 현재 flat css/mjs만 허용한다. `/pixel/` 하위의 정해진 png/css/demo를 allowlist 및 실제 MIME과 바이너리로 추가한다. 임의 경로 허용 금지. 샘플은 `deliveryRetries:2` with launch/pending과 두 confirmed working nonce, quiet, human approval, detached reservation, 6종 Play를 포함. `Date.now` 기준으로 생생한 최근/오래된 시각을 만들고 브라우저 폭 340/520px에서 스크린샷과 조작을 재확인한다. |
| `src/views.mjs` | 현행 summary 계약으로 초기 구현이 가능하다. 테스트에서 summary에 필요한 nonce/상태/시각이 살아 있는지 확인한다. 전체 이벤트를 summary push로 복제하지 않는다. |

테스트에서 반드시 보는 조합은 «에이전트 등록 전», «전송 보고만 있고 세션 없음», «비활동 180초 경계», «두 작업 병렬», «검토 대기와 실제 검토», «취소했지만 종료 확인 안 됨», «시간 정보 없는 구버전», «Play 조회 오류와 게시 상태가 함께 있는 앱»이다. 실제 Orca 패널에서만 nested asset 로딩, live status 이벤트 전파, CLI 시작 화면 차단 타이밍, 상세 클릭의 기존 터미널 브리지를 최종 확인할 수 있다. 이번 산출물에서는 기존 프리뷰와 합성 시안을 Aside에서 두 폭으로 각각 열어 확인했고, 사이드바 양쪽 폭에서 가로 넘침이 없었다. 데모의 Enter 확대/정지와 브라우저 모션 감소 설정을 Aside로 확인했고, Chrome 별도 프로필로 디스크에서 직접 열어 보았다.

## 출처와 아틀라스

- `panel/pixel/crew-{plan,arch,design,build,money,qa,ship,other}.png`의 각 캔버스는 128×608, 32×32 프레임, 19행(표의 포즈), 4열, 무패딩, 투명 RGBA. 합계는 아래 표에 기재. 각 pose의 0번 프레임은 자체로 뜻이 있는 정지 상태이며 비활성 열은 투명하다.
- `panel/pixel/marks.png`는 224×16, 14열로 각 칸 16×16. `sprites.css`의 `data-mark` 순서대로 배치했다. 6개 스탬프, 조회 이상 3개, 책상 3개, 앱과 브랜드 표식 각 1개다.
- `source/draw_sprites.py`의 원본 픽셀 그리드를 Python/Pillow로 작성했다. Pixel Art Studio 스킬의 그리드 제작과 알파 검사 도구를 썼다. 픽셀 캐릭터, 도구, UI 오브젝트 모두 이 프로젝트를 위해 그렸다. 기존 게임의 캐릭터나 그림을 모방하거나 외부 이미지, 생성형 이미지, 폰트, 게임 에셋을 사용한 부분이 없다. 시안은 합성 HTML을 Aside로 촬영하고 1× 이미지로 저장했다.

| 파일 | 바이트 |
| --- | ---: |
| `crew-arch.png` | 5,303 |
| `crew-build.png` | 5,290 |
| `crew-design.png` | 5,282 |
| `crew-money.png` | 5,318 |
| `crew-other.png` | 5,203 |
| `crew-plan.png` | 4,972 |
| `crew-qa.png` | 5,141 |
| `crew-ship.png` | 5,123 |
| `demo.html` | 5,570 |
| `marks.png` | 840 |
| `sprites.css` | 3,926 |
| 패널 파일 합계 | **51,968** |

시안 PNG 10장은 문서에서만 쓰이며 합계 383,014바이트다. 패널 에셋과 시안 PNG를 합쳐도 600 KB 이하다.
