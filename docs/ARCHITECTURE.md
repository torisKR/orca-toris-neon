# 설계와 실행 계약

Toris Neon은 Orca 네이티브 패널, 순수 상태 엔진, 실제 호스트 연결 계층을 분리합니다. 목적은 여러 에이전트의 진행 상황을 보여 주는 것과 함께, **어떤 결과가 검증됐고 무엇을 다시 실행해도 되는지**를 명확하게 남기는 것입니다.

## 구성

| 모듈 | 책임 | 직접 수행하지 않는 것 |
|---|---|---|
| [`engine.mjs`](../src/engine.mjs) | DAG 검증, 상태 전이, 배정 가능 작업, 제한된 재작업 루프 | 프로세스 실행·파일 읽기·네트워크 |
| [`runtime.mjs`](../src/runtime.mjs) | 작업 공간 생성, 에이전트 배정, 결과 파일 검증, 재시작 복구 | LLM 모델 호출 API 구현 |
| [`store.mjs`](../src/store.mjs) | Orca storage의 실행별 저장, 크기 예산과 압축, 이전 단일 값 이전, 저장 실패 경고와 재시도 | 실행 상태 판단 |
| [`watch.mjs`](../src/watch.mjs) | 활성 작업 주기 점검(놓친 상태 이벤트, 받지 않은 보고서, 오래 멈춘 에이전트) | 직접 배정·입력 |
| [`usage.mjs`](../src/usage.mjs) | 배정에 연결된 세션의 토큰 누계 원장(`agent.listSessions`, 감시 주기에 붙음), 기준값·작은 값·누락 처리, 패널용 요약(`tokenUsage`) | 대화 기록 스캔·합계 추정·작업 실패 처리 |
| [`cleanup.mjs`](../src/cleanup.mjs) | 끝난 작업의 에이전트 터미널 정리(유예 시간, 시작 점검) | 현재·불확실 배정이나 다른 터미널 종료 |
| [`proportion.mjs`](../src/proportion.mjs), [`reportfix.mjs`](../src/reportfix.mjs) | 단계별 시간·분량 예산과 문서 검토 기준, 형식이 거부된 보고서 수정 요청 | 상태 변경 |
| [`prompt.mjs`](../src/prompt.mjs), [`views.mjs`](../src/views.mjs) | 작업 지시 생성(결과 카드 필드·실패 분류 계약 포함), 패널·RPC용 상태 투영(summary·timeline) | 상태 변경 |
| [`scheduler.mjs`](../src/scheduler.mjs) | Neon 전체 배정 한도(동시 2개, 무거운 작업 1개), 실행 간 차례 배정, 실제 대기 이유 | Neon 밖 에이전트 제한 |
| [`commitcheck.mjs`](../src/commitcheck.mjs) | 쓰기 단계의 커밋 확인(깨끗한 트리·HEAD 이동), 검토와 커밋 연결 | 커밋 대신 만들기 |
| [`flows.mjs`](../src/flows.mjs) | `runs.create` 계획: 새 앱·개선 종류·진단·후보에서 개선·이어서 개선, 요청 키(중복 생성 방지) | 실행 시작 |
| [`artifacts.mjs`](../src/artifacts.mjs) | 보고서가 기록한 결과 파일 하나를 요청 시 읽기(실행 결과 폴더·작업 공간 안, 심볼릭 링크 탈출 거부, 크기 제한) | 상태 푸시에 파일 포함 |
| [`preflight.mjs`](../src/preflight.mjs), [`hostprobe.mjs`](../src/hostprobe.mjs) | 실행 전 점검: 단계별 실행 가능·해당 단계 불가·확인 필요와 할 일(`runs.preflight`, 시작 직전 재점검). 로그인 셸의 PATH, SDK 위치, 서명 설정 존재, Git 커밋, Play 계정 수만 확인 | 빌드 실행·시작 차단·서명 파일 읽기 |
| [`buildinfo.mjs`](../src/buildinfo.mjs) | 실행 중인 코드의 버전·커밋·수정 여부·개발 폴더/설치본 | 버전 변경 |
| [`worker.mjs`](../src/worker.mjs) | Orca 수명 주기, 명령·패널 요청 등록 | HTML 화면 렌더링 |
| [`play.mjs`](../src/play.mjs) | 계정 보호, OAuth, Play GET 조회와 캐시 | 앱 업로드·트랙 변경 |
| [`today.mjs`](../src/today.mjs) | 날짜별 기록, 인계, Git 신선도, 에이전트 재개 | 원본 작업 일지 수정 |
| [`panel/`](../panel) | 사용자 입력과 표시. `teams.mjs`(팀·상태 뷰 모델, 순수 함수), `flow.mjs`(Auto App 레인·에이전트 탭 렌더러), `newflow.mjs`(새 흐름 양식·진단 후보), `result.mjs`(결과 카드·완료 단계), `preflight.mjs`(실행 전 점검), `kit.mjs`(이스케이프·버튼 등 공용), `studio.mjs`(상태·이벤트·나머지 탭) | 직접 비밀키 저장·자체 모델 호출 |

패널은 `window.orca.plugin.request(name, input)`로 워커에 요청합니다. 워커는 `orca.panels.handle`에 등록한 핸들러를 실행합니다. 별도 HTTP 서버나 클라우드 백엔드는 없습니다.

## 상태 조회와 화면 갱신

목록에 필요한 데이터와 전체 검증 기록을 구분해 전달합니다. 응답에서 생략하는 것과 저장소에서 줄이는 것은 별개입니다. 저장소가 줄이는 범위는 아래 '저장 구조와 한도'에 있으며, 보고서 원문은 항상 실행 결과 폴더에 남습니다. HTML 패널은 평소 요약을 읽고, 사용자가 기록 상세를 펼칠 때 해당 실행의 전체 내용을 조회합니다.

| 조회 | 반환 범위 | 용도 |
|---|---|---|
| `state.get({view:"summary"})` | 활성 실행·단계 요약, 현재 배정 작업, 보관 실행 요약, 호스트 목록 | 그래프·실행 목록의 일반 갱신 |
| `runs.get({runId})` | 활성 또는 보관 실행 하나의 전체 노드·이벤트·근거·배정 이력 | 기록 상세를 열 때 필요한 조회 |
| `state.get({view:"full"})` 또는 `state.get()` | 모든 활성·보관 실행 원본과 호스트 목록 | 기존 호출 호환, 전체 상태 확인 |
| `state.get({view:"timeline"})` | 각 활성·보관 실행의 `id`, `goal`, `projectId`, `updatedAt`, 전체 `events`와 호스트 목록 | 날짜별 이력 조회 |
| 워커 내부 `runtime.getState({view:"timeline"})` | 위 실행 타임라인만 | Today에서 호스트 목록 조회 없이 사용 |

`detail`이라는 `state.get` view는 없습니다. 실행 하나의 상세 요청 이름은 `runs.get`이며, 응답은 `{run: ...}`로 감싼 형태가 아닌 실행 객체입니다.

summary에서는 노드의 `history`, 보고서의 `evidence`, 실행의 `events`·`acceptedReports`를 전송하지 않습니다. 대신 근거 개수·통과 단계 수와 현재 `active`/`pendingReceipt` nonce에 해당하는 배정 작업을 제공합니다. 결과 영수증에는 `path`, `at`, `phase`, `artifactCount`가 남습니다. 전체 근거는 `runs.get`과 full 응답으로 확인합니다. 토큰 원장(`usage`)도 summary에서 빠지고, 대신 계산된 요약 `tokenUsage`(합계·재시도·단계 미분류·세션 누계·단계별 작업/검토·범위·마지막 확인)를 실행과 보관 실행마다 보냅니다.

저장할 때 증가하는 `revision`을 포함한 summary를 `state.changed`로 알립니다. 관련 없는 에이전트 이벤트나 의미 없는 동일 상태 반복으로 전체 기록을 다시 저장하지 않습니다. 실행 시작 요청이 대기 중이어도 상태·상세 조회는 외부 실행 완료를 기다리지 않습니다.

### 표시용 호스트 정보 캐시

동시에 들어오는 같은 호스트 목록 조회는 진행 중인 요청을 공유합니다. 완료된 표시용 결과는 프로젝트 5초, 작업 공간 1.5초, 현재 문맥·에이전트 목록 250ms 동안 재사용합니다. 명시적인 새로고침은 다음처럼 요청합니다.

```js
await window.orca.plugin.request("state.get", {
  view: "summary",
  forceHost: true
});
```

`forceHost`는 완료된 표시용 캐시를 건너뜁니다. 이미 같은 호스트 조회가 진행 중이면 그 요청을 공유합니다. 권한·작업 공간 검증, 실제 실행, 재시도와 복구 확인은 이 표시 캐시를 사용하지 않습니다. 호스트 목록 새로고침 자체가 작업을 통과시키거나 결과 파일을 수입하지는 않으며, 기존 배정과 완료 파일 대조는 `runs.refresh`의 역할입니다.

