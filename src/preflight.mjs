/**
 * 실행 전 점검 (plan 6.4): before a run starts and whenever its card opens, each stage not yet passed
 * is 실행 가능 (ready), 해당 단계 불가 (blocked) or 확인 필요 (check), each non-ready one with what to do.
 * Facts are cheap and bounded (src/hostprobe.mjs): the project's Git state and stack markers, the
 * SDKs the stack and stage need, release signing presence, an upload tool and a Play account link.
 * It reports only; it never blocks a start. Optional helpers (ECC, image skills) are not facts here,
 * so they never make a stage unrunnable. "Blocked" needs conclusive evidence; anything the plugin
 * could not settle is "check".
 */
import { homedir } from 'node:os';
import { detectStack } from './ecc.mjs';
import { gitRepositoryState } from './runtime.mjs';
import { probeHostTools, readProjectFacts, hostIo } from './hostprobe.mjs';

export { probeHostTools, readProjectFacts };
export const PREFLIGHT_LABELS = Object.freeze({ ready: '실행 가능', blocked: '해당 단계 불가', check: '확인 필요' });
const RANK = { ready: 0, check: 1, blocked: 2 };
const worst = (states) => states.reduce((current, next) => RANK[next] > RANK[current] ? next : current, 'ready');

/** Stages that build or run the app; identity also builds, but reads the app first, so it is only "check". */
const SDK_STAGES = new Set(['build', 'test', 'reproduce', 'measure', 'monetization', 'internal', 'release']);
const SOFT_SDK_STAGES = new Set(['identity']);
/** Stages that make the release APK/AAB, and the ones that hand it to Play. */
const EXPORT_STAGES = new Set(['test', 'internal', 'release']);
const SUBMIT_STAGES = new Set(['internal', 'release']);
const ANDROID_TARGETS = ['flutter', 'godot', 'android'];
const STACK_TOOLS = { flutter: ['flutter'], godot: ['godot'], android: ['jdk', 'androidSdk'] };
const TOOL_TEXT = {
  flutter: ['Flutter SDK(flutter)', 'Flutter SDK를 설치하고 flutter를 PATH에 추가하세요: https://docs.flutter.dev/get-started/install'],
  godot: ['Godot 실행 파일', 'Godot 4를 설치하세요(macOS는 /Applications/Godot.app). 다른 위치라면 godot 명령을 PATH에 추가하세요.'],
  jdk: ['JDK', 'Android Studio를 설치하거나(내장 JDK 사용) JDK 17을 설치하고 JAVA_HOME 또는 flutter config --jdk-dir로 지정하세요.'],
  androidSdk: ['Android SDK', 'Android Studio의 SDK Manager로 Android SDK를 설치하세요. 기본 위치가 아니면 ANDROID_HOME 또는 flutter config --android-sdk로 지정하세요.'],
};
const RECHECK = '설치·설정한 뒤 실행 카드의 다시 점검을 누르세요.';
const SIGNING_FIX = '업로드 키스토어를 만들고 android/key.properties와 release signingConfig를 설정하세요. 키스토어와 비밀번호는 사람이 준비하며 Neon은 서명 파일을 읽지 않습니다.';
const reason = (state, text, fix) => ({ state, text, fix });
/** Searched in the usual places only (env, flutter config, default folders, Android Studio), so "not found" is not proof. */
const PARTIAL_SEARCH = new Set(['jdk', 'androidSdk']);

