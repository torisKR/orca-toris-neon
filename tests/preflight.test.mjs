import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStages, probeHostTools, readProjectFacts, createPreflight, preflightHandlers, PREFLIGHT_LABELS } from '../src/preflight.mjs';
import { gradleSigningState } from '../src/hostprobe.mjs';
import { templateGraph } from '../src/engine.mjs';

const HOME = '/Users/me';
const flutterStack = { stacks: ['flutter'], label: 'Flutter/Dart', source: 'files' };
const allTools = {
  conclusive: true, git: '/usr/bin/git', flutter: '/opt/flutter/bin/flutter', godot: '/opt/bin/godot', jdk: '/opt/jdk',
  androidSdk: HOME + '/Library/Android/sdk', fastlane: '/opt/homebrew/bin/fastlane', bundletool: null, godotTemplates: true,
};
const facts = (extra = {}) => ({
  repository: { state: 'ok' }, stack: flutterStack, tools: allTools,
  project: { signing: 'present', godotAndroidPreset: null }, play: { linked: false, accounts: 1 }, ...extra,
});
const newApp = (extra = {}) => ({ id: 'run-1', goal: 'Flutter 습관 앱', projectId: 'p1', nodes: templateGraph('new-app').map((node) => ({ ...node, status: 'pending' })), ...extra });
const stage = (result, id) => result.stages.find((item) => item.id === id);

test('every stage of a Flutter app with its SDKs, signing and a Play account is 실행 가능', () => {
  // Arrange
  const run = newApp();
  // Act
  const result = classifyStages(run, facts());
  // Assert
  assert.equal(result.overall, 'ready');
  assert.deepEqual(result.counts, { ready: 11, blocked: 0, check: 0 });
  assert.equal(PREFLIGHT_LABELS[result.overall], '실행 가능');
});

test('a repository without commits makes every stage 해당 단계 불가 with the first-commit fix', () => {
  const repository = { state: 'blocked', text: '저장소에 커밋이 없습니다.', fix: '첫 커밋을 만드세요.' };
  const result = classifyStages(newApp(), facts({ repository }));
  assert.equal(result.counts.blocked, 11);
  assert.equal(stage(result, 'research').reasons[0].fix, '첫 커밋을 만드세요.');
});

test('a Flutter SDK conclusively missing blocks only the stages that build, test or ship', () => {
  const result = classifyStages(newApp(), facts({ tools: { ...allTools, flutter: null } }));
  for (const id of ['build', 'test', 'internal', 'release']) assert.equal(stage(result, id).state, 'blocked', id);
  for (const id of ['research', 'brief', 'architecture', 'design', 'assets', 'policy', 'listing']) assert.equal(stage(result, id).state, 'ready', id);
  assert.match(stage(result, 'build').reasons[0].text, /Flutter SDK/);
  assert.ok(stage(result, 'build').reasons[0].fix.length > 0);
});

test('a tool not found while the login shell could not be read is 확인 필요, never 불가', () => {
  const result = classifyStages(newApp(), facts({ tools: { ...allTools, conclusive: false, flutter: null } }));
  assert.equal(stage(result, 'build').state, 'check');
  assert.equal(result.counts.blocked, 0);
});

test('release stages need the Android SDK and a JDK; not finding them in the usual places is 확인 필요, not proof', () => {
  const result = classifyStages(newApp(), facts({ tools: { ...allTools, androidSdk: null, jdk: null } }));
  for (const id of ['test', 'internal', 'release']) assert.equal(stage(result, id).state, 'check', id);
  assert.equal(stage(result, 'build').state, 'ready');
  assert.deepEqual(stage(result, 'internal').reasons.map((reason) => reason.text).filter((text) => /JDK|Android SDK/.test(text)).length, 2);
});

test('a release build signed with the debug key blocks submission; no signing evidence only asks to check', () => {
  const debug = classifyStages(newApp(), facts({ project: { signing: 'debug' } }));
  assert.equal(stage(debug, 'internal').state, 'blocked');
  assert.equal(stage(debug, 'test').state, 'ready');
  const unknown = classifyStages(newApp(), facts({ project: { signing: 'missing' } }));
  assert.equal(stage(unknown, 'release').state, 'check');
});

