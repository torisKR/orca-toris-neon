/**
 * What the design, performance and release improvements must prove (plan 4.2), beyond the stage
 * brief: the instruction per kind and stage, the report fields that carry the proof (screenshot
 * conditions, measurements, the release link), and the passed work reports that must carry them.
 * Pure: a run in, text or a normalized field out. Refusals are report-form errors the agent fixes.
 */
import { REPORT_LIMITS, CONDITION_KEYS } from './reportlimits.mjs';

const fail = (message) => { throw Object.assign(new Error(message), { code: 'invalid_report' }); };
const text = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(label + ' 값이 필요합니다(최대 ' + max + '자).');
  return value.trim();
};
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => String(a).replace(/\s+/g, ' ').trim() === String(b).replace(/\s+/g, ' ').trim();

const APP_MARKER = /^(project\.godot|pubspec\.yaml|(build|settings)\.gradle(\.kts)?|android|ios)$/;
const APP_DEPENDENCIES = ['react-native', 'expo', '@capacitor/core', '@capacitor/android', 'cordova-android'];
const MANIFEST_BYTES = 64 * 1024;
/**
 * 'web' only for a package.json project with no app marker at the root (Godot, Flutter, Gradle, an
 * android/ or ios/ folder) and no mobile-app dependency (React Native, Expo, Capacitor, Cordova);
 * 'app' when one is found; null when the folder or its package.json cannot be read, which keeps
 * the Play stages. `io` is { readdir, readHead } (src/ecc.mjs fileIo).
 */
export async function projectPlatform(root, io) {
  let names;
  try { names = await io.readdir(root); } catch { return null; }
  if (names.some((name) => APP_MARKER.test(name))) return 'app';
  if (!names.includes('package.json')) return null;
  let manifest;
  try { manifest = JSON.parse(await io.readHead(root.replace(/\/+$/, '') + '/package.json', MANIFEST_BYTES)); } catch { return null; }
  const dependencies = { ...manifest?.dependencies, ...manifest?.devDependencies };
  return APP_DEPENDENCIES.some((name) => Object.hasOwn(dependencies, name)) ? 'app' : 'web';
}
export const WEB_NOTE = '웹 프로젝트입니다: APK/AAB, versionCode, 서명, Play에 관한 지시는 해당하지 않습니다. 프로젝트의 웹 빌드·테스트 명령으로 검증하세요.';
export const WEB_RELEASE_DONE = '웹 프로젝트이므로 Play 정책·스토어·제출 단계 없이, 마지막 검증 이후 바뀐 부분을 다시 검증하는 것까지가 이 실행의 범위입니다. 배포는 프로젝트의 배포 절차로 사람이 진행합니다.';

export { CONDITION_KEYS }; // screenshot conditions: what must be the same before and after for a fair comparison
function conditionsOf(value, label) {
  if (!object(value)) fail(label + '은(는) {"device", "size", "language", "data"} 객체여야 합니다.');
  return Object.fromEntries(CONDITION_KEYS.map((key) => [key, text(value[key], label + '.' + key, REPORT_LIMITS.condition)]));
}
function comparisonOf(value) {
  if (!object(value) || (value.before === undefined && value.after === undefined)) fail('comparison은 {"before": 촬영 조건} 또는 {"after": 촬영 조건}을 담은 객체여야 합니다.');
  return { ...(value.before === undefined ? {} : { before: conditionsOf(value.before, 'comparison.before') }),
    ...(value.after === undefined ? {} : { after: conditionsOf(value.after, 'comparison.after') }) };
}