## 결정 1: 그래프 상태와 외부 실행을 분리한다

상태 엔진은 새 JSON 상태를 반환하는 함수로 작성했습니다. 네트워크·파일·에이전트 실행 없이 의존성, 실패 전이, 중복 보고, 승인 상태를 재현할 수 있습니다. 실제 에이전트가 느리거나 중단되더라도 상태 전이의 정확성을 따로 검증할 수 있기 때문입니다.

기본 그래프:

| ID | 선행 단계 | 역할 | 소스 변경 |
|---|---|---|---|
| `research` | 없음 | 사용자 문제·시장·앱 조사 | 금지 |
| `brief` | research | MVP 범위·수용 조건 | 금지 |
| `architecture` | brief | 기존 스택에 맞는 구조 설계 | 금지 |
| `design` | brief | 화면·상태·접근성·에셋 명세 | 금지 |
| `assets` | design | 앱 에셋 생성·연결 | 가능 |
| `build` | architecture, assets | 실제 앱 구현·결함 수정 | 가능 |
| `test` | build | 빌드·테스트·사용 흐름 검증 | 금지 |
| `policy` | test | 현재 소스와 Play 정책 대조 | 금지 |
| `listing` | test, policy | 실제 기능에 맞는 스토어 자료 | 금지 |
| `internal` | listing | 내부 테스트 준비, 명시 승인 시 제출 | 가능·승인 필요 |
| `release` | internal | 출시 준비 검토, 명시 승인 시 제출 | 가능·승인 필요 |

여기서 “소스 변경 금지”는 배정 프롬프트의 작업 범위와 스케줄링 규칙입니다. 신뢰된 에이전트 프로세스를 파일 시스템 샌드박스로 강제 격리한다는 의미는 아닙니다. 보고서·검증 자료는 별도 결과 디렉터리에 작성합니다.

`validateGraph`는 단계 ID 중복, 없는 의존성, 순환을 거부합니다. 사용자 정의 그래프는 엔진 API에서 1–64개 노드를 지원합니다. 기본 UI는 위 앱 개발 그래프를 사용합니다.

### 상태

실행 상태는 `ready`, `running`, `paused`, `blocked`, `cancelled`, `completed`입니다. 단계는 `pending`, `running`, `review`, `passed`, `blocked`, `failed`, `awaiting-approval`을 사용합니다.

단계가 통과하려면 작업 보고서와 독립 검토가 모두 통과해야 합니다. 선행 단계가 완료됐다는 에이전트의 문장이나 터미널의 `done` 표시만으로 다음 단계에 진입하지 않습니다.

## 결정 2: 독립 검토와 횟수 제한이 있는 루프를 사용한다

모든 단계는 작업자와 별도 세션의 검토자를 가집니다. 공급자는 같아도 세션은 다릅니다. 검토자는 이전 결과, 요구사항, 실제 파일·명령 근거를 대조하며 코드를 수정하지 않도록 지시받습니다.

작업 또는 검토가 실패하면 해당 단계에 피드백을 남기고 후속 결과·승인을 무효화합니다. `test` 실패는 `build`에 재현 정보와 결함을 전달합니다. 구현 후 테스트와 그 후속 단계를 다시 검증합니다.

| 설정 | 기본값 | 범위 | 의미 |
|---|---:|---:|---|
| `maxConcurrency` | 2 | 1–6 | 실행 하나에서 동시에 배정할 수 있는 작업·검토 수 |
| `maxAttempts` | 3 | 1–10 | 단계 작업·검토 각각의 시도 한도 |
| `maxRepairLoops` | 3 | 0–6 | 테스트 실패를 구현으로 돌려보내는 횟수 한도 |

시도 횟수와 수정 루프 한도를 함께 확인합니다. 먼저 도달한 한도가 적용되므로, 기본 설정이 “첫 시도 뒤에 세 번을 반드시 더 시도한다”는 뜻은 아닙니다. 사용자 재시도도 이미 쓴 횟수를 지우지 않습니다.

오류가 사라지지 않았는데 마지막 라운드라는 이유로 검토 기준을 낮추지 않습니다. 한도를 소진하면 실패 이유를 남깁니다.

## 결정 3: 소스 변경은 같은 작업 공간에서 직렬화한다

`architecture`와 `design`처럼 의존성이 없는 읽기 작업은 동시에 진행할 수 있습니다. 소스를 바꾸는 작업은 같은 실행의 다른 작업이 끝난 뒤 단독으로 배정합니다. 검토 도중 다른 작업이 소스를 바꾸는 상황도 피합니다.

같은 플러그인의 여러 실행이 동일한 작업 공간을 선택한 경우, 다른 실행에 활성 배정이 있으면 새 실행의 배정을 보류합니다. 서로 다른 작업 공간의 실행은 독립적이므로 전체 동시 에이전트 수는 실행별 상한의 합보다 작아야 한다는 전역 보장은 없습니다.

기본 설정은 Orca에 등록된 로컬 Git 프로젝트에서 별도 작업 공간을 만드는 것입니다. 기존 작업 공간을 선택할 때는 다른 도구나 사용자가 같은 파일을 수정할 수 있음을 고려해야 합니다. 검토·제출 시의 소스 지문 확인이 이런 변경을 감지합니다.

단계별 모델·추론 강도는 현재 사용 중인 플러그인 API가 제공하지 않아 전달하지 않습니다. 공급자 선택 이후의 모델 설정은 Orca의 해당 에이전트 설정을 사용합니다.

## 결정 4: 실행 의도를 먼저 저장하고 중복 실행을 피한다

외부 작업은 아래 순서로 진행합니다.

1. 실행·단계·시도·역할에 고유한 `nonce`를 배정합니다.
2. 실행 의도와 완료 보고서 경로를 Orca storage에 먼저 저장합니다.
3. `agent.launch`를 **지시 없이** 호출합니다. 지시는 에이전트가 준비된 뒤 플러그인이 직접 입력합니다(아래 참고).
4. 반환된 터미널 ID를 저장합니다.
5. 상태 이벤트 또는 명시적인 새로고침에서 해당 완료 파일을 확인합니다.

실행 의도를 저장하지 못하면(2단계 실패) 실행하지 않습니다. 배정을 되돌리고(시도 횟수도 소모하지 않음) 저장이 다시 성공하면 스케줄러가 이어갑니다. 지시 입력 전 의도 저장(`promptRecovery`)도 같습니다.

응답이 끊겨 시작 여부가 불명확하면 `uncertain`으로 막습니다. 성공이나 실패를 추측해 다시 실행하지 않습니다. 사용자는 Orca의 해당 작업 공간에서 기존 에이전트를 확인한 뒤 명시적으로 재시도합니다.

워커 재시작 시에는 저장된 실행과 살아 있는 에이전트를 대조하고 **새 배정을 일시정지**합니다. 이미 실행 중인 에이전트를 자동 종료하지 않으며, 재개 버튼을 누르면 검증된 지점에서 다음 배정을 진행합니다.

### 일시정지, 재시도, 취소

| 동작 | 효과 |
|---|---|
| 일시정지 | 신규 배정을 멈춤. 이미 실행 중인 에이전트는 계속 진행 |
| 새로고침 | 기존 배정과 결과 파일을 대조. 완료를 만들어 내지 않음 |
| 재개 | 저장 상태를 대조한 뒤 다음 배정 허용 |
| 단계 재시도 | 실패·중단된 단계에 한정. 이전 배정의 불명확한 상태를 먼저 확인 |
| 취소 | 취소 의도를 먼저 저장하고 해당 실행이 소유한 활성 터미널의 종료를 요청 |
| 터미널 종료 실패 | 취소 자체와 별도로 `stopFailures`를 남김. `{closed:false}`도 실패로 처리 |

취소·완료한 실행에는 뒤늦게 도착한 완료 이벤트나 수동 새로고침으로 보고서를 다시 적용하지 않습니다. 이미 관측한 실패 outcome은 후속 이벤트에 outcome이 없다는 이유로 지우지 않으며, 배정 시작 전이나 마지막 관측보다 오래된 상태 이벤트는 적용하지 않습니다.

### 오래된 복구 요청 방지

`nodes.retry`와 `nodes.deliverPrompt`에는 `expectedNonce`를 함께 보낼 수 있습니다. 값은 **사용자가 직접 확인한 단계**의 `active.nonce` 또는 `pendingReceipt.nonce`입니다. 워커는 외부 동작 전에 현재 배정과 비교하고, 바뀌었다면 `stale_assignment`로 거부합니다. 오래된 화면의 확인이 새 배정의 종료·재시도·지시 전달에 사용되지 않도록 하기 위한 조건입니다.

