/**
 * The Play product catalog of an update with payments: what the person must create in Play Console,
 * the one notice autonomy sends when it reaches that gate, and the approval that records what the
 * person confirmed. Creating or changing products, merchant accounts, AdMob links and uploads are
 * never done by the plugin; this is the same approval gate as an actual submission (runs.approve).
 */
const TYPE_LABELS = { inapp: '일회성(inapp)', subs: '구독(subs)' };
const invalid = (message) => Object.assign(new Error(message), { code: 'invalid_params' });
const nodeOf = (run, id) => (run.nodes ?? []).find((node) => node.id === id);
const passedProducts = (report) => report?.outcome === 'passed' && Array.isArray(report.products) ? report.products : null;

/** The products to create: the passed monetization report's list, else the plan's proposal. */
export function proposedProducts(run) {
  return passedProducts(nodeOf(run, 'monetization')?.report) ?? passedProducts(nodeOf(run, 'plan')?.report) ?? [];
}

const productLine = (item) => '· ' + item.productId + ' — ' + (TYPE_LABELS[item.type] ?? item.type) + ', ' + item.price +
  (item.basePlanId ? ', 기본 요금제 ' + item.basePlanId : '') + (item.title ? ' (' + item.title + ')' : '');

/** One notification: exactly what to do in Play Console and what waits on it. */
export function catalogNotice(run) {
  const products = proposedProducts(run);
  const ads = /광고|admob|\bads?\b/i.test(String(nodeOf(run, 'plan')?.report?.summary ?? '') + ' ' + String(nodeOf(run, 'monetization')?.report?.summary ?? ''));
  const lines = [
    '결제 구현과 테스트 상품 검증을 마쳤습니다. Play Console에서 직접 해 주세요:',
    '1) 판매자 계정(결제 프로필)이 연결됐는지 확인',
    products.length ? '2) 상품 생성·활성화:\n' + products.slice(0, 8).map(productLine).join('\n') + (products.length > 8 ? '\n· 외 ' + (products.length - 8) + '개(패널에서 확인)' : '')
      : '2) 등록할 상품 제안이 없습니다. 결제 연동 보고서를 확인하세요.',
    ...(ads ? ['3) AdMob 앱 연결과 실제 광고 단위 생성'] : []),
    '등록 후 패널의 "Play 상품 등록(사용자)" 단계에서 상품 ID를 확인해 승인하면 내부 테스트 준비와 출시 검토가 이어집니다.',
  ];
  return lines.join('\n').slice(0, 900);
}

/** runs.approve for the catalog stage: every proposed product must be confirmed, with a note. */
export function productCatalogApproval(run, input) {
  if (input.nodeId !== 'catalog' || !nodeOf(run, 'catalog')?.humanApproval) throw invalid('상품 등록 확인은 "Play 상품 등록(사용자)" 단계에서만 승인할 수 있습니다.');
  const confirmed = input.productCatalog?.confirmed;
  if (!Array.isArray(confirmed) || confirmed.some((id) => typeof id !== 'string')) throw invalid('Play Console에 등록한 상품 ID 목록이 필요합니다.');
  const products = proposedProducts(run);
  const missing = products.filter((item) => !confirmed.includes(item.productId)).map((item) => item.productId);
  if (missing.length) throw invalid('아직 확인하지 않은 상품이 있습니다: ' + missing.join(', '));
  if (typeof input.note !== 'string' || input.note.trim().length < 10) throw invalid('무엇을 등록했는지 적은 승인 메모(10자 이상)가 필요합니다.');
  return { productCatalog: { products, confirmedAt: new Date().toISOString() } };
}