const MAX_SAMPLES = REPORT_LIMITS.samples;
const MAX_METRICS = REPORT_LIMITS.metrics;
function metricOf(item, samples) {
  if (!object(item)) fail('measurement.metrics의 항목은 객체여야 합니다.');
  const name = text(item.name, '지표 name', 80);
  if (!['lower', 'higher'].includes(item.better)) fail('지표 ' + name + '의 better는 lower(작을수록 좋음) 또는 higher(클수록 좋음)여야 합니다.');
  if (!Array.isArray(item.values) || item.values.length !== samples || !item.values.every(Number.isFinite)) {
    fail('지표 ' + name + '의 values는 samples(' + samples + ')개의 실제 측정 숫자 배열이어야 합니다.');
  }
  return { name, unit: text(item.unit, '지표 ' + name + '의 unit', 20), better: item.better, values: [...item.values] };
}
function measurementOf(value) {
  if (!object(value)) fail('measurement는 {"scenario", "environment", "samples", "metrics"} 객체여야 합니다.');
  const { samples } = value;
  if (!Number.isInteger(samples) || samples < 1 || samples > MAX_SAMPLES) fail('measurement.samples는 실제로 잰 횟수(1~' + MAX_SAMPLES + ' 정수)여야 합니다.');
  if (!Array.isArray(value.metrics) || !value.metrics.length || value.metrics.length > MAX_METRICS) fail('measurement.metrics는 1~' + MAX_METRICS + '개의 지표 배열이어야 합니다.');
  const metrics = value.metrics.map((item) => metricOf(item, samples));
  if (new Set(metrics.map((item) => item.name)).size !== metrics.length) fail('measurement.metrics의 지표 이름이 중복됩니다.');
  return { scenario: text(value.scenario, 'measurement.scenario', REPORT_LIMITS.measurementText), environment: text(value.environment, 'measurement.environment', REPORT_LIMITS.measurementText), samples, metrics };
}

const COMMIT = /^[0-9a-f]{7,40}$/i;
const PACKAGE = /^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/;
const MAX_VERSION_CODE = 2_100_000_000;
function releaseLinkOf(value) {
  if (!object(value)) fail('releaseLink는 {"commit", "artifact", "packageName", "track", "versionCode"} 객체여야 합니다.');
  const commit = text(value.commit, 'releaseLink.commit', 40);
  if (!COMMIT.test(commit)) fail('releaseLink.commit은 빌드한 소스의 Git 커밋 해시(7~40자리 16진수)여야 합니다.');
  const packageName = text(value.packageName, 'releaseLink.packageName', 200);
  if (!PACKAGE.test(packageName)) fail('releaseLink.packageName이 Android 패키지 이름 형식이 아닙니다.');
  const versionCode = String(value.versionCode ?? '');
  if (!/^[1-9]\d{0,9}$/.test(versionCode) || Number(versionCode) > MAX_VERSION_CODE) fail('releaseLink.versionCode는 양의 정수여야 합니다.');
  if (value.sha256 !== undefined && !/^[0-9a-f]{64}$/i.test(String(value.sha256))) fail('releaseLink.sha256은 64자리 16진수여야 합니다.');
  return { commit, artifact: text(value.artifact, 'releaseLink.artifact', 1000), ...(value.sha256 === undefined ? {} : { sha256: String(value.sha256).toLowerCase() }),
    packageName, track: text(value.track, 'releaseLink.track', 80), versionCode };
}

const KIND_FIELDS = ['comparison', 'measurement', 'releaseLink'];
/**
 * The kind proof fields of a passed report, normalized; absent or null fields stay absent. A report
 * that did not pass carries no proof, so whatever it wrote there is dropped rather than refused.
 */
export function kindFieldsOf(report) {
  if (report.outcome !== 'passed') return Object.fromEntries(KIND_FIELDS.filter((key) => key in report).map((key) => [key, undefined]));
  report = Object.fromEntries(Object.entries(report).filter(([key, value]) => !(KIND_FIELDS.includes(key) && value === null)));
  return {
    ...(report.comparison === undefined ? {} : { comparison: comparisonOf(report.comparison) }),
    ...(report.measurement === undefined ? {} : { measurement: measurementOf(report.measurement) }),
    ...(report.releaseLink === undefined ? {} : { releaseLink: releaseLinkOf(report.releaseLink) }),
  };
}