기존 호출과의 호환을 위해 생략한 요청도 받지만, 패널의 복구 동작은 확인한 nonce를 전달합니다. 오류 후 현재 nonce만 다시 읽어 자동 재전송하지 말고, 현재 단계와 터미널을 사용자가 다시 확인해야 합니다.

단계 재시도는 `awaiting-report`를 포함한 이전 소유 터미널의 현재 활동 여부도 확인합니다. 활동 중이면 `stopPrevious:true`를 명시해야 하며, 호스트가 실제 종료를 확인하지 않으면 이전 배정을 대체하거나 새 작업을 시작하지 않습니다.

### 작업 지시 전달

Orca 1.4.260의 `agent.launch`에 `prompt`를 넘기면 호스트는 터미널을 만든 직후 같은 터미널에 두 번째 내부 요청(`reuseTerminal` + prompt)을 보내는데, 이 요청은 에이전트 프로세스가 감지되기 전에 `isTerminalRunningAgent` 검사에서 실패합니다(`agent_launch_terminal_not_running_agent`). 실패는 플러그인 로그에만 남고 호출은 성공으로 끝납니다. 이 컴퓨터에서는 Claude가 뜨는 데 약 2초가 걸려 항상 실패했습니다. 그래서 플러그인이 전달을 직접 맡습니다. 다른 경로로 두 번 입력되지 않도록 `prompt`는 `agent.launch`에 다시는 넘기지 않습니다.

1. `agent.launch({ workspaceId, agent })`로 시작하고 `job.selfDelivery`를 기록합니다.
2. 준비 신호를 기다립니다. 해당 터미널의 첫 `agent.status.changed`(대기 중 `done` 포함, `job.readyAt`)나 `agents.list`의 행 중 먼저 오는 것이 신호이며, 1초 간격으로 최대 60번 확인합니다. 고정 대기는 신호로 쓰지 않습니다. 입력 전의 `done`은 완료나 미전달이 아니고, 입력 전의 상태·결과는 배정에 기록하지 않습니다.
3. `sendJobPrompt`로 한 번 입력합니다. 이 함수는 수동 전달 복구 버튼과 같은 함수입니다. `workspace.open` → `terminal.focus`(`focused: true`) → 활성 문맥 반영 확인(최대 2.5초) → 검토는 소스 지문 재확인 → 긴 지시는 `brief.md`로 저장 → `job.promptRecovery = { state: 'sending' }`를 먼저 영구 저장 → `terminal.sendText({ terminalId, text, enter: true })` 순서입니다. Orca는 활성 작업 공간의 터미널에만 입력을 허용하므로 열기·포커스가 필요합니다. 따라서 단계마다 Orca 화면이 해당 터미널로 이동하며, 배정당 포커스는 한 번입니다.
4. 결과 처리
   - 수락되면 `sent`가 되고, 실행 기록에 "에이전트 터미널을 열고 작업 지시를 전달했습니다"가 남습니다.
   - 수락되지 않으면 `rejected`, 응답이 불명확하면 `uncertain`으로 막고, 둘 다 다시 보내지 않습니다.
   - 포커스 등 입력 전 단계에서 실패하면 아무것도 입력하지 않은 것이므로 일반 차단으로 두고, 수동 전달이나 재시도를 안내합니다.
5. 입력 후 45초 안에 `working`·`blocked` 상태나 턴 결과(`promptSeen`), 또는 보고서가 확인돼야 합니다. 확인되지 않으면 지시가 이미 들어갔을 수 있으므로 `uncertain`으로 막고 자동 재전송·재배정을 하지 않습니다.
6. 60초 안에 준비되지 않으면 아무것도 입력하지 않았으므로, 이 플러그인의 터미널을 닫고(`closed: true` 확인 필수) `releaseClaim`으로 시도 횟수를 환불한 뒤 다시 배정합니다. 단계당 2회(`MAX_PROMPT_DELIVERY_RETRIES`)를 넘으면 "준비되지 않아 지시를 입력하지 못했고 다시 시도해도 안전하다"는 사유로 막습니다. 닫히지 않으면 다시 배정하지 않습니다.
7. 워커 재시작
   - 저장된 `sending`은 `uncertain`이 됩니다.
   - 아직 입력하지 않은 배정은 실행을 재개하면 스케줄러가 준비 대기부터 다시 시작합니다.
   - 입력했지만 확인 전인 배정은 확인부터 다시 합니다.

### 상황에 맞는 ECC 안내

`src/ecc.mjs`의 `createEccAdvisor()`는 워커에서만 만듭니다(`createRuntime({ eccAdvisor })`). 테스트는 파일 읽기를 주입하고, 주입하지 않은 런타임은 ECC 안내를 넣지 않습니다.

- **카탈로그**: `loadEccCatalog`가 최신 버전 폴더(semver 비교)의 `agents/*.md`와 `skills/*/SKILL.md` 앞부분(4 KiB)을 읽습니다. YAML 머리말에서 `name`과 `description`만 씁니다. 이름은 `^[a-z][a-z0-9-]{1,63}$`인 것만 남기고, 설명은 제어 문자와 줄바꿈을 지운 160자 한 줄로 만듭니다. 상한은 에이전트 200개, 스킬 600개이며 10분간 캐시합니다. 실패하면 예외 대신 `error`가 든 빈 목록을 돌려줍니다.
- **스택**: `detectStack`이 작업 공간 루트의 표식 파일을 보고, 없으면 목표 문장의 첫 단서를 씁니다.
- **상황**: `situationOf`가 단계, 작업·검토, 회차, `feedback`·실패 보고서의 요약과 실패 명령에서 검토·빌드·테스트 실패를 판정합니다.
- **선택**: `selectEcc`는 결정적입니다. 사용자가 지정한 에이전트, 수정 상황의 실패 전문가(빌드 실패 → 스택의 빌드 해결, 검토 실패 → `silent-failure-hunter`, 테스트 실패 → `tdd-guide`), 단계·스택 규칙 순서로 담고, 카탈로그에 있는 이름만 에이전트 4개·스킬 5개까지 남깁니다. 검토 단계는 코드 단계면 스택 리뷰어와 `silent-failure-hunter`를, 문서 단계면 단계별 검토자를 씁니다.
- **기록**: 시작할 때 결과를 `job.ecc`와 `node.eccShortlist`에 저장합니다. 지시 생성(`buildNodePrompt`)은 이 저장값만 읽으며, Claude 단계에만 넣습니다. `node.eccAgent`는 없으면 자동, `'none'`이면 끔, `ecc:` 이름이면 지정입니다. 이전 버전이 자동으로 채운 단계별 고정값(`LEGACY_ECC_DEFAULTS`)과 `null`은 자동으로 읽습니다.

### 턴 결과와 오류로 끝난 턴 이어가기

- `job.agentOutcome`은 에이전트의 **마지막 턴** 결과입니다. `working`은 새 턴을 시작하며 결과를 지웁니다. 다음에 끝난 턴의 결과가 이전 결과를 대신하고, 결과 없는 상태 보고는 마지막 결과를 유지합니다. 실패를 기록하면 그 시각(`failedAt`)도 남깁니다.
- 마지막 턴이 `failure`·`cancellation`·`interruption`이어도 성공 보고서 파일이 그 턴이 끝난 뒤(`failedAt` + 1초 이후 mtime)에 쓰였다면 이후 턴의 보고서로 보고 받습니다. 시각을 알 수 없으면 거부합니다. 이 변경 전에 저장된 기록에는 `failedAt`이 없고, 이전 코드가 첫 실패를 계속 유지했기 때문에 실패가 마지막 턴을 뜻한다고 볼 수 없습니다. 그래서 새로고침·재시작 때 에이전트가 작업 중이 아니면 보고서 자체로 판단합니다.
- 지시를 받은(`promptSeen`, 전달 기록 `sent`) 에이전트의 턴이 `failure`로 끝났고 보고서가 없으면 바로 막지 않습니다. 15초, 60초, 180초 뒤 같은 터미널에 "이전 턴이 오류로 중단됐습니다…" 한 줄을 `sendJobPrompt({ continuation: true })`로 보냅니다(최대 3번). 이것은 이미 전달된 배정을 이어 달라는 요청이므로 한 번만 보내는 `promptRecovery`와 별도 기록(`job.continuation`, `job.continuations`)을 씁니다. 실패하지 않고 끝난 턴이 나오면 횟수를 초기화합니다.
- 일시정지, 보고서 있음, 에이전트 작업 중, 전달 결과 불명확, 터미널 없음일 때는 보내지 않습니다. 한도를 넘으면 "턴이 오류(failure)로 N번 끝났습니다"라는 원인으로 막습니다.
- 워커가 재시작될 때는 확인 작업(reconcile)을 먼저 하고 실행을 일시정지합니다. 확인 중 결과를 받아 다시 실행할 수 있게 된 실행도 사용자가 재개하기 전에는 새 단계를 배정하지 않습니다.
- `evidence`의 note는 `{"kind":"note","text":…}`입니다. `note` 필드로 쓴 경우도 `text`로 받아 저장합니다.

