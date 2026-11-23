/**
 * ECC (github.com/affaan-m/ECC) guidance for a stage: what is installed, what the project is,
 * what happened to the stage so far, and from that a short, deterministic list of ECC agents
 * and skills. Everything read from disk is untrusted text and only ever reaches a prompt as data.
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const ECC_ROOT = path.join(homedir(), '.claude', 'plugins', 'cache', 'ecc', 'ecc');
export const MAX_DESCRIPTION_CHARS = 160;
const MAX_AGENTS = 200;
const MAX_SKILLS = 600;
const HEAD_BYTES = 4096;
const PACKAGE_BYTES = 64 * 1024;
const CATALOG_TTL_MS = 10 * 60_000;
const MAX_SHORTLIST_AGENTS = 4;
const MAX_SHORTLIST_SKILLS = 5;
const SAFE_NAME = /^[a-z][a-z0-9-]{1,63}$/;
const PINNED_NAME = /^ecc:[a-z][a-z0-9-]{1,63}$/;
const VERSION_DIR = /^\d+\.\d+\.\d+$/;

/** What the previous release wrote into every new stage; such values mean "automatic". */
export const LEGACY_ECC_DEFAULTS = {
  research: 'ecc:marketing-agent', brief: 'ecc:planner', architecture: 'ecc:architect',
  design: 'ecc:a11y-architect', assets: null, build: 'ecc:tdd-guide', test: 'ecc:e2e-runner',
  policy: 'ecc:security-reviewer', listing: 'ecc:seo-specialist', internal: 'ecc:build-error-resolver',
  release: 'ecc:code-reviewer',
};

/** The user's choice for a stage: an `ecc:` agent to put first, 'none', or null for automatic. */
export function eccOverride(node) {
  const value = node?.eccAgent;
  if (value === undefined || value === null || value === '') return null;
  if (value === 'none') return 'none';
  if (Object.hasOwn(LEGACY_ECC_DEFAULTS, node.id) && LEGACY_ECC_DEFAULTS[node.id] === value) return null;
  return PINNED_NAME.test(value) ? value : null;
}

export const fileIo = {
  readdir: (dir) => fs.readdir(dir),
  readHead: async (file, bytes) => {
    const handle = await fs.open(file, 'r');
    try {
      const buffer = Buffer.alloc(bytes);
      const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  }
};
const message = (error) => String(error?.message ?? error).slice(0, 300);

export function oneLine(text) {
  const clean = String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > MAX_DESCRIPTION_CHARS ? clean.slice(0, MAX_DESCRIPTION_CHARS - 1) + '…' : clean;
}
const unquote = (value) => /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;

/** name and description from a leading YAML block; null when there is none or no name. */
export function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(String(text ?? ''));
  if (!match) return null;
  const lines = match[1].split(/\r?\n/);
  const fields = {};
  for (let index = 0; index < lines.length; index++) {
    const field = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[index]);
    if (!field) continue;
    let value = field[2].trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block = [];
      while (index + 1 < lines.length && /^(\s+\S|\s*$)/.test(lines[index + 1])) block.push(lines[++index].trim());
      value = block.filter(Boolean).join(' ');
    }
    fields[field[1]] = unquote(value);
  }
  return fields.name ? { name: fields.name, description: fields.description ?? '' } : null;
}