const IMAGE = /\.(png|jpe?g|webp|gif)$/i;
const reportOf = (run, id) => run.nodes.find((node) => node.id === id && node.status === 'passed')?.report ?? null;
function designProof(nodeId, report) {
  const images = report.evidence.filter((item) => item.kind === 'artifact' && IMAGE.test(item.path));
  if (images.some((item) => !item.label)) fail('이미지 artifact마다 label이 필요합니다: 실제 앱 화면은 "screenshot", 디자인 시안은 "mockup"(시안).');
  if (!images.some((item) => item.label === 'screenshot')) fail('실제 앱을 실행해 캡처한 화면(label "screenshot")이 한 장 이상 필요합니다. 시안(mockup)은 실제 화면을 대신하지 않습니다.');
  const side = nodeId === 'design' ? 'before' : 'after';
  if (!report.comparison?.[side]) fail('"comparison": {"' + side + '": {"device", "size", "language", "data"}}에 ' + (side === 'before' ? '변경 전' : '변경 후') + ' 촬영 조건을 적으세요.');
}
function performanceProof(run, nodeId, report) {
  if (!report.measurement) fail('"measurement"에 측정 시나리오·환경·표본 수·실제 측정값을 적으세요.');
  const baseline = nodeId === 'test' ? reportOf(run, 'measure')?.measurement : null;
  if (!baseline) return;
  const after = report.measurement;
  if (!same(after.scenario, baseline.scenario) || !same(after.environment, baseline.environment) || after.samples !== baseline.samples) {
    fail('재측정은 기준 측정과 같은 조건이어야 합니다: scenario "' + baseline.scenario + '", environment "' + baseline.environment + '", samples ' + baseline.samples +
      '. 같은 조건으로 쟀다면 이 값을 그대로 적고, 같은 조건으로 잴 수 없으면 outcome failed와 failureClass "external"로 보고하세요.');
  }
  const missing = baseline.metrics.filter((metric) => !after.metrics.some((item) => item.name === metric.name)).map((metric) => metric.name);
  if (missing.length) fail('기준 측정의 지표를 모두 다시 재야 합니다: ' + missing.join(', '));
  const changed = baseline.metrics.filter((metric) => after.metrics.some((item) => item.name === metric.name && (item.unit !== metric.unit || item.better !== metric.better)));
  if (changed.length) fail('재측정 지표의 unit과 better는 기준 측정과 같아야 합니다: ' + changed.map((metric) => metric.name + '(' + metric.unit + ', ' + metric.better + ')').join(', '));
}
const SUBMISSION_STAGES = new Set(['internal', 'release']);
/** Refuses a passed work report of a design, performance or release improvement that lacks its proof. */
export function requireKindProof(run, nodeId, report) {
  if (run.template !== 'improve' || report.phase !== 'work' || report.outcome !== 'passed') return;
  const kind = run.improvement?.kind;
  if (kind === 'design' && ['design', 'test'].includes(nodeId)) designProof(nodeId, report);
  if (kind === 'performance' && ['measure', 'test'].includes(nodeId)) performanceProof(run, nodeId, report);
  if (kind === 'release' && SUBMISSION_STAGES.has(nodeId) && !report.releaseLink) {
    fail('"releaseLink": {"commit", "artifact", "packageName", "track", "versionCode"}로 이 빌드의 소스 커밋과 아티팩트, 대상을 연결하세요.');
  }
}

const CONDITIONS_SHAPE = '{"device": "기기·OS", "size": "화면 크기(해상도·글꼴 배율)", "language": "언어·지역(예: ko-KR)", "data": "화면에 쓴 데이터(예: 샘플 식물 3개)"}';
const MEASUREMENT_SHAPE = '"measurement": {"scenario": "측정 시나리오", "environment": "기기·OS·빌드 종류·데이터 양", "samples": 잰 횟수, "metrics": [{"name": "지표", "unit": "ms", "better": "lower 또는 higher", "values": [잰 값 samples개]}]}';
const RELEASE_LINK_SHAPE = '"releaseLink": {"commit": "빌드한 소스 커밋 전체 해시", "artifact": "실제로 올린(올릴) AAB/APK의 작업 공간 기준 경로", "sha256": "아티팩트 SHA-256", "packageName": "패키지명", "track": "트랙", "versionCode": 정수}';