### 단계별 모델과 시각 스킬 (`src/visual.mjs`)

- **모델 지정 경로**: 호스트 `agent.launch`는 `{ workspaceId, agent, prompt? }`만 받고, 내부 실행 요청에는 `agent`, 대상, `presentation`, `launchSource`만 넘깁니다(Orca 1.4.268 app.asar의 `"agent.launch":H7(...)`). 그래서 모델을 넘길 수 없습니다.
- **hook 경로**: Orca는 플러그인 실행을 포함해 명령이 있는 모든 에이전트 시작에서 `agent.launch.before`를 호출합니다(같은 파일의 `ZNn`, 세션 복원 제외). 반환한 `command`로 실행 명령을 바꾸므로, Orca가 관리하는 실행 환경·계정 선택·상태 보고는 그대로입니다.
- **적용 방식**: 런타임은 `agent.launch` 직전에 `launchOverrides.expect({ workspaceId, agent, settings })`를 등록합니다. 훅 이벤트의 `workspaceId`는 Orca 내부 worktree id(`<repo-id>::<경로>`)이고 플러그인 id(`identity:wt2:…`)와 다르므로, 정확히 같은 id, identity 키, 또는 `::<작업 공간 경로>` 접미사로 같은 작업 공간인지 판단합니다. 훅은 10초 안에 오는 같은 작업 공간·에이전트의 실행 하나에만, 에이전트 실행 파일 바로 뒤에 `-m`/`-c model_reasoning_effort=`(Claude는 `--model`/`--effort`)를 넣습니다. 명령이 이미 모델을 지정하거나 실행 파일을 하나로 찾지 못하면 바꾸지 않습니다.
- **기록**: 결과는 `job.launchSettings`와 `node.launchSettings`(`applied`, `reason`)와 실행 기록에 남습니다. 훅이 불릴 때마다 플러그인 로그에 `Toris Neon agent.launch.before: agent=… workspace=… → 적용: …` 또는 `일치하는 대기 실행 없음` 한 줄을 남깁니다. 작업 공간이 달라 적용하지 못하면 훅이 본 id를 이유에 적습니다. 훅은 `orca-plugin.json`의 `contributes.hooks`에 있어야 동작합니다.
- **기본값**: design·assets 작업이 Codex면 `gpt-6.2-sol`·`high`입니다. 단계의 `model`(`^[a-z0-9][a-z0-9._-]{1,63}$`)과 `effort`(low, medium, high, xhigh, max, ultra)가 이를 대신합니다. 필드가 없는 기존 실행은 아직 시작하지 않은 단계부터 기본값을 씁니다.
- **스킬 안내**: 에이전트별 스킬 폴더의 `SKILL.md` 머리말을 읽고, 픽셀 아트 판단(목표·보고서·프로젝트)과 단계 규칙으로 최대 6개를 골라 `job.visual`과 `node.visualShortlist`에 기록합니다. 지시에는 참고 자료로만 넣습니다. Codex에는 내장 `image_gen`도 후보로 넣습니다(`codex features list`: image_generation stable).

### 자율 진행 (`src/autonomy.mjs`)

`run.autonomous`가 true면(새 실행 기본값, `runs.setAutonomous`로 변경) 스케줄러가 배정 전에 `createSupervisor().supervise()`를 실행합니다. `planAutonomy`는 저장된 상태만 보는 순수 함수이며, 적용은 런타임의 `retryStage`(사용자 재시도와 같은 코드), `approveNode`, 알림으로 합니다.

| 멈추던 곳 | 자율 진행에서 |
|---|---|
| 워커 재시작 후 일시정지 | 확인(reconcile) 뒤 이어감. 활성 작업은 재실행하지 않음 |
| 시도 한도 도달(failed), 검토 실패 | 실패 이유를 `lastFailure`/`feedback`으로 지시에 넣고 새로 시도(시도 수 여유 확보) |
| QA 수정 루프 한도 | 테스트 재시도와 `maxRepairLoops` +1(실행당 3) |
| 보고서 없음·잘못된 보고서, 오류 턴 한도, 준비 안 된 에이전트 한도 | 새로 시도 |
| 보고서 없이 끝난 정상 턴(질문) | `DECIDE_PROMPT`를 같은 터미널에 최대 2번, 그 뒤 새로 시도 |
| 내부 승인(internal·release 준비) | 선행 검토 통과를 근거로 자동 승인, 제출 대상(`submission`)은 넣지 않음 |
| 전달 결과 불명확·거부, 확인 안 된 턴 | 멈춤과 알림(다시 보내면 중복될 수 있음) |
| 에이전트가 `blocked`로 보고(키·권한) | 멈춤과 알림 |
| 권한·로그인 확인 화면(Orca 상태 `blocked`) | 작업마다 알림 한 번 |
| 외부 제출(Play 계정·대상 지정) | 항상 사람: `runs.approve`의 `submission`과 소스 지문 검증 유지 |
| 작업 공간 생성 실패 | 그대로 멈춤(원인 메시지) |
| 한도 도달 | 시도한 것 요약과 함께 멈춤, 알림 |
| 실행 완료 | 알림 한 번(남은 제출 안내) |

- **한도**(`AUTONOMY_LIMITS`): 단계당 3번, 실행당 12번, 같은 에이전트 2번 실패 시 교체, 작업당 결정 요청 2번, 추가 수정 루프 3번입니다.
- **기록**: 카운터와 시도 내역, 알림 키는 `run.autonomy`에 남습니다. 지시 맨 앞에는 "사람이 없습니다" 안내가 들어갑니다.

### 명령 증거와 실패 기록

통과 보고서에서 실패한 명령은 결과의 근거가 될 수 없습니다. `role: "history"`(고쳐서 다시 실행한 이전 시도)로 남기거나, role이 없으면 같은 보고서에 성공한 명령이 있을 때만 history로 봅니다. `role: "check"`인 명령이 실패했거나 명령이 모두 실패한 통과 보고서는 거부합니다. exitCode는 숫자나 숫자 문자열을 받아 숫자로 비교합니다.

### 첫 지시 전달 복구 (수동)

자동 입력이 입력 전 단계(포커스 등)에서 멈춘 경우 명시적인 `nodes.deliverPrompt` 복구를 제공합니다. 같은 `sendJobPrompt`를 사용하며, 세션 ID는 근거로 쓰지 않습니다. 대기 중인 Claude도 세션 ID를 보고하기 때문이며, 대신 시작된 턴(`promptSeen`)이 있으면 거부합니다. 사용자는 먼저 기존 터미널을 열어 **입력이 비어 있고 작업을 시작하지 않았음**을 확인하고 패널 확인란을 선택해야 합니다.

```js
await window.orca.plugin.request("nodes.deliverPrompt", {
  runId,
  nodeId,
  expectedNonce: confirmedNode.pendingReceipt.nonce,
  acknowledgeUnsent: true
});
```

예시의 `confirmedNode`는 사용자가 빈 터미널과 함께 확인한 상세 응답의 단계입니다. 요청을 보내기 직전에 새 배정의 nonce로 자동 교체하지 않습니다.

복구는 차단된 단계에 `pendingReceipt`가 있고, 이 실행이 소유한 기존 터미널을 확인할 수 있으며, 배정 상태가 `awaiting-report`일 때만 가능합니다. 시작된 턴(`promptSeen`)이나 이전 전달 기록, 완료 보고 파일이 없어야 하고, 현재 터미널의 에이전트가 배정된 공급자와 일치하며 `done` 또는 `waiting` 상태인지 확인합니다. 검토 배정은 저장된 검토 소스 지문이 현재 소스와 일치해야 합니다.

Orca의 `terminal.sendText`는 활성 작업 공간에서만 허용되므로, 먼저 `workspace.open`과 공식 `terminal.focus`로 이 실행이 소유한 터미널을 열고 `focused === true`를 확인합니다. 포커스가 실패하면 지시를 보내거나 한 번의 전달 의도를 기록하지 않습니다. 네이티브 포커스 확인 뒤에는 해당 작업 공간과 터미널이 현재 문맥에 반영됐는지도 제한 시간 안에 확인합니다.

포커스 확인 후 전달 전에 `job.promptRecovery`에 의도를 저장해 같은 `nonce`에서는 한 번만 시도합니다. 기존 시도 번호와 `nonce`를 유지하며 새 에이전트를 생성하지 않습니다. 응답이 불명확하면 자동 재전송을 막습니다. 이 복구는 기존 일시정지를 해제하지 않으므로 실행 재개는 사용자가 별도로 선택합니다.

