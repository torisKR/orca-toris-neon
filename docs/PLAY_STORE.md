# Play Store 점검

Play Store 화면은 계정이 접근할 수 있는 앱과 트랙의 **출시 수명 주기**를 읽습니다. “현재 심사 중인가”, “승인됐지만 아직 게시 전인가”, “어느 버전이 테스트 트랙에 있는가”를 한곳에서 확인하기 위한 기능입니다.

앱 목록은 거부, 심사 제출 전, 승인 후 게시 대기처럼 조치할 항목을 먼저 표시합니다. 조회 오류와 재확인 표시는 해당 앱의 마지막 관측 상태와 함께 남습니다. 선택한 계정 안에서 앱 이름·패키지명을 검색하고 상태를 필터링할 수 있습니다. 앱 행을 펼치면 트랙별 버전과 관측 시각이 표시됩니다.

구현: [src/play.mjs](../src/play.mjs) · 테스트: [tests/play.test.mjs](../tests/play.test.mjs)

## 계정 준비

1. Google Cloud 프로젝트에서 **Google Play Android Developer API**와 **Google Play Developer Reporting API**를 활성화합니다.
2. 서비스 계정을 준비하고 해당 계정에 필요한 Play Console 앱의 조회 권한을 부여합니다. 모든 앱을 볼 필요가 없다면 필요한 앱만 지정합니다.
3. 서비스 계정 JSON을 Play Store 계정 설정에 한 번 입력합니다. 또는 명시적으로 선택한 로컬 JSON 파일 경로를 사용할 수 있습니다.
4. 계정 이름, 조회할 패키지와 트랙을 설정한 뒤 저장합니다. Auto App 제출에도 사용할 계정은 Play Console 홈의 19자리 개발자 계정 ID와 그 계정의 패키지 목록을 입력합니다.
5. 계정을 선택해 점검을 실행합니다.

