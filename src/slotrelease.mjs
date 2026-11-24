/**
 * Roadmap item 6: an assignment whose agent.launch answer never came (state uncertain, no terminal
 * id) holds a Neon slot, because an agent may still be running for it. Only a person who checked
 * Orca and confirmed that no agent runs for it can free the slot; nothing here runs on its own.
 * Who released it and when stay on the job. Pure: returns a new run.
 */
const fail = (code, message) => Object.assign(new Error(message), { code });
const BY = /^[\p{L}\p{N}_ .:@-]{1,60}$/u;

export function releaseUncertainJob(run, { nonce, confirmed, by, at }) {
  if (confirmed !== true) throw fail('invalid_params', 'Orca에서 이 요청으로 실행 중인 에이전트가 없는지 확인한 뒤에만 슬롯을 해제합니다.');
  if (typeof by !== 'string' || !BY.test(by.trim())) throw fail('invalid_params', '누가 확인했는지(by)를 60자 이하로 주세요.');
  if (typeof nonce !== 'string' || !nonce) throw fail('invalid_params', '해제할 배정(nonce)을 주세요.');
  const next = structuredClone(run);
  const job = (next.jobs ?? []).find((item) => item.nonce === nonce);
  if (!job) throw fail('invalid_params', '해당 배정을 찾을 수 없습니다.');
  if (job.terminalId) throw fail('conflict', '터미널 ID가 있는 배정은 터미널 종료로 정리합니다. 이 버튼은 터미널 ID가 없는 배정만 해제합니다.');
  if (job.state !== 'uncertain') throw fail('conflict', '시작 여부가 불명확한 배정만 해제할 수 있습니다.');
  job.state = 'released';
  job.released = { by: by.trim(), at };
  const node = next.nodes.find((item) => item.id === job.nodeId);
  if (node?.pendingReceipt?.nonce === nonce) delete node.pendingReceipt;
  if (node?.launchUncertain?.nonce === nonce) delete node.launchUncertain;
  if (node?.active?.nonce === nonce) node.active = null;
  if (node && next.status !== 'cancelled') node.runtimeMessage = '사람이 Orca에서 확인하고 이 배정의 슬롯을 해제했습니다. 필요하면 이 단계를 다시 시도하세요.';
  const left = (next.jobs ?? []).some((item) => !item.terminalId && item.state === 'uncertain');
  if (!left && Array.isArray(next.stopFailures)) next.stopFailures = next.stopFailures.filter((item) => item.code !== 'uncertain');
  return { run: next, nodeId: job.nodeId, message: (node?.title ?? job.nodeId) + ': 사람이 확인하고 터미널 ID가 없는 불명확 배정의 슬롯을 해제했습니다 (' + by.trim() + ', ' + at + ').' };
}