### 작업 공간 복구와 실행 보관

Orca는 실패한 `workspace.create`의 실제 원인(예: `Could not resolve a default base ref`)을 플러그인에 전달하지 않고 `action_failed` / `Orca could not complete this action`으로 바꿉니다. 그래서 생성 전에 로컬 저장소를 직접 확인해 커밋이 없거나 지정한 기준 브랜치가 없으면 한국어 원인과 해결 방법을 표시하고 생성을 요청하지 않습니다(실행은 `ready` 그대로).

생성이 실패하면 예약한 이름(`neon-…`)의 작업 공간을 조회합니다. 없고 오류가 `timeout`·`cancelled`가 아니면 확실한 실패로 보고 `workspaceCreation.state=failed`로 기록하며 같은 시작 버튼으로 다시 만듭니다. 그 외에는 `uncertain`입니다. 다음 시작에서 예약 이름의 공간이 하나도 없으면 다시 만들고, 하나 이상 있으면(원격 하나 또는 여러 개) 중복 생성하지 않고 `conflict`로 멈춥니다. 하나의 로컬 공간이면 그대로 복구합니다. 사용자가 Orca에서 생성된 공간을 확인했다면 `runs.attachWorkspace({runId, workspaceId})`로 연결할 수 있으며, **예약 이름이 같고 프로젝트 원본 체크아웃이 아닌** 공간만 허용합니다.

이 복구는 생성 결과가 불명확하고, 아직 작업 공간이나 배정 작업이 연결되지 않은 실행에만 적용합니다. 선택한 공간이 같은 프로젝트의 절대 경로를 가진 로컬 작업 공간인지 확인합니다. 성공하면 `recovery="user-attachment"`를 기록하고 실행을 일시정지하며 `started=false`로 둡니다. 연결만으로 에이전트가 실행되지는 않습니다.

`runs.archive({runId})`는 완료·취소한 실행 중 활성 배정과 터미널 종료 오류가 없는 실행을 보관합니다. 보관 실행에는 날짜, 단계 상태, 결과 영수증 경로, 작업·검토 요약, 최근 이벤트 10개가 남고, 근거와 이력 원문은 결과 폴더에만 남습니다. 활성 실행은 최대 40개입니다. 보관은 최대 100개이며 합계 1 MiB(저장 파일 기준)를 넘으면 가장 오래된 보관부터 정리합니다. 결과 파일은 삭제하지 않고, Today의 날짜별 이력에도 보관된 실행을 포함합니다.

## 결과 보고서와 검증 경계

에이전트에게 배정할 때 정확한 경로와 JSON 예시를 제공합니다. 다음은 형태를 설명하기 위한 예시이며, 실제 식별자는 배정된 값을 사용해야 합니다.

```json
{
  "runId": "assigned-run-id",
  "nodeId": "test",
  "nonce": "assigned-nonce",
  "attempt": 1,
  "phase": "work",
  "outcome": "passed",
  "summary": "실제로 수행한 검증과 확인한 결과",
  "evidence": [
    {
      "kind": "command",
      "command": "실제로 실행한 테스트 명령",
      "exitCode": 0
    },
    {
      "kind": "artifact",
      "path": "verification.md"
    }
  ],
  "next": "다음 단계에 전달할 구체적인 행동"
}
```

워커가 확인하는 사항:

- `runId`, `nodeId`, `nonce`, `phase`, `attempt`가 현재 배정과 일치하는지.
- 보고서가 크기 제한 안의 일반 JSON 파일인지.
- 통과 결과에 요약과 비어 있지 않은 근거가 있는지.
- `artifact`가 해당 배정 결과 디렉터리 안에 있는 실제 비어 있지 않은 일반 파일인지.
- 완료 JSON 자체를 검증 자료로 돌려 쓰거나, 심볼릭 링크로 결과 디렉터리 밖을 가리키지 않는지.
- 실패한 명령의 종료 코드를 통과 근거로 제시하지 않았는지.
- 검토 보고서의 `sourceFingerprint`가 배정 시점과 현재 소스에 일치하는지.
- 실패·취소·중단 이벤트와 통과 보고서가 모순되지 않는지.

보고서 한도는 256 KiB, 개별 검증 산출물은 256 MiB입니다. 검증한 산출물에는 크기와 SHA-256을 기록합니다.

이 검사는 보고서의 식별자·파일 존재·소스 버전·결과 일관성을 확인합니다. 모든 명령을 플러그인이 독립적으로 다시 실행하거나 에이전트가 적은 설명을 수학적으로 증명하는 것은 아닙니다. 실제 요구사항 검증은 별도 검토 세션과 실행 로그가 함께 담당합니다.

### 소스 지문

실행 검토에는 Git HEAD, 실제 binary diff, 미추적 일반 파일의 내용을 반영한 SHA-256 지문을 사용합니다. 동일한 줄 수를 유지한 수정도 감지합니다.

검증 범위를 안전하게 확정할 수 없는 저장소는 통과시키지 않습니다. 예를 들어 초기 커밋이 없거나, 지원하지 않는 심볼릭 링크·서브모듈이 있거나, `assume-unchanged`·`skip-worktree`가 변경을 숨기거나, 미추적 파일이 5,000개 또는 합계 128 MiB 한도를 넘으면 검증 기준을 만들 수 없습니다. 추적된 일반 파일을 아직 커밋하지 않은 심볼릭 링크로 바꾼 경우도 검사합니다. 빌드 출력은 적절히 `.gitignore`에 넣고 실제 소스·에셋은 프로젝트 정책에 맞게 추적하세요.

이 지문은 Git이 보는 소스 범위에 대한 것입니다. 무시된 빌드 출력이나 외부 서비스의 상태까지 보증하지 않습니다.

## 실제 제출 승인

내부 테스트와 출시 노드는 항상 승인 게이트를 갖습니다. 일반 승인에는 준비·검토만 허용합니다.

```js
await window.orca.plugin.request("runs.approve", {
  runId,
  nodeId: "internal",
  note: "내부 테스트용 빌드와 설치 안내를 준비하도록 승인"
});
```

실제 제출을 포함하려면 다음 대상 객체를 함께 전달합니다.

```js
await window.orca.plugin.request("runs.approve", {
  runId,
  nodeId: "internal",
  note: "현재 검증된 com.example.app의 versionCode 42를 internal에 제출하도록 승인",
  submission: {
    accountId,
    developerId: "1000000000000000000",
    packageName: "com.example.app",
    track: "internal",
    versionCode: "42"
  }
});
```

- `internal` 단계는 `internal` 트랙만, `release` 단계는 `production` 트랙만 허용합니다.
- `play.submissionAccounts`의 저장된 계정 ID와 Play 개발자 계정 ID를 전달합니다. 계정 설정에서 지정한 패키지만 승인할 수 있습니다.
- 정확한 Android 패키지명과 양의 versionCode, 최소 10자 승인 메모가 필요합니다.
- 승인 당시 소스 지문을 저장합니다. 작업자 배정 또는 빈 터미널에 지시를 복구하기 전에 계정 설정, 대상 트랙의 Play GET 응답과 소스 지문을 다시 확인합니다.
- 소스가 달라졌으면 작업자를 시작하지 않고 재검증과 새 제출 승인이 필요하다고 표시합니다.
- 작업자는 Play Console의 개발자 계정과 패키지를 대조하고, 저장소의 도구·아티팩트·출시 권한을 확인한 뒤 제출합니다. 확인한 개발자 계정 ID와 트랙·버전 코드·심사 상태를 결과에 기록합니다.
- 응답이 불명확하면 같은 제출을 자동 반복하지 않습니다.

실제 게시 동작은 에이전트와 저장소의 기존 도구가 수행합니다. Play Check용 키를 출시 작업자에게 넘기거나 새 키를 생성하지 않습니다. 플러그인에 별도 업로드 SDK를 내장하지 않았습니다. “그래프 완료”와 “Play 심사 승인/게시 완료”는 서로 다른 사실이므로 실제 Play 상태는 별도로 조회해야 합니다.

## 저장 위치

| 데이터 | 위치 |
|---|---|
| 실행·보관 실행·노드·배정·이벤트 | Orca plugin storage `toris-neon.runtime.v1` |
| Play 계정 메타데이터 | Orca plugin storage `toris-neon.play.accounts.v1` |
| Play 관측 캐시 | `toris-neon.play.cache.v1.<accountId>` |
| Play 개인키 | Orca secrets `play.service-account.<accountId>`, OS 키링 보호 필요 |
| 인계 메모·이어하기 시작 기록 | Orca plugin storage `neon.today.v1` |
| 결과 JSON·검증 파일 | `~/.toris-neon/runs/<run>/<node>/<attempt-phase-nonce>/` |
| 기존 개발 일지 | 기본 `~/projects/toris-docs/journal/dev/<project>/YYYY-MM-DD.md`, 읽기 전용 |