function designWork(run, node) {
  if (node.id === 'design') {
    return ['디자인 개선 증거: 바뀔 화면을 실제 앱에서 캡처해 artifact label "screenshot"으로, 새로 만든 시안 이미지는 label "mockup"(시안)으로 붙이세요. 시안을 실제 화면처럼 표시하지 마세요.',
      '변경 전 촬영 조건(기기·화면 크기·언어·데이터)을 정해 "comparison": {"before": ' + CONDITIONS_SHAPE + '}로 적으세요. 변경 후 화면은 같은 조건으로 다시 찍습니다.'].join('\n');
  }
  if (node.id !== 'test') return '';
  const before = reportOf(run, 'design')?.comparison?.before;
  return ['디자인 개선 증거: 변경 후 실제 앱 화면을 변경 전과 같은 기기·화면 크기·언어·데이터로 캡처해 label "screenshot"으로 붙이고, 실제 촬영 조건을 "comparison": {"after": ' + CONDITIONS_SHAPE + '}로 적으세요.',
    before ? '변경 전 촬영 조건: ' + JSON.stringify(before) : '변경 전 촬영 조건이 기록되지 않았습니다. 변경 전 화면과 무엇이 같은지 적으세요.',
    '조건을 맞출 수 없으면 실제 조건을 그대로 적으세요. 결과 카드가 조건 불일치를 표시합니다.'].join('\n');
}
function performanceWork(run, node) {
  if (node.id === 'measure') return '성능 기준선 기록: ' + MEASUREMENT_SHAPE + '를 보고서에 적으세요. 평균만 적지 말고 실제로 잰 값을 모두 적고, 추정치는 넣지 마세요.';
  if (node.id !== 'test') return '';
  const base = reportOf(run, 'measure')?.measurement;
  if (!base) return '같은 조건 재측정: 기준 측정이 없으니 ' + MEASUREMENT_SHAPE + '로 잰 값만 적으세요. 개선율은 직접 적지 마세요.';
  return ['같은 조건 재측정: 기준 측정과 같은 시나리오·환경·표본 수로 다시 재고 같은 지표 이름으로 ' + MEASUREMENT_SHAPE + '를 적으세요.',
    '기준 측정: 시나리오 "' + base.scenario + '" · 환경 "' + base.environment + '" · 표본 ' + base.samples + '회 · 지표 ' + base.metrics.map((item) => item.name + '(' + item.unit + ', ' + item.better + ')').join(', '),
    'scenario·environment 문자열은 그대로 복사하세요. 같은 조건으로 잴 수 없으면 outcome failed와 failureClass "external"로 보고하세요. 개선율은 Neon이 두 측정에서 계산하니 직접 적지 마세요.'].join('\n');
}
function releaseWork(run, node) {
  if (SUBMISSION_STAGES.has(node.id)) return '출시 연결: ' + RELEASE_LINK_SHAPE + '를 보고서에 적으세요. Neon이 그 파일을 직접 읽어 해시·패키지·versionCode·서명 인증서를 승인한 대상과 대조하고, 다르면 이 단계를 멈춥니다. 계정은 사용자의 승인에서 연결합니다. 실제 제출은 사용자가 승인한 대상에만 하고, 승인이 없으면 준비만 합니다.';
  if (node.id !== 'test') return '';
  const last = run.improvement?.lastVerified;
  if (!last?.commit) return '변경 재검증: 이 프로젝트에 검증을 통과한 이전 실행 기록이 없어 전체를 다시 검증합니다.';
  return ['변경 재검증: 마지막으로 검증을 통과한 커밋 ' + last.commit.slice(0, 12) + '(실행 ' + last.runId + (last.at ? ', ' + last.at : '') + ') 이후 바뀐 것만 다시 검증하세요.',
    '`git diff --stat ' + last.commit + '..HEAD`로 범위를 정하고, 바뀐 영역의 테스트와 릴리스 빌드는 반드시 실행하세요. 다시 실행하지 않은 검증은 "notVerified"에 적으세요.',
    '그 커밋을 이 저장소에서 찾을 수 없으면 전체를 다시 검증하세요.'].join('\n');
}
const WORK = { design: designWork, performance: performanceWork, release: releaseWork };
const REVIEW = {
  design: '검토: 작업 보고서의 screenshot이 실제 앱 화면이고 mockup이 시안으로 표시됐는지, comparison의 촬영 조건이 이미지와 맞는지 확인하세요.',
  performance: '검토: measurement의 값이 실제 측정 기록(로그·명령 출력)과 맞는지, 재측정이 기준과 같은 조건인지 확인하세요.',
  release: '검토: releaseLink의 커밋·아티팩트·패키지·트랙·versionCode가 실제 빌드와 일치하는지 확인하세요.',
};

/** The kind's extra instruction for this stage; '' outside the design, performance and release kinds. */
export function kindInstruction(run, node, job) {
  const kind = run?.template === 'improve' ? run.improvement?.kind : null;
  const work = WORK[kind]?.(run, node) ?? '';
  if (!work) return '';
  return job?.phase === 'review' ? REVIEW[kind] : work;
}
