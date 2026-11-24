/**
 * 다른 PC용 기록 내보내기 (src/historyexport.mjs): a button on each finished run, and the question
 * the person must answer when the target repository's visibility could not be read. Nothing is
 * exported without pressing the button.
 */
import { e, button } from './kit.mjs';

const CODE = /^\[([a-z_]+)\]\s*/;

/** The export button of `runId`, with the pending confirmation when it belongs to this run. */
export function exportControls(runId, pending, title = '') {
  const named = (text) => 'aria-label="' + e(text + (title ? ': ' + title : '')) + '"';
  const asking = pending?.runId === runId
    ? '<div class="callout warning" role="alert"><p>' + e(pending.message) + '</p>' +
      button('비공개임을 확인했습니다 · 내보내기', 'export-history', 'data-run="' + e(runId) + '" data-confirm="true" ' + named('비공개임을 확인했습니다 · 내보내기'), 'small') + '</div>' : '';
  return button('다른 PC용 기록 내보내기', 'export-history', 'data-run="' + e(runId) + '" ' + named('다른 PC용 기록 내보내기'), 'small') + asking;
}

/** Runs one export; { pending } when the person must confirm first, else { message } for the toast. Other refusals are thrown. */
export async function exportHistory({ runId, confirm, request }) {
  try {
    const result = await request('history.export', { runIds: [runId], ...(confirm ? { confirmUnknownVisibility: true } : {}) });
    if (!result.exported.length) return { pending: null, message: '내보내지 않았습니다: ' + (result.skipped[0]?.reason ?? '대상이 없습니다.') };
    return { pending: null, message: '내보낸 시점의 스냅샷을 ' + result.folder + '/' + runId + '에 저장했습니다(index.html, run.json).' };
  } catch (error) {
    const message = String(error?.message ?? error);
    if (CODE.exec(message)?.[1] === 'confirmation_required') return { pending: { runId, message: message.replace(CODE, '') }, message: '내보내기 전에 저장소 공개 여부를 확인해 주세요.' };
    throw Object.assign(new Error(message.replace(CODE, '')), { code: error?.code });
  }
}