실행 상태와 인계 메모는 소스 저장소에 넣지 않습니다. 호스트 간 자동 동기화는 제공하지 않습니다. 화면용 summary와 페이지 크기는 보존 한도가 아닙니다. 인계·이어하기 영수증은 개수만으로 잘라내지 않으며, 실행 보관 한도를 넘으면 기존 이력을 삭제하는 대신 요청을 거부합니다. 저장 실패를 저장 성공으로 표시하지 않습니다. 읽을 수 없거나 제한 때문에 생략한 미리보기는 경고로 알립니다.

## 패널 요청 API

최종 계약은 [worker.mjs](../src/worker.mjs)의 등록 목록과 각 모듈의 구현을 기준으로 합니다. 아래 요청은 플러그인 패널 RPC이며 공개 웹 API가 아닙니다.

| 요청 | 주요 입력 | 결과·동작 |
|---|---|---|
| `state.get` | view?: summary/full/timeline, forceHost? | 선택한 실행 응답 범위 + 프로젝트·작업 공간·에이전트·경고. 기본 full |
| `runs.get` | runId | 활성·보관 실행 하나의 전체 상세 |
| `runs.create` | goal, projectId, template?(new-app/improve/diagnose), kind?, options?, playLink?, fromDiagnosis?, parentRunId?, requestId?, instructions/description(단계별), assignments, 제한 설정 | 실행 계획 저장. 같은 requestId·같은 진단 후보는 기존 실행을 돌려줌. 아직 실행하지 않음 |
| `artifacts.read` | runId, path | 보고서에 기록된 결과 파일 하나: 이미지·짧은 영상은 base64, 로그는 앞부분. 상태 푸시에는 넣지 않음 |
| `runs.start` | runId | 작업 공간 확보 후 배정 시작 |
| `runs.pause` / `runs.resume` | runId | 새 배정 정지 / 검증 후 재개 |
| `runs.refresh` | runId | 기존 터미널·완료 파일 대조 |
| `runs.approve` | runId, nodeId, note, submission? | 준비 또는 특정 대상 제출 승인 |
| `runs.updateAssignments` | runId, assignments | 변경 가능한 단계의 작업자·검토자 교체 |
| `nodes.retry` | runId, nodeId, expectedNonce?, acknowledgeUncertain?, stopPrevious? | 현재 배정 확인 후 명시적 재시도 |
| `nodes.deliverPrompt` | runId, nodeId, expectedNonce?, acknowledgeUnsent: true | 확인한 배정의 빈 기존 터미널에 같은 지시를 한 번 전달 |
| `runs.cancel` | runId | 취소 및 소유한 터미널 종료 요청 |
| `runs.attachWorkspace` | runId, workspaceId | 생성 결과가 불명확한 실행에 검증한 기존 공간 연결. 일시정지 유지 |
| `runs.archive` | runId | 완료·취소 실행을 이력·결과 참조를 유지하며 보관 |
| `terminals.focus` | terminalId | 이 플러그인이 배정한 터미널 열기 |
| `workspace.open` | workspaceId | 검증한 로컬 작업 공간 열기 |
| `play.list` / `play.check` | 없음 / accountId, force? | 보호 상태·캐시 / 읽기 전용 조회 |
| `play.submissionAccounts` | 없음 | 제출 대상으로 설정된 개발자 계정의 ID와 이름 |
| `play.account.save` | name, credential input, developerId?, packages?, tracks?, id? | 보호된 계정 저장·수정 |
| `play.account.remove` | accountId | 계정 및 보호된 키 제거 |
| `today.snapshot` | date?, workspaceId?, noteOffset?, noteLimit? | 날짜별 기록·인계 페이지·notesPage·기존 세션·경고 |
| `today.save` | workspaceId, state, next, why?, hold?, verified? | 인계 메모 추가 |
| `today.resume` | workspaceId, agent?, sessionId? | 새 인계 세션 또는 확인된 기존 세션 시작 |

## 권한과 신뢰

Manifest는 `trusted-worker`를 선언합니다. Node 워커는 사용자 권한으로 파일·네트워크에 접근할 수 있으며, Orca capability가 Node 자체의 접근을 격리하지는 않습니다. 설치 시 Orca가 반환하는 코드·권한 지문을 확인해야 하는 이유입니다.

구현은 Orca 호스트 API로 작업 공간·에이전트·터미널을 제어하고, 실행 완료 파일 경계·키링 보호·고정 Google 인증 URL·GET 전용 출시 조회 등을 별도로 확인합니다. 이런 검사는 잘못된 상태나 자격 증명 유출 가능성을 줄이지만, 임의의 제3자 코드를 안전하게 만드는 샌드박스는 아닙니다.

## 검증 전략

순수 엔진 테스트는 DAG·카운터·승인·오래된 결과·반복 보고를 다룹니다. 런타임 테스트는 모의 Orca 호스트와 임시 Git 저장소·검증 파일로 배정 순서, 오래된 이벤트·복구 요청, 종료 확인, 중복 실행 방지, 소스 변경 감지와 조회 응답의 원본 보존을 확인합니다. Play 테스트는 실제 RSA 서명과 주입된 HTTP 응답을 사용합니다. Today 테스트는 한국 시간 날짜 경계, 같은 크기의 내용 변경, 인계 페이지·저장 중 조회 경합·보관 범위·세션 재개를 확인합니다.

실제 모델이 완성한 앱, 실제 기기 테스트, Google 계정 권한, 실제 스토어 제출 성공은 이 테스트 묶음의 결과로 주장하지 않습니다.

## 저장 구조와 한도 (`src/store.mjs`)

Orca 1.4.268 플러그인 저장소의 한도(app.asar의 저장소 `set`):

| 한도 | 값 | 넘으면 |
|---|---|---|
| 값 하나 | 압축 JSON UTF-8 262,144바이트 | `value exceeds 262144 bytes`로 거부 |
| 키 개수 | 1,024개 | 새 키 거부 |
| 저장 파일 전체 | 들여쓰기 2칸으로 저장한 파일 5,242,880바이트 | 거부. 이보다 큰 파일은 빈 저장소로 읽힘 |

`set`마다 파일 전체를 다시 씁니다. 패널 메시지(`panels.post`)도 256 KiB까지입니다.

이전 버전은 모든 실행을 `toris-neon.runtime.v1` 값 하나에 저장했습니다. 실행이 진행될수록 커져서 한도를 넘으면 그 뒤의 모든 저장이 실패했고, 이벤트 처리도 함께 멈췄습니다. 지금은 아래처럼 저장합니다.

- `toris-neon.runtime.v2`: 색인 `{version: 2, revision, runs: [id…], archived: [id…]}`. 실행이 생기거나 보관될 때만 씁니다.
- `toris-neon.run.<id>`, `toris-neon.archive.<id>`: `{version: 2, revision, run}`. 바뀐 실행만 씁니다. 순서는 실행 값 → 색인 → 색인에서 빠진 값 삭제이므로, 중간에 멈춰도 색인이 없는 값을 가리키지 않습니다. 색인에 없는 실행 값은 읽을 때 복구합니다.
- 압축은 저장되는 사본에만 적용합니다. 메모리의 실행은 바꾸지 않습니다. 실행 하나는 저장 파일 기준 예산 안에 들어가는 가장 얕은 단계로 저장합니다. 예산은 최대 200 KiB이며, 런타임 전체 3.5 MiB에서 보관분을 빼고 실행 수로 나눈 값(최소 48 KiB)입니다.

| 단계 | 이벤트 | 단계 이력 | 끝난 배정 | 보고서 요약 / 근거 |
|---|---|---|---|---|
| 0 | 최근 150개 | 최근 12개, 근거 없이 개수만 | 최근 40개, 식별 정보만 | 4,000자 / 32개 × 1,500자 |
| 1 | 60개 | 4개 | 12개 | 1,500자 / 12개 × 400자 |
| 2 | 20개 | 마지막 1개 | 없음 | 300자 / 개수만 |
| 보관 | 10개 | 없음 | 없음 | 작업·검토 160자 |

모든 단계에서 유지하는 것: 목표(실행당 한 번), 단계 상태·시도 횟수, 현재 배정(진행 중인 작업과 그 지시에 필요한 ECC·시각 스킬 목록 포함), `acceptedReports`(nonce 중복 방지), 결과 영수증 경로. 끝난 배정에서는 ECC·시각 스킬 목록 사본, 결과 폴더 경로(영수증 경로에서 계산됨), 실행·작업 공간 ID를 뺍니다.