function toolReason(tools, key, project = {}) {
  if (tools[key] || (key === 'flutter' && project.localFlutter)) return null;
  const [label, fix] = TOOL_TEXT[key];
  if (tools.unsure?.includes(key)) return reason('check', label + ' 위치를 읽다가 오류가 나 설치 여부를 확인하지 못했습니다.', '폴더 권한을 확인한 뒤 다시 점검하세요.');
  if (!tools.conclusive) return reason('check', label + '을(를) 찾지 못했습니다. 로그인 셸 환경을 읽지 못해 Orca의 PATH만 확인했습니다.', '터미널에서 설치 여부를 확인하세요. 없으면 ' + fix);
  if (PARTIAL_SEARCH.has(key)) return reason('check', label + '을(를) 환경 변수·flutter config·기본 위치에서 찾지 못했습니다.', '다른 위치에 설치했다면 그대로 두어도 됩니다. 없으면 ' + fix);
  return reason('blocked', label + '을(를) 찾지 못했습니다.', fix + ' ' + RECHECK);
}
function sdkReasons(stacks, tools, project) {
  if (!stacks.length) return [reason('check', '스택을 아직 알 수 없어 필요한 SDK를 확인하지 못했습니다.', '구현 단계가 스택을 정한 뒤 다시 점검하세요.')];
  return stacks.flatMap((stack) => STACK_TOOLS[stack] ?? []).map((key) => toolReason(tools, key, project));
}
function exportReasons(stacks, tools, project, source) {
  if (!stacks.some((stack) => ANDROID_TARGETS.includes(stack))) return [];
  const reasons = [toolReason(tools, 'jdk'), toolReason(tools, 'androidSdk')];
  if (!stacks.includes('godot')) return reasons;
  const fix = 'Godot 편집기 → Editor → Manage Export Templates에서 설치한 Godot 버전의 템플릿을 받으세요. ' + RECHECK;
  if (tools.godotTemplates === false) reasons.unshift(reason('blocked', 'Godot 내보내기 템플릿이 설치돼 있지 않아 APK/AAB를 만들 수 없습니다.', fix));
  if (tools.godotTemplates == null) reasons.unshift(reason('check', 'Godot 내보내기 템플릿 폴더를 확인하지 못했습니다.', fix));
  const presetFix = 'Godot의 프로젝트 → 내보내기에서 Android 프리셋을 추가하세요. 에이전트가 테스트 단계에서 만들 수도 있습니다.';
  if (project.godotAndroidPreset === false) reasons.push(reason('check', 'Android 내보내기 프리셋(export_presets.cfg)이 없습니다.', presetFix));
  if (project.godotAndroidPreset == null && source === 'files') reasons.push(reason('check', 'Android 내보내기 프리셋(export_presets.cfg)을 읽지 못했습니다.', '파일 권한을 확인하세요. 없다면 ' + presetFix));
  return reasons;
}
function signingReason(stacks, source, project) {
  if (source !== 'files') return reason('check', '앱이 아직 없어 릴리스 서명 설정을 확인하지 못했습니다.', '구현 단계가 끝난 뒤 다시 점검하세요. 업로드 키스토어는 사람이 준비합니다.');
  const signing = project.signing;
  if (signing === 'present') return null;
  if (stacks.includes('godot')) {
    if (signing === 'missing') return reason('check', 'Android 내보내기 프리셋의 릴리스 키스토어가 비어 있습니다.', '내보내기 프리셋에 릴리스 키스토어를 지정하세요. 환경 변수로 지정했다면 그대로 두어도 됩니다.');
    return project.godotAndroidPreset === false ? null // the missing preset is already said once
      : reason('check', 'Godot 내보내기 프리셋의 릴리스 키스토어 설정을 확인하지 못했습니다.', '프로젝트 → 내보내기 → Android 프리셋의 키스토어를 확인하세요.');
  }
  if (signing === 'debug') return reason('blocked', '릴리스 빌드가 디버그 키로 서명되도록 설정돼 있어 Play에 올릴 수 없습니다.', SIGNING_FIX);
  return signing === 'missing'
    ? reason('check', '릴리스 서명 설정을 찾지 못했습니다.', SIGNING_FIX + ' 환경 변수나 CI에서 서명한다면 그대로 두어도 됩니다.')
    : reason('check', 'Android 빌드 설정(app/build.gradle)을 찾거나 읽지 못해 릴리스 서명을 확인하지 못했습니다.', '앱 모듈 위치와 파일 권한을 확인하세요.');
}
function submitReasons({ stacks, source, label }, tools, project, play) {
  if (!stacks.some((stack) => ANDROID_TARGETS.includes(stack))) {
    return stacks.length ? [reason('check', label + ' 프로젝트는 Android 앱으로 확인되지 않아 Play 제출 준비를 점검하지 못했습니다.', 'Play에 올릴 Android 빌드 방법을 확인하세요.')] : [];
  }
  const upload = tools.fastlane || tools.bundletool ? null
    : reason('check', '업로드 도구(fastlane·bundletool)를 찾지 못했습니다.', '승인 후 Play Console에서 직접 올리거나 fastlane을 설치하세요.');
  const account = play.linked || play.accounts > 0 ? null
    : play.accounts === 0 ? reason('check', '연결된 Play 제출 계정이 없어 제출 없이 준비만 합니다.', 'Play Store 탭에서 개발자 계정과 패키지를 연결하세요.')
      : reason('check', 'Play 계정 연결을 확인하지 못했습니다.', 'Play Store 탭에서 계정 상태를 확인하세요.');
  return [signingReason(stacks, source, project), upload, account];
}