설정 절차와 권한의 공식 기준은 [Reporting API 시작하기](https://developers.google.com/play/developer/reporting/overview)를 참고하세요. 서비스 계정의 앱 접근 범위는 Play Console에서 관리합니다. OAuth scope가 있다는 것만으로 모든 앱을 볼 수 있는 것은 아닙니다.

### 저장되는 정보

| 데이터 | 저장 방식 |
|---|---|
| 계정 이름·플러그인 계정 ID·Play 개발자 계정 ID·선택한 패키지·트랙 | Orca plugin storage |
| 서비스 계정 이메일·RSA 개인키 | Orca 전용 secrets, `os-keyring` 보호 확인 후 저장 |
| OAuth access token | 프로세스 메모리, 만료 전까지만 재사용 |
| 조회 결과·원래 관측 시각·조회 오류 | 계정별 캐시 |
| 사용자가 고른 원본 JSON 파일 | 원래 위치에 유지. 경로는 일반 계정 메타데이터에 저장하지 않음 |

등록 전 `secrets.protection()`이 `os-keyring`인지 확인합니다. 지원되지 않거나 잠긴 키링 때문에 보호 여부를 확인할 수 없으면 평문 저장으로 대체하지 않습니다.

JSON은 `service_account` 타입, Google 서비스 계정 이메일, 유효한 RSA 개인키를 확인합니다. 일반 저장소와 패널 응답에는 이메일·키·토큰·선택한 파일 경로를 반환하지 않습니다. 네트워크 오류는 원본 응답 본문을 그대로 표시하지 않고 코드와 설명으로 정리합니다.

서비스 계정 파일의 `token_uri`는 사용하지 않습니다. 인증 엔드포인트와 JWT audience는 **`https://oauth2.googleapis.com/token`**으로 고정합니다. 자격 증명을 다른 호스트로 보내는 리다이렉트도 따르지 않습니다.

Play Check에 저장한 키는 Auto App의 실제 출시 작업자에게 전달하지 않습니다. 실제 제출은 그 앱 저장소에 이미 설정된 도구·권한을 별도로 사용합니다.

같은 서비스 계정이 여러 개발자 계정에 접근할 수 있으면 앱 자동 검색 결과가 합쳐집니다. 각 Play Console 홈에서 소유 패키지를 확인해 해당 연결에 넣으세요. 출시 대상 패키지가 아직 Play API에 등록되지 않았다면 Console에서 먼저 앱과 첫 번들을 준비합니다. 패키지와 트랙을 조회할 수 있게 되면 Auto App에서 그 대상으로 제출을 승인할 수 있습니다.

## 패키지와 트랙

### 패키지

- 목록이 **비어 있으면** Reporting API가 반환하는 접근 가능한 앱을 조회합니다.
- 목록을 **지정하면** 해당 패키지만 조회합니다. 자동 검색 결과에 없는 패키지도 직접 조회를 시도합니다. 허용 목록을 수정하면 저장된 캐시를 화면에 표시할 때도 새 범위를 바로 적용합니다.
- Reporting API 접근이 거부되더라도 명시한 패키지의 Publisher API 조회는 시도할 수 있습니다.
- 접근할 수 없거나 아직 API에 나타나지 않는 앱까지 발견했다고 가정하지 않습니다.

예시:

```json
["com.example.first", "com.example.second"]
```

### 트랙

기본값:

```json
["production", "beta", "alpha", "internal"]
```

직접 만든 비공개 테스트 트랙이나 폼팩터 트랙은 정확한 식별자를 추가합니다.

```json
["production", "internal", "closed-friends", "wear:production"]
```

기본 네 트랙을 조회했다고 모든 사용자 정의 트랙을 탐색한 것은 아닙니다. 한 계정당 패키지 최대 200개, 트랙 최대 20개를 허용합니다. 앱 검색은 최대 20페이지로 제한하고, 반복되는 페이지 토큰을 오류로 처리합니다.

## 사용하는 공식 API

| 목적 | 요청 | 공식 문서 |
|---|---|---|
| 접근 가능한 앱 목록 | `GET https://playdeveloperreporting.googleapis.com/v1beta1/apps:search` | [apps.search](https://developers.google.com/play/developer/reporting/reference/rest/v1beta1/apps/search) |
| 트랙의 출시 상태 | `GET https://androidpublisher.googleapis.com/androidpublisher/v3/applications/{packageName}/tracks/{track}/releases` | [applications.tracks.releases.list](https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases/list) |
| 상태·아티팩트 스키마 | `releaseLifecycleState`, `activeArtifacts` | [ReleaseSummary](https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases) |

사용 scope는 `androidpublisher`와 `playdeveloperreporting`입니다. scope 명칭 자체가 “GET만 가능”을 보장하지는 않습니다. **이 모듈의 코드가 출시 조회를 GET 요청으로 제한**합니다.

인증 토큰 교환 외에 POST를 보내지 않으며, edit 생성, 번들 업로드, 트랙 업데이트, 게시·승격을 호출하지 않습니다. 조회를 위해 임시 edit를 만드는 우회도 없습니다.

출시 API는 폐기된 출시를 제외하고 트랙당 최대 20개를 반환하므로 전체 과거 출시 이력을 복원하는 API로 사용하지 않습니다. 반환 범위는 위 공식 `releases.list` 문서를 기준으로 합니다.

## 상태 해석

아래 표는 Google enum의 공통 접두사 `RELEASE_LIFECYCLE_STATE_`를 생략한 이름입니다. 플러그인은 이를 소문자 상태값으로 정규화합니다.

| Google 상태 | 화면에서의 의미 |
|---|---|
| `DRAFT` | 아직 준비 중인 초안 |
| `NOT_SENT_FOR_REVIEW` | 심사 제출 전, 개발자의 조치 필요 |
| `IN_REVIEW` | 심사 중 |
| `APPROVED_NOT_PUBLISHED` | 심사 승인, 아직 게시 전 |
| `NOT_APPROVED` | 심사에서 승인되지 않음 |
| `PUBLISHED` | 해당 트랙 사용자에게 제공되는 출시 |
| 알 수 없는 값·조회 실패 | 미확인 또는 이전 관측값 |

`PUBLISHED`에는 일부 사용자에게 배포 중인 출시와 재개할 수 있는 중단된 출시도 포함됩니다. 따라서 “100% 배포 완료”로 해석하지 않습니다. 공식 설명은 [ReleaseLifecycleState](https://developers.google.com/android-publisher/api-ref/rest/v3/applications.tracks.releases#ReleaseLifecycleState)를 참고하세요.

앱 요약은 거부·심사 중·게시 전 승인·초안을 먼저 보여 주되, 기존 프로덕션 버전이 게시되어 있는지 `published`로 별도 유지합니다. 새 버전이 거부돼도 이전 버전은 계속 게시 중일 수 있기 때문입니다. 같은 트랙에서 더 높은 versionCode가 승인·게시된 경우 이전 거부가 현재 거부 상태로 남지 않도록 처리합니다.

앱의 이름은 Reporting API의 최신 표시 이름을 사용하므로 공개 스토어에 보이는 이름과 다를 수 있습니다. 제공되는 스토어 URL은 앱 페이지로 이동하기 위한 링크입니다. **공개 페이지의 실제 노출·지역별 접근 가능성까지 이 모듈이 검사한 것은 아닙니다.**

## 캐시·실패·호출 제한

성공한 점검은 기본 **1시간** 동안 재사용합니다. 계정의 마지막 성공 시각뿐 아니라 선택한 모든 트랙과 앱 검색 결과가 유효해야 캐시만으로 응답합니다. 유효 시간에 정확히 도달한 결과, 잘못된 시각, 미래로 기록된 관측 시각은 최신으로 취급하지 않습니다. “지금 확인”처럼 강제 조회를 선택하면 새로 요청합니다. 백그라운드 예약이나 무한 자동 새로고침은 없습니다.

각 트랙에는 다음 시각을 분리해 저장합니다.

| 필드 | 의미 |
|---|---|
| `observedAt` | 실제 데이터를 성공적으로 관측한 시각 |
| `attemptedAt` | 가장 최근에 확인을 시도한 시각 |
| `stale` | 이전 값이거나 캐시 유효 시간이 지난 상태 |
| `error` | 이번 조회가 실패한 이유 |

예를 들어 오전 10시에 production을 확인하고 오전 11시에 API 오류가 났다면, 오전 10시의 데이터와 `observedAt`을 유지하며 오래된 결과라고 표시합니다. 실패한 조회 시각을 새 관측 시각처럼 기록하지 않습니다.

계정의 `checkedAt`은 모든 대상 조회를 성공적으로 마친 시각입니다. 일부만 성공하면 계정 수준의 오류와 트랙별 결과를 함께 제공합니다. 계정 정보나 조회 범위를 수정해도 기존 결과를 새로 검증한 것으로 표시하지 않습니다.

키·계정 정보를 바꾸기 전에 기존 캐시를 무효화한 상태를 먼저 저장합니다. 계정 정보 저장에 실패하면 이전 키 복구를 시도하며, 복구 결과까지 불확실하면 비밀값을 제외한 `credential_update_uncertain` 오류로 알립니다. 키 변경이나 저장 실패를 성공한 조회로 취급하지 않습니다.

요청은 전체 서비스에서 최대 **3개**를 동시에 처리하고, 요청마다 기본 **15초** 제한을 둡니다. HTTP 429를 받으면 이전 결과를 보존하고 `Retry-After`를 존중합니다. 최소 60초의 대기 시간을 적용하고, 동시에 여러 제한 응답을 받으면 가장 긴 대기 시간을 유지합니다. 강제 조회나 계정 정보 저장으로 대기 시간을 초기화하지 않습니다. 자동 재시도는 없습니다.

HTTP 401로 토큰이 거부되면 해당 토큰을 메모리에서 제거하고 아직 보내지 않은 트랙 조회를 중단합니다. 이미 전송한 요청은 응답 처리를 마치며, 다음 명시적 점검에서 새 토큰을 발급합니다. 같은 거부된 토큰으로 남은 조회를 계속 보내지 않습니다.

## 오류별 확인

| 표시 | 확인할 내용 |
|---|---|
| `keyring_unavailable` | OS 키링 보호 지원·잠금 상태. 보호 저장소를 먼저 사용할 수 있게 만들기 |
| `invalid_credential` | 서비스 계정 JSON인지, RSA 개인키가 유효한지, 64 KB 이하인지 |
| `authentication` | 키가 폐기·만료됐는지, 올바른 서비스 계정인지. 401 이후 다음 명시적 점검은 새 토큰 사용 |
| `credential_update_uncertain` | 키 수정 중 이전 상태 복구도 확인하지 못함. 키링과 계정 연결 상태를 확인한 뒤 다시 설정 |
| `permission` / HTTP 403 | 두 Google API 활성화, Play Console 앱 접근 권한 |
| `not_found` / HTTP 404 | 패키지·트랙 식별자와 해당 계정의 접근 가능 여부 |
| `rate_limited` / HTTP 429 | 표시된 대기 후 다시 확인. 빠른 연속 조회 피하기 |
| `network` | 네트워크·프록시·시간 제한 확인 |
| `pagination` | 비정상 검색 페이지. 패키지를 직접 지정해 조회 범위 제한 |

키·토큰·Google 응답 원문을 이슈에 붙이지 마세요. 오류 코드, 어떤 종류의 요청이 실패했는지, 관측 시각 정도로 재현 정보를 남기면 됩니다.

## 서비스 계약

등록·수정:

```js
await window.orca.plugin.request("play.account.save", {
  name: "개인 앱",
  developerId: "1000000000000000000",
  serviceAccountJson: selectedJsonText,
  packages: ["com.example.app"],
  tracks: ["production", "internal"]
});
```

`serviceAccountJson` 대신 `credentialPath`를 사용할 수 있지만 둘을 함께 받지는 않습니다. 기존 계정을 수정할 때는 `id`를 전달하며, 키를 바꾸지 않는다면 credential 입력을 생략합니다.

조회·제거:

```js
await window.orca.plugin.request("play.list", {});
await window.orca.plugin.request("play.submissionAccounts", {});
await window.orca.plugin.request("play.check", { accountId, force: true });
await window.orca.plugin.request("play.account.remove", { accountId });
```

계정 제거는 플러그인에 등록된 계정·캐시와 보호된 키를 제거합니다. 사용자가 선택했던 원본 JSON 파일은 삭제하지 않습니다. 실행 중인 점검이 있으면 계정 수정·제거를 기다리도록 안내합니다.

검증된 반환 필드와 API는 [src/play.mjs](../src/play.mjs)를 기준으로 합니다. 이 기능은 설치 수, 매출, 별점·리뷰 수집 기능을 포함하지 않습니다.
