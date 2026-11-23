/**
 * What a person's approval of a gated stage may carry beyond "prepare and review" (runs.approve):
 * an actual Play submission target (internal/release) or the Play Console product catalog they
 * created (catalog, src/catalog.mjs). One gate, two scopes; autonomy never supplies either.
 */
import { productCatalogApproval } from './catalog.mjs';

const invalid = (message) => Object.assign(new Error(message), { code: 'invalid_params' });
const text = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(label + ' 값이 필요합니다 (최대 ' + max + '자).');
  return value.trim();
};

async function submissionScope(input, resolvePlayAccount) {
  if (!['internal', 'release'].includes(input.nodeId)) throw invalid('내부 테스트/출시 단계에서만 실제 제출 대상을 승인할 수 있습니다.');
  const packageName = text(input.submission?.packageName, '제출 패키지', 200);
  const track = text(input.submission?.track, '제출 트랙', 80);
  const versionCode = String(input.submission?.versionCode ?? '');
  if (!/^[A-Za-z]\w*(?:\.[A-Za-z]\w*)+$/.test(packageName) || !/^[1-9]\d{0,9}$/.test(versionCode) || Number(versionCode) > 2100000000) {
    throw invalid('정확한 Android 패키지명과 양의 versionCode가 필요합니다.');
  }
  const expected = input.nodeId === 'internal' ? 'internal' : 'production';
  if (track !== expected) throw invalid('이 단계의 승인 트랙은 ' + expected + '입니다.');
  if (!input.note || input.note.trim().length < 10) throw invalid('실제 제출은 대상과 검증 결과를 확인한 명시적 승인 메모가 필요합니다.');
  if (!resolvePlayAccount) throw Object.assign(new Error('Play 개발자 계정 설정을 불러올 수 없습니다.'), { code: 'unavailable' });
  const { accountId, developerId } = input.submission;
  const account = await resolvePlayAccount({ accountId, developerId, packageName, track });
  return { ...account, packageName, track, versionCode };
}

/**
 * The extra approval fields for `run`'s stage `input.nodeId`, or {} for a plain scope approval.
 * A human-only stage (humanApproval) cannot be approved without its product catalog.
 */
export async function approvalScope(run, input, { resolvePlayAccount, fingerprint }) {
  const node = run.nodes.find((item) => item.id === input.nodeId);
  if (node?.humanApproval || input.productCatalog !== undefined) return productCatalogApproval(run, input);
  if (input.submission === undefined) return {};
  const submission = await submissionScope(input, resolvePlayAccount);
  return { submission, sourceFingerprint: await fingerprint(run.workspacePath) };
}