function reasonsFor(node, facts) {
  const { stack, tools = {}, project = {}, play = {} } = facts;
  const stacks = stack?.stacks ?? [];
  const reasons = facts.repository?.state && facts.repository.state !== 'ok' ? [facts.repository] : [];
  if (SDK_STAGES.has(node.id)) reasons.push(...sdkReasons(stacks, tools, project));
  if (SOFT_SDK_STAGES.has(node.id)) reasons.push(...sdkReasons(stacks, tools, project).map((item) => item && { ...item, state: 'check' }));
  if (EXPORT_STAGES.has(node.id)) reasons.push(...exportReasons(stacks, tools, project, stack?.source));
  if (SUBMIT_STAGES.has(node.id)) reasons.push(...submitReasons({ stacks, source: stack?.source, label: stack?.label }, tools, project, play));
  const seen = new Set();
  return reasons.filter((item) => item && !seen.has(item.text) && seen.add(item.text));
}

/**
 * The classification of every stage not yet passed; pure, so the panel preview can use it too.
 * `notices` are checks that failed outright (timeouts, read errors): shown once, above the stages.
 */
export function classifyStages(run, facts) {
  const stages = (run?.nodes ?? []).filter((node) => node.status !== 'passed').map((node) => {
    const reasons = reasonsFor(node, facts);
    return { id: node.id, title: node.title, state: worst(reasons.map((item) => item.state)), reasons };
  });
  const counts = { ready: 0, blocked: 0, check: 0 };
  for (const item of stages) counts[item.state] += 1;
  const notices = facts.notices ?? [];
  return { overall: worst([...stages.map((item) => item.state), ...notices.map((item) => item.state)]), counts, stack: facts.stack?.label ?? null,
    conclusive: facts.tools?.conclusive === true, notices, stages };
}

const PREFLIGHT_TTL_MS = 60_000;
const STEP_MS = 6_000;
const TOOLS_MS = 9_000; // the login shell (5 s), then java_home (3 s)
const OVERALL_MS = 20_000; // project list + git (two steps), then the local file reads
const START_WAIT_MS = 8_000; // a start never waits longer than this for its check
const MAX_CACHED = 50;
const OK = Object.freeze({ state: 'ok' });
const blocked = (text, fix) => reason('blocked', text, fix);
const failure = (result) => result.timeout ? '정해진 시간 안에 답이 없음' : String(result.error?.message ?? result.error).slice(0, 200);
const unsettled = (result, what) => reason('check', what + '을(를) 확인하지 못했습니다(' + failure(result) + ').', '다시 점검을 누르세요. 계속되면 Orca 플러그인 로그를 확인하세요.');
const timeoutError = (what) => Object.assign(new Error(what + '이(가) 정해진 시간 안에 끝나지 않았습니다.'), { code: 'timeout' });
/** Settles as {value}, {error} or {timeout}; the work itself is not cancelled (each probe has its own process timeout). */
function bounded(work, ms) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), ms); timer.unref?.(); });
  const settled = Promise.resolve().then(work).then((value) => ({ value }), (error) => ({ error }));
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer));
}
const within = async (promise, ms, what) => {
  const result = await bounded(() => promise, ms);
  if (result.timeout) throw timeoutError(what);
  if ('error' in result) throw result.error;
  return result.value;
};