test('an empty repository of a new app defers the signing check until the app exists', () => {
  const result = classifyStages(newApp(), facts({ stack: { stacks: ['flutter'], label: 'Flutter/Dart', source: 'goal' }, project: { signing: 'unknown' } }));
  assert.equal(stage(result, 'internal').state, 'check');
  assert.match(stage(result, 'internal').reasons.map((reason) => reason.text).join(' '), /앱이 아직/);
});

test('an unknown stack cannot be checked for its SDK and says so', () => {
  const result = classifyStages(newApp(), facts({ stack: { stacks: [], label: '스택 미확인', source: 'none' } }));
  assert.equal(stage(result, 'build').state, 'check');
  assert.equal(stage(result, 'research').state, 'ready');
});

test('Godot without export templates blocks the export stages but not the build', () => {
  const godot = { stacks: ['godot'], label: 'Godot/GDScript', source: 'files' };
  const result = classifyStages(newApp(), facts({ stack: godot, tools: { ...allTools, godotTemplates: false }, project: { signing: 'present', godotAndroidPreset: true } }));
  assert.equal(stage(result, 'build').state, 'ready');
  for (const id of ['test', 'internal', 'release']) assert.equal(stage(result, id).state, 'blocked', id);
  assert.match(stage(result, 'test').reasons[0].fix, /Export Templates/);
});

test('without a Play account the submission stages only prepare: 확인 필요 with where to link one', () => {
  const result = classifyStages(newApp(), facts({ play: { linked: false, accounts: 0 } }));
  assert.equal(stage(result, 'internal').state, 'check');
  assert.match(stage(result, 'internal').reasons.at(-1).fix, /Play Store 탭/);
  const linked = classifyStages(newApp(), facts({ play: { linked: true, accounts: 0 } }));
  assert.equal(stage(linked, 'internal').state, 'ready');
});

test('no upload tool is 확인 필요 because a person can still upload in Play Console', () => {
  const result = classifyStages(newApp(), facts({ tools: { ...allTools, fastlane: null, bundletool: null } }));
  assert.equal(stage(result, 'release').state, 'check');
});

test('optional helpers (ECC, image skills) are not facts: design and assets stay 실행 가능 without them', () => {
  const result = classifyStages(newApp(), facts({ tools: { conclusive: true } }));
  assert.equal(stage(result, 'design').state, 'ready');
  assert.equal(stage(result, 'assets').state, 'ready');
});

test('passed stages are left out and an improvement run is classified by its own stage ids', () => {
  const nodes = templateGraph('improve', { kind: 'bugfix' }).map((node) => ({ ...node, status: node.id === 'identity' ? 'passed' : 'pending' }));
  const result = classifyStages({ id: 'run-2', nodes }, facts({ tools: { ...allTools, flutter: null } }));
  assert.deepEqual(result.stages.map((item) => item.id), ['reproduce', 'build', 'test']);
  assert.ok(result.stages.every((item) => item.state === 'blocked'));
});