크기 예시:

| 실행 | 압축 JSON | 저장 파일 |
|---|---|---|
| 실제 실행 A(4단계 진행) | 원본 125,580바이트 → 0단계 96,175 | 118,789 |
| 11단계를 모두 마친 실행(실제 보고서 크기, 단계당 이력 6개, 이벤트 392개, 배정 48개) | 원본 463,635 → 1단계 130,709 | 166,604 |
| 최악(모든 입력 한도, 단계당 보고서 30개, 이벤트 2,000개) | 원본 약 780 MB → 2단계 171,510 | 201,288 |

이전: 시작할 때 v2 색인이 없고 v1 값이 있으면 실행별 값을 쓰고, 하나씩 다시 읽어 비교한 뒤 색인을 마지막에 씁니다. 그다음에야 v1을 삭제합니다. 중간에 실패하면 v1은 그대로이고 색인도 없으므로, 다음 시작에서 다시 이전합니다. 워커는 v1 내용으로 계속 동작합니다. v2와 v1이 함께 있으면 v2가 완전할 때만 v1을 지웁니다.

저장 실패: `persist()`는 기본적으로 예외를 던지지 않습니다. 실패하면 다음과 같이 처리합니다.

- 해당 실행에 `storageWarning`(저장하지 않음)을 붙입니다. 실행 카드에 경고로 표시하고, `state.get` warnings에도 넣습니다.
- 데스크톱 알림을 장애 한 번에 한 번 보냅니다.
- 5초, 30초, 2분, 5분 간격으로 다시 저장합니다.
- 이벤트 처리와 보고서 수신은 메모리 상태로 계속합니다.

실행 의도(배정·지시 입력)만은 저장되어야 진행합니다(결정 4).

### 활성 작업 주기 점검 (`src/watch.mjs`)

1분마다 지시가 전달된 현재 배정을 확인합니다. 활성 배정이 있는 실행마다 `agents.list`를 한 번 부르고, 배정마다 결과 파일과 그 수정 시각을 확인합니다. 점검이 겹쳐 실행되지는 않습니다.

| 상황 | 처리 |
|---|---|
| `agents.list` 상태가 저장된 상태와 다름 | 그 상태를 일반 상태 이벤트와 같은 처리기로 다시 적용 |
| 쉬는 에이전트(`done`·`waiting`)의 보고서가 아직 반영되지 않음 | 바로 받음 |
| Orca가 계속 `working`이라고 하지만 보고서가 3분 넘게 바뀌지 않음 | 받음. Orca가 턴 종료를 놓친 경우입니다(실행 A 에셋 검토: 09:38에 보고서를 쓰고 턴을 마쳤지만 1시간 넘게 `working`) |
| 보고서 없이 턴을 마친 지 3분 | 자율 진행이면 '스스로 결정' 요청(한도 내), 아니면 보고서 없음으로 막음 |
| `waiting`·`blocked`(입력·권한 확인 대기) 3분 | 단계 메시지와 알림 1회. 대신 입력하지 않습니다(실행 B 구조 설계: Bash 명령이 권한 확인을 59분 기다림) |

형식 때문에 거부된 보고서는 다시 쓰여야(수정 시각이 거부 시각보다 늦어야) 다시 받습니다.

재시작 직전에 입력했지만 아직 턴이 보이지 않은 배정은, 재시작 점검에서 막지 않고 원래의 45초 전달 확인이 판단합니다.

## 단계 예산과 검토 기준 (`src/proportion.mjs`)

`STAGE_BUDGETS`에 단계별 작업·검토 시간(분), 분량, '충분한 기준'을 한곳에 둡니다. 작업 지시에 예산과 기준이 들어가고, 배정에는 `job.budgetMinutes`가 기록되어 단계 카드에 경과 시간과 함께 표시됩니다.

| 단계 | 작업 | 검토 | 분량 |
|---|---|---|---|
| research | 15분 | 8분 | research.md 2~4쪽, 경쟁 앱 3~5개(목표가 요구하지 않으면 대량 수집 금지) |
| brief | 15분 | 8분 | brief.md 3~6쪽 |
| architecture | 20분 | 8분 | architecture.md 3~6쪽 |
| design | 25분 | 10분 | design.md와 핵심 화면 시안 |
| assets | 40분 | 12분 | MVP에 쓰는 에셋 |
| build | 120분 | 20분 | 작동하는 MVP와 핵심 테스트 |
| test | 40분 | 15분 | 빌드·자동 테스트·핵심 흐름 |
| policy / listing / release | 15분 | 8분 | 점검표·스토어 자료 |
| internal | 25분 | 10분 | 내부 테스트 빌드 |

문서 단계(research, brief, architecture, design, policy, listing, release)의 검토는 다음 단계가 잘못된 것을 만들게 하는 **차단 결함만** failed로 보고합니다. 나머지는 passed로 두고 `followUps` 배열(최대 12개)에 적습니다. 후속 과제는 단계의 검토 결과에 남아 패널에 표시되고, 그 단계에 의존하는 다음 단계의 작업 지시에 들어갑니다. assets, build, test, internal의 검토는 기준을 낮추지 않습니다.

쓰기 단계(assets, build 등)는 이제 읽기 전용 **작업**과 함께 실행됩니다. 다른 쓰기 단계나 검토(소스 지문을 고정함)와는 여전히 함께 실행하지 않습니다. 실행 B에서 assets는 이 규칙 때문에 architecture 작업이 끝나기를 57분 기다렸습니다.

## 형식이 거부된 보고서 (`src/reportfix.mjs`)

명령 증거는 `expectedExitCode`를 받습니다. 0이 아닌 종료 코드가 기대 결과인 확인(다름을 보이는 `diff`의 1, 파일이 없음을 보이는 `ls`의 2)은 그 값을 적으면 통과 근거가 됩니다. 거부 메시지에는 해당 항목(`evidence[i]`)과 명령, 고치는 방법이 들어갑니다.

보고서가 형식(근거 형태, 식별자, artifact 경로, JSON) 때문에 거부되고 작업 지시가 전달된 배정이면, 단계를 다시 하지 않습니다. 대신 같은 에이전트의 열린 터미널에 거부 이유와 함께 '보고서만 고쳐 같은 경로에 저장하라'는 한 줄을 보냅니다(배정당 최대 2번). 입력·권한 확인을 기다리는 에이전트에는 보내지 않습니다. 한도를 넘거나 보낼 수 없으면 이전처럼 막고, 자율 진행이 새 시도를 합니다. 소스 변경(검토 지문 불일치), 보고서 없음, 이전 배정의 결과는 형식 오류가 아니므로 이 경로를 타지 않습니다.

## 끝난 터미널 정리 (`src/cleanup.mjs`)

보고서가 받아들여졌거나 대체·취소·전달 실패로 끝난 작업의 터미널은, 2분의 유예 뒤 플러그인이 `terminal.close`로 닫습니다(1분마다 점검, 워커 시작 때 한 번 더). 아래 터미널은 닫지 않습니다.

- 단계의 현재 배정(`active`·`pendingReceipt`).
- 보고서나 보고서 수정을 기다리는 배정, 시작·전달 결과가 불명확한 배정(`launching`·`running`·`awaiting-report`·`uncertain`).
- 아직 살아 있는 배정과 같은 터미널.
- 플러그인이 열지 않은 터미널(Orca도 거부합니다).

닫기 전에 `terminal.list`와 `agents.list`로 확인합니다.
- 목록에 없으면 이미 닫힌 것으로 기록합니다. 목록이 잘렸으면 판단하지 않습니다.
- 에이전트가 `working`·`waiting`·`blocked`면 남기고 로그에 이유를 적습니다.
- 닫기에 실패하면 로그를 남기고 다음 점검에서 다시 시도합니다(최대 5번).

닫은 배정에는 `terminalClosed { at, sessionId }`가 남고, 실행 기록에 '세션 <id>로 다시 열 수 있습니다'가 표시됩니다. 실행 카드의 **끝난 터미널 자동 닫기**(`runs.setTerminalCleanup`)로 실행마다 끌 수 있습니다. 자율 진행 실행은 기본으로 켜져 있고, 그 외에는 꺼져 있습니다.

## 입력 전 거부와 불명확한 전달 (`src/delivery.mjs`)

Orca의 `terminal.sendText`는 활성 작업 공간 확인, 터미널 목록 작성, 플러그인 확인, `sendTerminal`, `sendTerminalAfterPluginHooks`를 차례로 거친 뒤에야 쓰기(`writeTerminalAction`)를 합니다. `SEND_ERRORS` 표에는 쓰기 전에만 나는 오류를 모아 두었습니다(Orca 1.4.269 코드로 확인).