/** `runs.preflight` and the check before `runs.start`: one bounded check per run, cached for a minute. */
export function createPreflight({ getRun, call, submissionAccounts, inspectRepository = gitRepositoryState,
  probeTools = () => probeHostTools({ home: homedir() }), readProject = readProjectFacts, detect = detectStack, exists = hostIo.exists,
  log = () => {}, now = Date.now, ttlMs = PREFLIGHT_TTL_MS, stepMs = STEP_MS, toolsMs = TOOLS_MS, overallMs = OVERALL_MS } = {}) {
  const results = new Map(), pending = new Map();
  let tools = null, generation = 0;
  const failed = (notices, result, what) => {
    const item = unsettled(result, what);
    notices.push(item);
    log('Toris Neon preflight: ' + item.text);
    return item;
  };
  // A failed or timed-out probe is not kept: the next check probes again.
  const hostTools = (force) => {
    if (force || !tools || now() - tools.at > ttlMs) {
      const entry = { at: now(), value: bounded(probeTools, toolsMs) };
      entry.value.then((result) => { if (!result.value && tools === entry) tools = null; });
      tools = entry;
    }
    return tools.value;
  };
  const repository = async (run, notices) => {
    if (run.workspacePath) {
      const present = await exists(run.workspacePath);
      if (present === false) return { root: null, repository: reason('check', '이 실행의 작업 공간 폴더를 찾지 못했습니다.', 'Orca에서 작업 공간이 지워졌는지 확인하고 상태 동기화를 누르세요.') };
      return { root: run.workspacePath, repository: OK };
    }
    const listed = await bounded(() => call('project.list', {}), stepMs);
    if (!listed.value) return { root: null, repository: failed(notices, listed, 'Orca 프로젝트 목록') };
    const project = (listed.value.projects ?? []).find((item) => item.id === run.projectId);
    if (!project) return { root: null, repository: blocked('Orca에 등록된 이 실행의 프로젝트를 찾지 못했습니다.', '새 흐름에서 Orca에 등록된 로컬 Git 프로젝트를 고르세요.') };
    if (project.kind !== 'git') return { root: null, repository: blocked('Git 프로젝트가 아니어서 작업 공간을 만들 수 없습니다.', '프로젝트 폴더에서 git init과 첫 커밋을 만든 뒤 다시 점검하세요.') };
    if (project.hostId && project.hostId !== 'local') return { root: null, repository: blocked('원격 프로젝트는 결과 파일을 로컬에서 검증할 수 없습니다.', '로컬 프로젝트로 새 흐름을 만드세요.') };
    const state = await bounded(() => inspectRepository(project.path, run.baseBranch), stepMs);
    if (!state.value) return { root: project.path, repository: failed(notices, state, '저장소 상태') };
    if (!state.value.hasCommit) return { root: project.path, repository: blocked('이 저장소에는 아직 커밋이 없어 작업 공간을 만들 수 없습니다.', '프로젝트에서 첫 커밋을 만든 뒤 다시 점검하세요(예: git add -A && git commit -m "init"). Neon은 대신 커밋하지 않습니다.') };
    if (!state.value.hasBase) return { root: project.path, repository: blocked("기준 브랜치 '" + run.baseBranch + "'를 저장소에서 찾을 수 없습니다.", '브랜치를 만들거나 기준 브랜치를 비운 새 흐름을 만드세요.') };
    return { root: project.path, repository: OK };
  };
  const playFacts = async (run, notices) => {
    if (run.improvement?.playLink) return { linked: true, accounts: null };
    if (!run.nodes?.some((node) => SUBMIT_STAGES.has(node.id) && node.status !== 'passed')) return { linked: false, accounts: null };
    const listed = await bounded(submissionAccounts, stepMs);
    if (!Array.isArray(listed.value)) failed(notices, listed.value ? { error: new Error('응답 형식이 올바르지 않음') } : listed, 'Play 제출 계정 목록');
    return { linked: false, accounts: Array.isArray(listed.value) ? listed.value.length : null };
  };
  const localFacts = async (root, goal, notices) => {
    const local = await bounded(async () => {
      const stack = await detect({ workspacePath: root, goal });
      return { stack, project: await readProject({ root, stacks: stack.stacks }) };
    }, stepMs);
    if (local.value) return local.value;
    failed(notices, local, '스택·서명 설정');
    return { stack: { stacks: [], label: '스택 미확인', source: 'none' }, project: { signing: 'unknown', godotAndroidPreset: null, localFlutter: false } };
  };
  const compute = async (runId, force) => {
    const run = await getRun(runId);
    const notices = [];
    const [{ root, repository: repo }, host, play] = await Promise.all([repository(run, notices), hostTools(force), playFacts(run, notices)]);
    if (!host.value) failed(notices, host, '설치된 SDK·도구');
    const { stack, project } = await localFacts(root, run.goal, notices);
    const facts = { repository: repo, stack, tools: host.value ?? { conclusive: false }, project, play, notices };
    return { runId, at: new Date(now()).toISOString(), ...classifyStages(run, facts) };
  };
  return {
    check({ runId, force = false } = {}) {
      if (typeof runId !== 'string' || !runId) return Promise.reject(Object.assign(new Error('점검할 실행을 지정하세요.'), { code: 'invalid_params' }));
      const cached = results.get(runId);
      if (!force && cached && now() - cached.at < ttlMs) return Promise.resolve(cached.value);
      // A forced check never joins one already running: that one may predate what the person just fixed.
      if (!force && pending.has(runId)) return pending.get(runId);
      const ticket = ++generation;
      const work = within(compute(runId, force), overallMs, '실행 전 점검').then((value) => {
        const latest = results.get(runId);
        if (!latest || latest.ticket < ticket) {
          results.delete(runId);
          results.set(runId, { at: now(), value, ticket });
          while (results.size > MAX_CACHED) results.delete(results.keys().next().value);
        }
        return value;
      }).finally(() => { if (pending.get(runId) === work) pending.delete(runId); });
      pending.set(runId, work);
      return work;
    },
  };
}

/** The panel request, and `runs.start` with a fresh check first, waited for at most START_WAIT_MS; a failed check never stops the start. */
export function preflightHandlers({ preflight, start, log = () => {}, waitMs = START_WAIT_MS }) {
  return {
    'runs.preflight': (input = {}) => preflight.check({ runId: input.runId, force: input.force === true }),
    'runs.start': async (input = {}) => {
      try { await within(preflight.check({ runId: input.runId, force: true }), waitMs, '시작 전 점검'); }
      catch (error) { log('Toris Neon preflight: ' + String(error?.message ?? error)); }
      return start(input);
    },
  };
}