const shellEnv = 'Last login: today\nPATH=/opt/flutter/bin:/usr/bin\nJAVA_HOME=/opt/jdk\nANDROID_HOME=/opt/android\nSECRET_TOKEN=do-not-keep\n';
const fakeFs = (paths) => ({
  isExecutable: async (file) => paths.has(file), exists: async (file) => paths.has(file),
  readdir: async (dir) => { if (paths.has(dir)) return ['4.3.stable']; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
});

test('host probe reads PATH and SDK locations from the login shell and keeps nothing else', async () => {
  // Arrange
  const exec = async (file) => file === '/bin/zsh' ? { stdout: shellEnv } : Promise.reject(new Error('no java_home'));
  const io = fakeFs(new Set(['/opt/flutter/bin/flutter', '/usr/bin/git', '/opt/jdk', '/opt/android/platform-tools']));
  // Act
  const tools = await probeHostTools({ exec, io, env: { SHELL: '/bin/zsh', PATH: '/usr/bin' }, platform: 'darwin', home: HOME });
  // Assert
  assert.equal(tools.conclusive, true);
  assert.equal(tools.flutter, '/opt/flutter/bin/flutter');
  assert.equal(tools.jdk, '/opt/jdk');
  assert.equal(tools.androidSdk, '/opt/android');
  assert.equal(tools.godotTemplates, false);
  assert.ok(!JSON.stringify(tools).includes('do-not-keep'));
});

test('a failed login shell falls back to the worker PATH and is not conclusive', async () => {
  const exec = async () => { throw Object.assign(new Error('timeout'), { killed: true }); };
  const io = fakeFs(new Set(['/usr/bin/git']));
  const tools = await probeHostTools({ exec, io, env: { SHELL: '/bin/zsh', PATH: '/usr/bin' }, platform: 'darwin', home: HOME });
  assert.equal(tools.conclusive, false);
  assert.equal(tools.git, '/usr/bin/git');
  assert.equal(tools.flutter, null);
});

test('the macOS /usr/bin/java stub is not a JDK; Android Studio\'s bundled runtime and Godot.app are found', async () => {
  const exec = async (file) => file === '/bin/zsh' ? { stdout: 'PATH=/usr/bin\n' } : file.endsWith('/Godot') ? { stdout: '4.3.stable.official.77dcf97d8\n' } : Promise.reject(new Error('Unable to locate a Java Runtime'));
  const io = fakeFs(new Set(['/usr/bin/java', '/Applications/Android Studio.app/Contents/jbr', '/Applications/Godot.app/Contents/MacOS/Godot',
    HOME + '/Library/Application Support/Godot/export_templates']));
  const tools = await probeHostTools({ exec, io, env: { SHELL: '/bin/zsh', PATH: '/usr/bin' }, platform: 'darwin', home: HOME });
  assert.equal(tools.jdk, '/Applications/Android Studio.app/Contents/jbr');
  assert.equal(tools.godot, '/Applications/Godot.app/Contents/MacOS/Godot');
  assert.equal(tools.godotTemplates, true);
});

const godotHost = (version, templates) => ({
  exec: async (file, args) => file === '/bin/zsh' ? { stdout: 'PATH=/opt/bin\n' } : file === '/opt/bin/godot' && args[0] === '--version' && version ? { stdout: version } : Promise.reject(new Error('no')),
  io: { isExecutable: async (file) => file === '/opt/bin/godot', exists: async () => false,
    readdir: async (dir) => { if (dir === HOME + '/Library/Application Support/Godot/export_templates' && templates) return templates; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } },
});
const probeGodot = ({ exec, io }) => probeHostTools({ exec, io, env: { SHELL: '/bin/zsh', PATH: '/usr/bin' }, platform: 'darwin', home: HOME });

test('Godot export templates count only for the installed Godot version', async () => {
  // Arrange / Act
  const other = await probeGodot(godotHost('4.3.stable.official.77dcf97d8\n', ['4.2.2.stable']));
  const same = await probeGodot(godotHost('Godot Engine\n4.3.stable.official.77dcf97d8\n', ['4.2.2.stable', '4.3.stable']));
  const mono = await probeGodot(godotHost('4.3.stable.mono.official.77dcf97d8', ['4.3.stable']));
  // Assert
  assert.equal(other.godotVersion, '4.3.stable');
  assert.equal(other.godotTemplates, false, 'templates of another version do not export this one');
  assert.deepEqual(other.godotTemplateVersions, ['4.2.2.stable']);
  assert.equal(same.godotTemplates, true);
  assert.equal(mono.godotVersion, '4.3.stable.mono');
  assert.equal(mono.godotTemplates, false, 'the .NET build needs its own templates');
});

test('templates whose Godot version cannot be read are unsure, not ready', async () => {
  const unknown = await probeGodot(godotHost(null, ['4.3.stable']));
  assert.equal(unknown.godotVersion, null);
  assert.equal(unknown.godotTemplates, null);
  const none = await probeGodot(godotHost('4.3.stable.official', null));
  assert.equal(none.godotTemplates, false);
});

test('the preflight names the installed version and the templates found instead', () => {
  // Arrange
  const godot = { stacks: ['godot'], label: 'Godot/GDScript', source: 'files' };
  const project = { signing: 'present', godotAndroidPreset: true };
  // Act
  const missing = classifyStages(newApp(), facts({ stack: godot, project, tools: { ...allTools, godotTemplates: false, godotVersion: '4.3.stable', godotTemplateVersions: ['4.2.2.stable'] } }));
  const unsure = classifyStages(newApp(), facts({ stack: godot, project, tools: { ...allTools, godotTemplates: null, godotVersion: null, godotTemplateVersions: ['4.3.stable'] } }));
  // Assert
  assert.equal(stage(missing, 'test').state, 'blocked');
  assert.match(stage(missing, 'test').reasons[0].text, /Godot 4\.3\.stable용 내보내기 템플릿이 없어.*설치된 템플릿: 4\.2\.2\.stable/);
  assert.equal(stage(unsure, 'test').state, 'check');
  assert.match(stage(unsure, 'test').reasons[0].text, /Godot 버전을 확인하지 못해/);
});

const projectIo = (files) => ({
  exists: async (file) => file in files,
  readHead: async (file) => { if (file in files) return files[file]; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
});

test('Flutter signing: key.properties counts as present without being read; the template debug signing is found', async () => {
  const present = await readProjectFacts({ root: '/w', stacks: ['flutter'], io: projectIo({ '/w/android/key.properties': 'storePassword=secret' }) });
  assert.equal(present.signing, 'present');
  const debugGradle = 'android {\n buildTypes {\n  release {\n   signingConfig = signingConfigs.getByName("debug")\n  }\n }\n}';
  const debug = await readProjectFacts({ root: '/w', stacks: ['flutter'], io: projectIo({ '/w/android/app/build.gradle.kts': debugGradle }) });
  assert.equal(debug.signing, 'debug');
  const releaseGradle = 'android { signingConfigs { create("release") { storeFile = file(System.getenv("KS")) } } }';
  const release = await readProjectFacts({ root: '/w', stacks: ['flutter'], io: projectIo({ '/w/android/app/build.gradle.kts': releaseGradle }) });
  assert.equal(release.signing, 'present');
  const debugOnlyBlock = 'android { signingConfigs { debug { } }\n buildTypes { release { signingConfig signingConfigs.debug } } }';
  const debugOnly = await readProjectFacts({ root: '/w', stacks: ['flutter'], io: projectIo({ '/w/android/app/build.gradle': debugOnlyBlock }) });
  assert.equal(debugOnly.signing, 'debug', 'a buildTypes release block is not a release signing config');
});

test('Godot export presets: an Android preset with a release keystore path is present, an empty one is missing', async () => {
  const filled = await readProjectFacts({ root: '/g', stacks: ['godot'], io: projectIo({ '/g/export_presets.cfg': '[preset.0]\nplatform="Android"\nkeystore/release="/keys/upload.jks"\n' }) });
  assert.deepEqual(filled, { signing: 'present', godotAndroidPreset: true, localFlutter: false });
  const empty = await readProjectFacts({ root: '/g', stacks: ['godot'], io: projectIo({ '/g/export_presets.cfg': '[preset.0]\nplatform="Android"\nkeystore/release=""\n' }) });
  assert.deepEqual(empty, { signing: 'missing', godotAndroidPreset: true, localFlutter: false });
  const none = await readProjectFacts({ root: '/g', stacks: ['godot'], io: projectIo({}) });
  assert.deepEqual(none, { signing: 'unknown', godotAndroidPreset: false, localFlutter: false });
});

const service = (extra = {}) => {
  const calls = { tools: 0, repo: 0 };
  const run = newApp({ isolate: true });
  const preflight = createPreflight({
    getRun: async (runId) => { if (runId !== 'run-1') throw new Error('실행을 찾을 수 없습니다.'); return run; },
    call: async () => ({ projects: [{ id: 'p1', kind: 'git', path: '/Users/me/projects/app' }] }),
    submissionAccounts: async () => [{ id: 'a1' }],
    inspectRepository: async () => { calls.repo += 1; return { hasCommit: true, hasBase: true }; },
    probeTools: async () => { calls.tools += 1; return allTools; },
    readProject: async () => ({ signing: 'present', godotAndroidPreset: null }),
    detect: async () => flutterStack,
    now: () => 1_000, ...extra,
  });
  return { preflight, calls, run };
};

test('the service checks the project checkout, caches the result and re-probes only when forced', async () => {
  const { preflight, calls } = service();
  const first = await preflight.check({ runId: 'run-1' });
  const second = await preflight.check({ runId: 'run-1' });
  await preflight.check({ runId: 'run-1', force: true });
  assert.equal(first.overall, 'ready');
  assert.equal(first.runId, 'run-1');
  assert.equal(second, first);
  assert.equal(calls.tools, 2);
  assert.equal(calls.repo, 2);
});

test('the service reports a project without commits before any workspace exists', async () => {
  const { preflight } = service({ inspectRepository: async () => ({ hasCommit: false, hasBase: false }) });
  const result = await preflight.check({ runId: 'run-1' });
  assert.equal(result.overall, 'blocked');
  assert.match(result.stages[0].reasons[0].fix, /git commit/);
});

test('a check that does not answer in time becomes 확인 필요 instead of holding the card', async () => {
  const { preflight } = service({ inspectRepository: () => new Promise(() => {}), stepMs: 20 });
  const result = await preflight.check({ runId: 'run-1' });
  assert.equal(result.overall, 'check');
  assert.match(result.stages[0].reasons[0].text, /시간 안에/);
});

test('an unknown run is refused', async () => {
  const { preflight } = service();
  await assert.rejects(preflight.check({ runId: 'nope' }), /실행을 찾을 수 없습니다/);
});

test('runs.start re-checks the run first, and a failing check is logged without stopping the start', async () => {
  // Arrange
  const checks = [], logs = [];
  const handlers = preflightHandlers({
    preflight: { check: async (input) => { checks.push(input); throw new Error('probe broke'); } },
    start: async (input) => ({ started: input.runId }), log: (line) => logs.push(line),
  });
  // Act
  const result = await handlers['runs.start']({ runId: 'run-1' });
  // Assert
  assert.deepEqual(result, { started: 'run-1' });
  assert.deepEqual(checks, [{ runId: 'run-1', force: true }]);
  assert.match(logs[0], /probe broke/);
});

test('runs.preflight forces a new check only when asked', async () => {
  const checks = [];
  const handlers = preflightHandlers({ preflight: { check: async (input) => { checks.push(input); return { overall: 'ready' }; } }, start: async () => null });
  await handlers['runs.preflight']({ runId: 'run-1' });
  await handlers['runs.preflight']({ runId: 'run-1', force: true });
  assert.deepEqual(checks, [{ runId: 'run-1', force: false }, { runId: 'run-1', force: true }]);
});


test('a lookup that hit an error other than "not there" is 확인 필요, even after the login shell answered', () => {
  const result = classifyStages(newApp(), facts({ stack: { stacks: ['godot'], label: 'Godot/GDScript', source: 'files' }, tools: { ...allTools, godot: null, unsure: ['godot'] }, project: { signing: 'present', godotAndroidPreset: true } }));
  assert.equal(stage(result, 'build').state, 'check');
  assert.match(stage(result, 'build').reasons[0].text, /오류/);
});

test('a Flutter SDK pinned in the project with FVM counts even when flutter is not on PATH', () => {
  const result = classifyStages(newApp(), facts({ tools: { ...allTools, flutter: null }, project: { signing: 'present', localFlutter: true } }));
  assert.equal(stage(result, 'build').state, 'ready');
});

test('debug signing is read only from the release build type and never from comments', () => {
  assert.equal(gradleSigningState('buildTypes { debug { signingConfig = signingConfigs.getByName("debug") }\n release { minifyEnabled true } }'), 'missing');
  assert.equal(gradleSigningState('buildTypes { release {\n // signingConfig = signingConfigs.debug\n } }'), 'missing');
  assert.equal(gradleSigningState('buildTypes { getByName("release") { signingConfig = signingConfigs.getByName("debug") } }'), 'debug');
  assert.equal(gradleSigningState('android { }\nandroid.signingConfigs.create("release") { }'), 'present');
});

test('a release configured to sign with the debug key is flagged even with upload key material present', async () => {
  const script = 'android { signingConfigs { create("release") {} } buildTypes { release { signingConfig = signingConfigs.debug } } }';
  const files = { '/w/android/app/build.gradle.kts': script, '/w/android/key.properties': '' };

  const project = await readProjectFacts({ root: '/w', stacks: ['flutter'], io: projectIo(files) });

  assert.equal(project.signing, 'debug');
  assert.equal(gradleSigningState(script.replace('signingConfigs.debug', 'signingConfigs.debug\n signingConfig = signingConfigs.getByName("release")')), 'present');
});

test('an unreadable Godot preset is unknown, never "no preset" and never ready', async () => {
  const io = { exists: async () => false, readHead: async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } };
  const project = await readProjectFacts({ root: '/g', stacks: ['godot'], io });
  assert.deepEqual(project, { signing: 'unknown', godotAndroidPreset: null, localFlutter: false });
  const result = classifyStages(newApp(), facts({ stack: { stacks: ['godot'], label: 'Godot/GDScript', source: 'files' }, project }));
  assert.equal(stage(result, 'internal').state, 'check');
  assert.match(stage(result, 'internal').reasons.map((item) => item.text).join(' '), /읽지 못했습니다/);
});

test('a timed-out tool probe is a logged notice, makes the run 확인 필요, and is probed again next time', async () => {
  const logs = [];
  let probes = 0;
  const { preflight } = service({ probeTools: () => { probes += 1; return new Promise(() => {}); }, toolsMs: 10, log: (line) => logs.push(line) });
  const result = await preflight.check({ runId: 'run-1' });
  assert.equal(result.overall, 'check');
  assert.match(result.notices[0].text, /설치된 SDK·도구/);
  assert.match(logs[0], /정해진 시간/);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await preflight.check({ runId: 'run-1', force: true });
  assert.equal(probes, 2);
});

test('a forced check does not join a check already running', async () => {
  let release;
  let repoCalls = 0;
  const { preflight } = service({ inspectRepository: () => { repoCalls += 1; return repoCalls === 1 ? new Promise((resolve) => { release = resolve; }) : { hasCommit: true, hasBase: true }; } });
  const first = preflight.check({ runId: 'run-1' });
  await new Promise((resolve) => setImmediate(resolve));
  const forced = await preflight.check({ runId: 'run-1', force: true });
  assert.equal(repoCalls, 2);
  assert.equal(forced.overall, 'ready');
  release({ hasCommit: false, hasBase: false });
  await first;
  assert.equal((await preflight.check({ runId: 'run-1' })).overall, 'ready', 'the older result does not replace the newer one');
});

test('a run whose workspace folder is gone is 확인 필요', async () => {
  const { preflight } = service({ getRun: async () => ({ ...newApp(), workspacePath: '/Users/me/gone' }), exists: async () => false });
  const result = await preflight.check({ runId: 'run-1' });
  assert.equal(result.overall, 'check');
  assert.match(result.stages[0].reasons[0].text, /작업 공간 폴더/);
});

test('a start waits for its check only a bounded time', async () => {
  const logs = [];
  const handlers = preflightHandlers({ preflight: { check: () => new Promise(() => {}) }, start: async () => 'started', log: (line) => logs.push(line), waitMs: 10 });
  assert.equal(await handlers['runs.start']({ runId: 'run-1' }), 'started');
  assert.match(logs[0], /시작 전 점검/);
});

test('an empty Godot repository of a new app does not claim an unreadable preset', () => {
  const result = classifyStages(newApp(), facts({ stack: { stacks: ['godot'], label: 'Godot/GDScript', source: 'goal' }, project: { signing: 'unknown', godotAndroidPreset: null } }));
  assert.doesNotMatch(stage(result, 'test').reasons.map((item) => item.text).join(' '), /읽지 못했습니다/);
});