function newestVersion(names) {
  const parts = (name) => name.split('.').map(Number);
  return names.filter((name) => VERSION_DIR.test(name)).sort((a, b) => {
    const [x, y] = [parts(a), parts(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  }).at(-1) ?? null;
}
async function readEntries(io, files, limit) {
  const entries = [];
  for (const file of files) {
    if (entries.length >= limit) break;
    let head;
    try { head = await io.readHead(file, HEAD_BYTES); } catch { continue; } // an unreadable entry is skipped
    const meta = parseFrontmatter(head);
    if (!meta || !SAFE_NAME.test(meta.name) || entries.some((entry) => entry.name === 'ecc:' + meta.name)) continue;
    entries.push({ name: 'ecc:' + meta.name, description: oneLine(meta.description) });
  }
  return entries;
}
const listing = async (io, dir) => { try { return (await io.readdir(dir)).sort(); } catch { return []; } };
const emptyCatalog = (error) => ({ version: null, agents: [], skills: [], error });

/** Installed ECC agents and skills (name + one line), newest version, capped. Never throws. */
export async function loadEccCatalog({ root = ECC_ROOT, io = fileIo } = {}) {
  let versions;
  try { versions = await io.readdir(root); }
  catch (error) { return emptyCatalog('ECC 플러그인을 찾을 수 없습니다 (' + root + '): ' + message(error)); }
  const version = newestVersion(versions);
  if (!version) return emptyCatalog('설치된 ECC 버전 폴더가 없습니다 (' + root + ')');
  const base = path.join(root, version);
  try {
    const agentFiles = (await listing(io, path.join(base, 'agents'))).filter((name) => name.endsWith('.md')).map((name) => path.join(base, 'agents', name));
    const skillFiles = (await listing(io, path.join(base, 'skills'))).map((name) => path.join(base, 'skills', name, 'SKILL.md'));
    return { version, agents: await readEntries(io, agentFiles, MAX_AGENTS), skills: await readEntries(io, skillFiles, MAX_SKILLS) };
  } catch (error) {
    return emptyCatalog('ECC 카탈로그를 읽지 못했습니다: ' + message(error));
  }
}

const GENERIC = { label: '스택 미확인', reviewer: 'code-reviewer', resolver: 'build-error-resolver', patterns: ['coding-standards'], testing: [] };
export const STACK_PROFILES = {
  godot: { label: 'Godot/GDScript', reviewer: 'gdscript-reviewer', resolver: null, patterns: ['godot-patterns'], testing: ['godot-testing'] },
  flutter: { label: 'Flutter/Dart', reviewer: 'flutter-reviewer', resolver: 'dart-build-resolver', patterns: ['dart-flutter-patterns', 'flutter-dart-code-review'], testing: [] },
  android: { label: 'Android/Kotlin', reviewer: 'kotlin-reviewer', resolver: 'kotlin-build-resolver', patterns: ['kotlin-patterns', 'android-clean-architecture'], testing: ['kotlin-testing'] },
  swift: { label: 'Swift/iOS', reviewer: 'swift-reviewer', resolver: 'swift-build-resolver', patterns: ['swiftui-patterns', 'swift-concurrency-6-2'], testing: [] },
  react: { label: 'React', reviewer: 'react-reviewer', resolver: 'react-build-resolver', patterns: ['react-patterns'], testing: ['react-testing'] },
  typescript: { label: 'TypeScript', reviewer: 'typescript-reviewer', resolver: 'build-error-resolver', patterns: ['typescript-patterns'], testing: [] },
  javascript: { label: 'JavaScript', reviewer: 'typescript-reviewer', resolver: 'build-error-resolver', patterns: ['frontend-patterns'], testing: [] },
  python: { label: 'Python', reviewer: 'python-reviewer', resolver: null, patterns: ['python-patterns'], testing: ['python-testing'] },
  go: { label: 'Go', reviewer: 'go-reviewer', resolver: 'go-build-resolver', patterns: ['golang-patterns'], testing: ['golang-testing'] },
  rust: { label: 'Rust', reviewer: 'rust-reviewer', resolver: 'rust-build-resolver', patterns: ['rust-patterns'], testing: ['rust-testing'] },
};
const MARKERS = [
  [/^project\.godot$/, 'godot'], [/^pubspec\.yaml$/, 'flutter'], [/^(build|settings)\.gradle(\.kts)?$/, 'android'],
  [/^Cargo\.toml$/, 'rust'], [/^go\.mod$/, 'go'], [/^(pyproject\.toml|requirements\.txt|setup\.py)$/, 'python'],
  [/(\.xcodeproj|\.xcworkspace)$|^Package\.swift$/, 'swift'],
];
// Only for a repository without marker files yet; the first match wins.
const GOAL_HINTS = [
  [/godot|gdscript|고도\s*엔진/i, 'godot'], [/flutter|플러터/i, 'flutter'], [/kotlin|jetpack compose|코틀린/i, 'android'],
  [/swiftui|\bswift\b|스위프트/i, 'swift'], [/react|next\.js/i, 'react'], [/typescript/i, 'typescript'],
  [/python|파이썬/i, 'python'], [/golang/i, 'go'], [/\brust\b/i, 'rust'],
];
const stackLabel = (stacks) => stacks.length ? stacks.map((stack) => STACK_PROFILES[stack]?.label ?? stack).join(' + ') : GENERIC.label;

async function packageStacks(io, workspacePath) {
  try {
    const manifest = JSON.parse(await io.readHead(path.join(workspacePath, 'package.json'), PACKAGE_BYTES));
    const deps = { ...manifest?.dependencies, ...manifest?.devDependencies };
    const found = [...(deps.react ? ['react'] : []), ...(deps.typescript ? ['typescript'] : [])];
    return found.length ? found : ['javascript'];
  } catch {
    return ['javascript'];
  }
}

/** The project's stack from root marker files, else from the goal text of an empty repository. */
export async function detectStack({ workspacePath, goal = '', io = fileIo } = {}) {
  let names = [];
  try { names = workspacePath ? await io.readdir(workspacePath) : []; } catch { names = []; }
  const stacks = [];
  for (const [pattern, stack] of MARKERS) if (names.some((name) => pattern.test(name)) && !stacks.includes(stack)) stacks.push(stack);
  if (names.includes('package.json')) for (const stack of await packageStacks(io, workspacePath)) if (!stacks.includes(stack)) stacks.push(stack);
  if (stacks.length) return { stacks, label: stackLabel(stacks), source: 'files' };
  const hint = GOAL_HINTS.find(([pattern]) => pattern.test(String(goal)));
  if (hint) return { stacks: [hint[1]], label: stackLabel([hint[1]]), source: 'goal' };
  return { stacks: [], label: GENERIC.label, source: 'none' };
}

const STAGE_NAMES = {
  research: '조사', brief: '기획', architecture: '구조 설계', design: '화면 설계', assets: '에셋', build: '구현',
  test: '테스트', policy: '정책 점검', listing: '스토어 자료', internal: '내부 테스트', release: '출시',
};
const BUILD_WORDS = /build|compil|gradle|xcodebuild|cargo|tsc\b|analy[sz]|빌드|컴파일/i;
const TEST_WORDS = /test|spec\b|e2e|테스트/i;

/** Stage, phase, attempt and what failed last, from the node and the job being launched. */
export function situationOf(node, job = {}) {
  const phase = job.phase === 'review' ? 'review' : 'work';
  const attempt = job.attempt ?? (phase === 'review' ? node.reviewAttempts : node.attempts) ?? 1;
  const failures = [node.feedback, node.lastFailure, node.report?.outcome === 'failed' ? node.report : null,
    node.review?.outcome === 'failed' ? node.review : null].filter(Boolean);
  const text = failures.map((failure) => [failure.summary, ...(failure.evidence ?? [])
    .filter((item) => item?.kind === 'command' && item.exitCode !== 0).map((item) => item.command)].join(' ')).join(' ');
  const work = phase === 'work';
  const reviewFailed = work && (node.review?.outcome === 'failed' || node.feedback?.phase === 'review');
  const testFailed = work && (node.feedback?.nodeId === 'test' || TEST_WORDS.test(text));
  const buildFailed = work && BUILD_WORDS.test(text);
  const repair = work && (failures.length > 0 || attempt > 1);
  const notes = [reviewFailed && '검토 실패 후 수정', buildFailed && '빌드 실패 후 수정', testFailed && '테스트 실패 후 수정',
    repair && !reviewFailed && !buildFailed && !testFailed && '재시도'].filter(Boolean);
  const summary = [(STAGE_NAMES[node.id] ?? node.id) + ' ' + (work ? '작업' : '검토') + ' ' + attempt + '회차', ...notes].join(' · ');
  return { stage: node.id, phase, attempt, repair, reviewFailed, buildFailed, testFailed, summary };
}

function stageRules(situation, profiles) {
  const main = profiles[0];
  const patterns = profiles.flatMap((profile) => profile.patterns);
  const testing = profiles.flatMap((profile) => profile.testing);
  const skillsFor = (list, why) => list.map((name) => ['skills', name, why]);
  const label = profiles.map((profile) => profile.label).join(' + ');
  if (situation.phase === 'review') {
    const plain = {
      research: [['agents', 'marketing-agent', '조사 근거와 시장 판단 검토'], ['skills', 'deep-research', '출처 확인']],
      brief: [['agents', 'planner', '범위와 수용 조건 검토'], ['skills', 'product-lens', '제품 관점 점검']],
      design: [['agents', 'a11y-architect', '화면 접근성 검토'], ['skills', 'accessibility', 'WCAG 기준']],
      policy: [['agents', 'security-reviewer', '권한·개인정보 판단 검토'], ['skills', 'security-review', '보안 점검 기준']],
      listing: [['agents', 'seo-specialist', '스토어 문구·검색 노출 검토'], ['skills', 'seo', '검색 노출 기준']],
    };
    if (plain[situation.stage]) return plain[situation.stage];
    return [...profiles.map((profile) => ['agents', profile.reviewer, profile.label + ' 코드 검토']),
      ['agents', 'silent-failure-hunter', '숨은 실패·누락된 오류 처리 점검'],
      ...skillsFor(patterns, label + ' 검토 기준'), ['skills', 'verification-loop', '검증 근거 확인']];
  }
  const rules = {
    research: [['agents', 'marketing-agent', '사용자·시장 조사'], ['skills', 'deep-research', '출처 있는 조사'],
      ['skills', 'market-research', '시장·경쟁 분석'], ['skills', 'competitive-report-structure', '경쟁 앱 비교 정리']],
    brief: [['agents', 'planner', 'MVP 범위와 구현 순서'], ['skills', 'product-lens', '제품 관점 점검'], ['skills', 'blueprint', '요구사항 구조화']],
    architecture: [['agents', 'architect', '구조 설계'], ['agents', 'code-architect', '기존 코드 패턴 분석'],
      ...skillsFor(patterns, label + ' 구조 패턴'), ['skills', 'architecture-decision-records', '설계 결정 기록']],
    design: [['agents', 'a11y-architect', '접근성 있는 화면 설계'], ['skills', 'design-system', '일관된 디자인 토큰'],
      ['skills', 'accessibility', 'WCAG 기준'], ...skillsFor(patterns, label + ' 화면 구현 제약')],
    assets: [...skillsFor(patterns, label + ' 에셋 연결'), ['skills', 'design-system', '에셋 명세 일관성']],
    build: [['agents', 'tdd-guide', '테스트 우선 구현'], ['agents', main.reviewer, main.label + ' 코드 점검'],
      ['agents', main.resolver, main.label + ' 빌드 오류 해결'], ['skills', 'tdd-workflow', '테스트 우선 흐름'],
      ...skillsFor(patterns, label + ' 구현 패턴'), ...skillsFor(testing, label + ' 테스트'), ['skills', 'error-handling', '오류 처리']],
    test: [['agents', 'e2e-runner', '핵심 사용자 흐름 검증'], ['agents', main.reviewer, main.label + ' 결함 분석'],
      ...skillsFor(testing, label + ' 테스트'), ['skills', 'e2e-testing', 'E2E 테스트'], ['skills', 'verification-loop', '검증 근거']],
    policy: [['agents', 'security-reviewer', '권한·개인정보·보안 점검'], ['skills', 'security-review', '보안 점검 기준']],
    listing: [['agents', 'seo-specialist', '스토어 검색 노출'], ['agents', 'marketing-agent', '스토어 문구'],
      ['skills', 'seo', '검색 노출 기준'], ['skills', 'marketing-campaign', '출시 문구']],
    internal: [['agents', main.resolver ?? 'build-error-resolver', '릴리스 빌드 문제 해결'],
      ['skills', 'deployment-patterns', '배포 절차'], ['skills', 'verification-loop', '설치 검증']],
    release: [['agents', main.reviewer, '최종 코드 점검'], ['agents', 'security-reviewer', '출시 전 보안 점검'],
      ['skills', 'production-audit', '출시 준비 점검'], ['skills', 'delivery-gate', '출시 게이트']],
  };
  return rules[situation.stage] ?? [['agents', main.reviewer, main.label + ' 점검'], ...skillsFor(patterns, label + ' 패턴')];
}

/**
 * A handful of installed ECC agents and skills for this situation, most specific first:
 * the user's pin, the failure specialist on a repair, then the stage and stack rules.
 */
export function selectEcc({ catalog, stack, situation, override = null }) {
  const stacks = stack?.stacks ?? [];
  const result = {
    version: catalog?.version ?? null,
    stack: { stacks, label: stack?.label ?? stackLabel(stacks), source: stack?.source ?? 'none' },
    situation, agents: [], skills: [], ...(catalog?.error ? { error: catalog.error } : {})
  };
  if (override === 'none') return { ...result, disabled: true };
  const pools = {
    agents: new Map((catalog?.agents ?? []).map((item) => [item.name, item])),
    skills: new Map((catalog?.skills ?? []).map((item) => [item.name, item])),
  };
  const add = (kind, short, why) => {
    const name = short?.startsWith('ecc:') ? short : 'ecc:' + short;
    if (!short || !pools[kind].has(name) || result[kind].some((item) => item.name === name)) return;
    result[kind].push({ name, why, description: pools[kind].get(name).description });
  };
  if (override) add('agents', override, '사용자가 이 단계에 지정');
  const profiles = stacks.length ? stacks.map((name) => STACK_PROFILES[name] ?? GENERIC) : [GENERIC];
  if (situation.repair) {
    if (situation.buildFailed) add('agents', profiles[0].resolver ?? 'build-error-resolver', '지난 빌드 실패 원인 해결');
    if (situation.reviewFailed) add('agents', 'silent-failure-hunter', '검토에서 지적된 숨은 실패·누락 점검');
    if (situation.testFailed) add('agents', 'tdd-guide', '실패한 테스트를 먼저 재현하고 고치기');
  }
  for (const [kind, short, why] of stageRules(situation, profiles)) add(kind, short, why);
  result.agents = result.agents.slice(0, MAX_SHORTLIST_AGENTS);
  result.skills = result.skills.slice(0, MAX_SHORTLIST_SKILLS);
  return result;
}

/** Cached catalog plus per-launch advice; advice never throws. */
export function createEccAdvisor({ root = ECC_ROOT, io = fileIo, now = Date.now, ttlMs = CATALOG_TTL_MS } = {}) {
  let cached = null;
  const catalog = () => {
    if (cached && now() - cached.at < ttlMs) return cached.pending;
    const pending = loadEccCatalog({ root, io }).catch((error) => emptyCatalog('ECC 카탈로그를 읽지 못했습니다: ' + message(error)));
    cached = { at: now(), pending };
    return pending;
  };
  const advise = async ({ run, node, job }) => {
    const [list, stack] = await Promise.all([catalog(), detectStack({ workspacePath: run?.workspacePath, goal: run?.goal, io })]);
    return selectEcc({ catalog: list, stack, situation: situationOf(node, job), override: eccOverride(node) });
  };
  return { catalog, advise };
}
