# Auto APP 대시보드 v1

앱·게임 개발과 운영을 한 화면에서 보는 **읽기 전용** 웹 대시보드입니다. Neon 실행과 Neon 밖 작업(Orca 오케스트레이션 작업 공간, git 브랜치)을 함께 보여 줍니다.
의존성은 없습니다. `node:http`와 정적 ES 모듈로 동작하고, Neon의 순수 함수(`src/views.mjs`·`play.mjs`·`playstatus.mjs`·`today.mjs`·`disk.mjs`·`artifacts.mjs`)와 패널 CSS·`panel/kit.mjs`를 그대로 가져다 씁니다.

## 페이지

| 경로 | 내용 |
|---|---|
| `#/` 개요 | 진행·막힌 실행, 확인 필요(막힘·승인 대기·에이전트 확인·Play 심사/거부), 일하는 에이전트, 토큰 오늘/7일, 데이터 신선도 |
| `#/apps` 앱 | Play 앱과 Orca 프로젝트의 합집합. 앱마다 스택, 마지막 Neon 실행과 단계 진행, 마지막 커밋(모든 브랜치), 작업 공간·에이전트·미커밋, Play 프로덕션 배지 |
| `#/runs`, `#/run/<id>` 실행 | 단계 그래프, 시도별 `result.json` 카드(수락 기준, 실패 분류, 스크린샷 썸네일과 경로 검사), 이벤트 |
| `#/ops` 운영 | 스케줄러 한도·대기 이유, 디스크, Neon 결과 폴더 크기, 작업 공간 전체 |
| `#/timeline` 타임라인 | 최근 14일의 Neon 이벤트, git 커밋, toris-docs 작업 일지를 날짜별로 묶음 |

## 데이터 (모두 읽기만 함)

- **Neon 실행·Play 캐시**: `orca plugin dev request local.toris-neon state.get {view:full}` / `play.list`(캐시만 읽고 Google을 호출하지 않음). RPC가 실패하면 `storage.json`을 읽기 전용으로 파싱합니다. 쓰는 도중이면 3회 재시도하고, 그래도 실패하면 화면 상단에 오류를 표시합니다.
- **Orca**: `orca project list`, `orca worktree list`, `orca worktree ps`(에이전트 상태)
- **git**: 프로젝트마다 `git log --all`(최근 21일 + 마지막 커밋), 작업 공간마다 `git status --porcelain`
- **소스**: `android/app/build.gradle(.kts)`의 `applicationId`, `export_presets.cfg`의 `package/unique_name`으로 Play 패키지와 매칭하고 스택(Godot·Flutter·Android·Web)을 판별합니다.
- **작업 일지**: `~/projects/toris-docs/journal/dev/<프로젝트>/YYYY-MM-DD.md`
- 캐시 TTL: Neon 20초, Orca 1분, git 2분, 일지 5분, 디스크 10분. 만료된 값은 바로 보여 주고 백그라운드에서 갱신합니다.

앱 매칭 순서: Neon Play 연결(`playlinks`) → 소스의 패키지 ID → 이름(패키지 마지막 부분 ↔ 프로젝트 이름, 후보가 하나일 때만). 매칭되지 않은 Play 앱과 프로젝트도 각자 한 줄로 보입니다.

## 보안·개인정보

- `127.0.0.1`에만 바인딩합니다. 휴대폰은 Tailscale Serve(테일넷 안에서만)로 접속합니다. Funnel(공개)은 쓰지 않습니다.
- `Host` 헤더가 `127.0.0.1`·`localhost`·`*.ts.net`이 아니면 거부합니다(DNS 리바인딩 방지). 응답은 CSP·`noindex`·`no-store`입니다.
- 모든 API 응답은 `scrub()`을 거칩니다. 홈 경로는 `~`로 줄이고, 이메일과 19자리 Play 개발자 ID는 숨기며, Play 계정 이름 대신 "Play 계정 1/2"로 표시합니다.
- 스크린샷은 그 실행의 결과 폴더나 작업 공간 안의 1.5MB 이하 이미지만 보여 줍니다(`src/artifacts.mjs`의 경로 검사). URL에는 파일 경로 대신 `result.json`의 근거 순번만 들어갑니다.

## 실행

```sh
npm run dashboard            # http://127.0.0.1:4317 (DASH_PORT로 변경)
node --test tests/dashboard.test.mjs
```

### 재부팅 후에도 유지 (launchd 사용자 에이전트)

plist는 메인 체크아웃 `~/projects/orca-toris-neon`에서 실행합니다. 이 브랜치가 main에 들어온 뒤 설치하세요.

```sh
cp ~/projects/orca-toris-neon/dashboard/kr.toris.auto-app-dashboard.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/kr.toris.auto-app-dashboard.plist
curl -s http://127.0.0.1:4317/healthz        # {"ok":true}
# 되돌리기
launchctl bootout gui/$(id -u)/kr.toris.auto-app-dashboard && rm ~/Library/LaunchAgents/kr.toris.auto-app-dashboard.plist
```

로그는 `~/Library/Logs/auto-app-dashboard.log`에 남습니다.

### 휴대폰 (Tailscale, 테일넷 전용)

```sh
tailscale serve --bg http://127.0.0.1:4317   # https://<맥 이름>.<tailnet>.ts.net/
tailscale serve status
tailscale serve --https=443 off               # 되돌리기
```

테일넷에서 Serve를 처음 쓰는 경우, 명령이 출력하는 `login.tailscale.com/f/serve?...` 링크에서 관리자가 한 번 허용해야 합니다.