- `terminal_surface_ownership_unavailable`: 실행 직후 아직 패널에 붙지 않은 PTY의 등록·생성이 진행 중일 때 목록을 만들다 발생합니다.
- `no active worktree is available for terminal input`, `terminal is outside the active worktree`.
- `terminal_not_writable`, `invalid_terminal_send`.
- 호출이 처리기에 닿기 전 거부(`rate_limited`, `capability_denied`, `consent_required`, `not_permitted`, `unknown_method`, `invalid_params`).

이 오류는 아무것도 입력되지 않은 것이므로 다음처럼 처리합니다.
- 재시도 가능한 오류는 2초, 5초 뒤 터미널을 다시 연 다음 같은 지시를 다시 보냅니다.
- 그래도 거부되면 전달 기록을 지우고, '전달되지 않은 지시'와 같은 경로로 처리합니다. 터미널을 닫고 기존 한도 안에서 다시 배정합니다.

시간 초과, 취소, 일반화된 오류, 표에 없는 오류는 쓰기 뒤에도 날 수 있으므로 `uncertain`으로 두고 자동으로 다시 보내지 않습니다.

## 흐름 템플릿과 기존 앱 디벨롭 (`src/engine.mjs`, `src/improve.mjs`, `src/catalog.mjs`, `src/approval.mjs`)

`runs.create`는 `template`으로 그래프를 고릅니다(`src/flows.mjs`). `new-app`(기본, `DEFAULT_GRAPH`), `improve`(개선 종류 하나), `diagnose`(진단만)가 있습니다. 패널은 템플릿 이름만 보내고 단계 목록은 보내지 않습니다. `nodes`는 `new-app`에서만 API 호환용으로 받습니다.

`improve`는 이미 출시한 앱을 개선합니다. 종류마다 짧은 그래프가 있고 build·test는 공유합니다.

| 종류 | 단계 (괄호는 선택) |
|---|---|
| bugfix 오류 수정 | identity → reproduce → build → test |
| feature 기능 추가 | identity → plan → (design → assets) → build → (monetization) → test → (catalog) |
| design 디자인 | identity → design → assets → build → test |
| performance 성능 | identity → measure → build → test |
| maintenance 유지보수 | identity → plan → build → test |
| release 출시 | identity → test → policy → listing → internal → release |

- identity(앱 정체성 확인)는 스택·패키지·빌드 대상·저장 데이터 여부를 `identity` 객체로 보고합니다. 이 보고는 이후 모든 지시에 들어가며 "다른 스택으로 다시 만들지 마세요"가 붙습니다. 저장 데이터를 다루면 "기존 사용자 데이터가 새 버전에서 열리는지"가 필수 검증 항목이 됩니다.
- diagnose(진단만)는 identity → diagnose이고, 근거 있는 후보 3~5개(problem·evidence·impact·scope·verify, kind)를 냅니다. 후보를 고르면 `fromDiagnosis`로 그 종류의 개선 실행이 만들어지고 `parentRunId`로 이어집니다. 같은 후보를 다시 고르면 같은 실행이 열립니다.
- "이 결과 더 개선하기"는 `parentRunId`가 있는 새 `improve` 실행을 만들고, 이전 결과 요약(바뀐 것·검증하지 못한 것)을 지시에 넣습니다. 같은 프로젝트에서만 가능하며 이전 실행은 바꾸지 않습니다.

입력 검증(`prepareImprovement`)은 개선 종류, 커밋이 있는 로컬 Git 프로젝트, 연결한 Play 패키지가 등록된 계정의 것인지(`play.appSnapshot`)를 확인합니다.

## 실행 한도, 커밋 확인, 결과 카드

- **배정 한도** (`src/scheduler.mjs`): 실행별 `maxConcurrency` 위에 Neon 전체 동시 작업 수(기본 2)와 무거운 단계(build·test·internal·monetization·reproduce·measure) 수(기본 1)를 둡니다. 플러그인 설정 `maxActiveJobs`·`maxHeavyJobs`로 바꿀 수 있고, 잘못된 값은 기본값으로 처리합니다. 실행은 차례로 배정받습니다. 대기 중인 단계는 실제 이유를 표시합니다(전체 작업 2개 실행 중, 빌드 작업 완료 대기, 실행별 한도, 선행 단계 대기, 승인 대기 등). 이 한도는 Neon이 배정하는 작업에만 적용됩니다.
- **커밋 확인** (`src/commitcheck.mjs`): 쓰기 단계의 통과 보고는 작업 트리가 깨끗하고(ignored 파일 제외) HEAD가 시작 때와 달라야 받습니다. 아니면 "이 실행 브랜치에 커밋" 보고서 수정 요청을 보냅니다. git을 읽지 못하면 받지 않습니다. 검토는 시작 시 커밋에 묶이며, 도중에 커밋이 바뀌면 통과하지 못합니다.
- **실패 분류**: 통과가 아닌 보고는 `failureClass`를 적습니다. `code`(코드 결함)는 구현으로 돌아갑니다. `check`(검증 부족)는 검증만 다시 합니다. 테스트를 다시 하거나 검토를 다시 하고, 빌드는 다시 하지 않습니다. `external`(외부 조건)은 확인 필요로 멈추고 자율 진행도 재시도하지 않습니다.
- **결과 카드** (`panel/result.mjs`): 단계와 실행마다 다음 순서로 보여 줍니다.
  1. 바뀐 것(`changes`)
  2. 완료 기준별 충족 여부(`criteria`)
  3. 실측 이전/이후(`beforeAfter`)와 결과 파일. 시안은 `mockup`, 실제 화면은 `screenshot`으로 구분합니다.
  4. 실제 실행한 검증 명령
  5. 검증하지 못한 것(`notVerified`)
  6. "이 결과 더 개선하기"

  결과 파일은 누를 때 `artifacts.read`로 하나씩 읽습니다. 요약 상태 푸시에는 이 필드들을 넣지 않습니다.
- **완료 단계**: 구현 결과 생성 → 검증 완료 → 출시 준비 완료 → 내부 테스트 제출 확인 → 프로덕션 게시 확인. 마지막 단계는 승인한 계정·패키지·트랙·versionCode가 Play 탭의 최신 관측에서 published일 때만 표시합니다. 이때 관측한 트랙·versionCode·상태·시각을 함께 보여 줍니다. 단계적 출시 비율은 확인하지 않는다고 적습니다.
- **일시 정지와 취소**: 일시 정지는 새 배정만 멈춥니다. 패널은 "새 배정 멈춤"으로 표시하고, 작업 중인 에이전트는 계속 작업한다고 알립니다. 취소는 세 상태로 표시합니다.
  - 취소 요청 처리 중
  - 취소 완료: Orca가 소유 터미널마다 `closed: true`를 돌려줌
  - 종료 확인 필요: `stopFailures`가 남아 있음

상품 등록은 기존 승인 게이트를 확장해 처리합니다(`src/approval.mjs`). `runs.approve`의 범위는 `submission`(내부 테스트·출시의 실제 제출 대상)이거나 `productCatalog`(catalog 단계)입니다. catalog 단계는 `productCatalog: { confirmed: [productId…] }`와 10자 이상의 메모 없이는 승인할 수 없습니다. 결제 연동 보고서(없으면 기획 보고서)가 제안한 상품을 모두 확인해야 합니다.

자율 진행은 이 단계를 승인하지 않습니다. 대신 한 번 알림을 보내고 멈춥니다. 알림에는 판매자 계정 확인, 상품 ID·유형·가격·기본 요금제, 광고를 골랐다면 AdMob 연결, 그리고 기다리는 단계가 적힙니다. 사람이 승인하면 멈춤 표시가 지워지고 내부 테스트 준비부터 이어갑니다. 플러그인은 Play Console이나 API로 상품을 만들거나 바꾸지 않고, 판매자 계정 활성화·AdMob 연결·업로드도 하지 않습니다.

ECC 규칙은 다음과 같습니다(설치된 이름만).
- identity: code-reviewer, silent-failure-hunter, 스택 검토자와 빌드 해결사. diagnose: code-reviewer, silent-failure-hunter, performance-optimizer, 스택 검토자, product-lens. reproduce: e2e-runner, 스택 검토자, tdd-guide. measure: performance-optimizer, 스택 검토자, benchmark-methodology.
- plan: planner.
- monetization: security-reviewer를 먼저 두고, 스택 검토자, 빌드 해결사, tdd-guide.
- Flutter 앱이면 flutter-reviewer·dart-build-resolver가 들어갑니다.

결제 스킬(play-billing-library-version-upgrade, paywalls, pricing)은 시작 시 설치 폴더에서 찾은 것만 지시에 넣습니다. 지금은 설치돼 있지 않으므로, 지시에는 공식 문서에서 버전을 확인하라고 적습니다.
