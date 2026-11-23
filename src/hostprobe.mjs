/**
 * Cheap, bounded facts for the preflight (src/preflight.mjs): which SDKs and tools this computer has
 * and whether the project has release signing set up. Detection only: nothing is built. The one
 * process run is the person's login shell printing its environment (so PATH matches the agents'
 * terminals), plus macOS java_home; only PATH and the SDK location variables are kept from it.
 * Signing files are checked for existence, never read; build scripts are only pattern-matched.
 * A lookup that fails for any reason other than "not there" is reported as unsure, never as absent.
 */
import { execFile } from 'node:child_process';
import { constants as FS, promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileIo } from './ecc.mjs';

const SHELL_MS = 5_000;
const JAVA_HOME_MS = 3_000;
const HEAD_BYTES = 64 * 1024;
const TOOLS = ['git', 'flutter', 'godot', 'java', 'fastlane', 'bundletool'];
const KEPT_ENV = new Set(['PATH', 'JAVA_HOME', 'ANDROID_HOME', 'ANDROID_SDK_ROOT']);
const EXTRA_DIRS = (home) => ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, 'flutter/bin'), path.join(home, 'development/flutter/bin'), path.join(home, 'fvm/default/bin')];
const ABSENT = new Set(['ENOENT', 'ENOTDIR']);

const run = promisify(execFile);
const defaultExec = (file, args, timeout) => {
  const pending = run(file, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 1024 * 1024 });
  pending.child?.stdin?.end(); // an interactive shell must not wait for input
  return pending;
};
/** exists: true, false (not there), or null (could not tell, e.g. EACCES). */
const existsState = (file, mode) => fs.access(file, mode).then(() => true, (error) => ABSENT.has(error?.code) ? false : null);
export const hostIo = {
  ...fileIo,
  exists: (file) => existsState(file),
  isExecutable: (file) => existsState(file, FS.X_OK).then((state) => state === true),
};

/** PATH and SDK variables from `$SHELL -ilc env`; everything else in the output is dropped. */
async function loginEnv({ exec, env, platform }) {
  if (platform === 'win32' || !env.SHELL) return null;
  try {
    const { stdout } = await exec(env.SHELL, ['-ilc', 'env'], SHELL_MS);
    const kept = {};
    for (const line of String(stdout).split('\n')) {
      const at = line.indexOf('=');
      if (at > 0 && KEPT_ENV.has(line.slice(0, at))) kept[line.slice(0, at)] = line.slice(at + 1).trim();
    }
    return kept.PATH ? kept : null;
  } catch { return null; }
}
/** The first candidate that passes; `unsure` when none passed but one could not be checked. */
async function probeFirst(candidates, test) {
  let unsure = false;
  for (const candidate of candidates.filter(Boolean)) {
    const state = await test(candidate);
    if (state === true) return { found: candidate, unsure: false };
    if (state === null) unsure = true;
  }
  return { found: null, unsure };
}
async function godotTemplates({ io, platform, home, env }) {
  const dir = platform === 'darwin' ? path.join(home, 'Library/Application Support/Godot/export_templates')
    : platform === 'win32' ? path.join(env.APPDATA ?? path.join(home, 'AppData/Roaming'), 'Godot/export_templates')
      : path.join(env.XDG_DATA_HOME ?? path.join(home, '.local/share'), 'godot/export_templates');
  try { return (await io.readdir(dir)).length > 0; }
  catch (error) { return ABSENT.has(error?.code) ? false : null; }
}
/** macOS java_home: a path, null when it says there is no JDK (non-zero exit), undefined when it could not answer. */
async function javaHome({ exec, platform }) {
  if (platform !== 'darwin') return null;
  try { return String((await exec('/usr/libexec/java_home', [], JAVA_HOME_MS)).stdout).trim() || null; }
  catch (error) { return typeof error?.code === 'number' && !error.killed ? null : undefined; }
}
/** `flutter config --android-sdk / --jdk-dir` are stored here; Gradle builds of Flutter apps use them. */
async function flutterSettings(io, home) {
  try { return JSON.parse(await io.readHead(path.join(home, '.config/flutter/settings'), HEAD_BYTES)) ?? {}; } catch { return {}; }
}

/**
 * Where each tool is (a path or null). `conclusive` is true only when the login shell answered, so a
 * tool missing from the worker's own PATH alone is never taken as absent. `unsure` names tools whose
 * lookup hit an error other than "not there".
 */
export async function probeHostTools({ exec = defaultExec, io = hostIo, env = process.env, platform = process.platform, home } = {}) {
  const shell = await loginEnv({ exec, env, platform });
  const vars = { ...env, ...(shell ?? {}) };
  const dirs = [...new Set([...String(vars.PATH ?? '').split(path.delimiter), ...EXTRA_DIRS(home)].filter(Boolean))];
  const suffixes = platform === 'win32' ? ['.exe', '.bat', '.cmd', ''] : [''];
  const which = async (tool) => (await probeFirst(dirs.flatMap((dir) => suffixes.map((suffix) => path.join(dir, tool + suffix))), io.isExecutable)).found;
  const found = Object.fromEntries(await Promise.all(TOOLS.map(async (tool) => [tool, await which(tool)])));
  const mac = platform === 'darwin';
  const appDirs = mac ? ['/Applications', path.join(home, 'Applications')] : [];
  const settings = await flutterSettings(io, home);
  const sdkDefault = mac ? path.join(home, 'Library/Android/sdk') : platform === 'win32' ? path.join(env.LOCALAPPDATA ?? home, 'Android/Sdk') : path.join(home, 'Android/Sdk');
  const isSdk = async (dir) => {
    const states = await Promise.all(['platform-tools', 'build-tools'].map((name) => io.exists(path.join(dir, name))));
    return states.includes(true) ? true : states.includes(null) ? null : false;
  };
  const [macJava, godotApp, jdkDir, sdk, templates] = await Promise.all([
    javaHome({ exec, platform }),
    probeFirst(appDirs.flatMap((dir) => ['Godot.app', 'Godot_mono.app'].map((app) => path.join(dir, app, 'Contents/MacOS/Godot'))), io.exists),
    probeFirst([vars.JAVA_HOME, settings['jdk-dir'], ...appDirs.map((dir) => path.join(dir, 'Android Studio.app/Contents/jbr'))], io.exists),
    probeFirst([vars.ANDROID_HOME, vars.ANDROID_SDK_ROOT, settings['android-sdk'], sdkDefault], isSdk),
    godotTemplates({ io, platform, home, env: vars }),
  ]);
  // macOS ships a /usr/bin/java stub without a JDK; there only java_home or a real JDK folder counts.
  const jdk = jdkDir.found ?? macJava ?? (mac ? null : found.java);
  const unsure = [...(!jdk && (jdkDir.unsure || macJava === undefined) ? ['jdk'] : []), ...(!sdk.found && sdk.unsure ? ['androidSdk'] : []),
    ...(!found.godot && !godotApp.found && godotApp.unsure ? ['godot'] : [])];
  return { conclusive: Boolean(shell), git: found.git, flutter: found.flutter, godot: found.godot ?? godotApp.found, jdk: jdk ?? null,
    androidSdk: sdk.found, fastlane: found.fastlane, bundletool: found.bundletool, godotTemplates: templates, unsure };
}

const RELEASE_NAME = /create\(\s*["']release["']\s*\)|register\(\s*["']release["']\s*\)|getByName\(\s*["']release["']\s*\)|\brelease\s*\{/;
const RELEASE_ANYWHERE = /signingConfigs\.(?:create|register)\(\s*["']release["']|signingConfig\s*=?\s*signingConfigs\.(?:getByName\(\s*["']release["']\s*\)|release\b)/;
const SIGNING_ASSIGNMENT = /\bsigningConfig\s*=?\s*signingConfigs\.(?:getByName\(\s*["']([^"']+)["']\s*\)|([A-Za-z_]\w*))/g;
/** File text, null when it does not exist; any other read error is thrown so it is not taken as "no file". */
async function readText(io, file) {
  try { return await io.readHead(file, HEAD_BYTES); }
  catch (error) { if (ABSENT.has(error?.code)) return null; throw error; }
}
const withoutComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
/** The body of the first `{ ... }` block opened by `opener`, or ''. */
function block(text, opener) {
  const open = opener.exec(text);
  if (!open) return '';
  let depth = 1, at = open.index + open[0].length;
  const start = at;
  for (; at < text.length && depth > 0; at++) depth += text[at] === '{' ? 1 : text[at] === '}' ? -1 : 0;
  return text.slice(start, at);
}

/** present, debug (the release build type is signed with the debug key), missing, or unknown. */
export function gradleSigningState(gradle) {
  const source = withoutComments(gradle);
  const release = block(block(source, /buildTypes\s*\{/), /(?:\brelease|getByName\(\s*["']release["']\s*\))\s*\{/);
  const last = [...release.matchAll(SIGNING_ASSIGNMENT)].at(-1);
  if (last) return (last[1] ?? last[2]) === 'debug' ? 'debug' : 'present';
  return RELEASE_NAME.test(block(source, /signingConfigs\s*\{/)) || RELEASE_ANYWHERE.test(source) ? 'present' : 'missing';
}
async function gradleSigning(io, moduleDir, keyFiles) {
  let state = 'unknown';
  try {
    const gradle = await readText(io, path.join(moduleDir, 'build.gradle.kts')) ?? await readText(io, path.join(moduleDir, 'build.gradle'));
    if (gradle !== null) state = gradleSigningState(gradle);
  } catch { /* an unreadable build file leaves the signing configuration unknown */ }
  if (state === 'debug' || state === 'present') return state;
  for (const file of keyFiles) if (await io.exists(file) === true) return 'present'; // existence only: these hold passwords
  return state;
}

/**
 * Release signing (present, debug, missing, unknown), whether a Godot project has an Android export
 * preset (null when unreadable), and whether a Flutter project pins its own SDK with FVM.
 */
export async function readProjectFacts({ root, stacks = [], io = hostIo } = {}) {
  const facts = { signing: 'unknown', godotAndroidPreset: null, localFlutter: false };
  if (!root) return facts;
  if (stacks.includes('godot')) {
    let presets;
    try { presets = await readText(io, path.join(root, 'export_presets.cfg')); } catch { return facts; }
    const android = presets !== null && /platform\s*=\s*"Android"/.test(presets);
    return { ...facts, signing: !android ? 'unknown' : /keystore\/release\s*=\s*"[^"]+"/.test(presets) ? 'present' : 'missing', godotAndroidPreset: android };
  }
  if (stacks.includes('flutter')) {
    const android = path.join(root, 'android');
    const [signing, fvm] = await Promise.all([gradleSigning(io, path.join(android, 'app'), [path.join(android, 'key.properties')]), io.exists(path.join(root, '.fvm/flutter_sdk'))]);
    return { ...facts, signing, localFlutter: fvm === true };
  }
  if (stacks.includes('android')) {
    return { ...facts, signing: await gradleSigning(io, path.join(root, 'app'), [path.join(root, 'key.properties'), path.join(root, 'keystore.properties')]) };
  }
  return facts;
}
