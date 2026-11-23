/**
 * What the panel and RPC callers see of the runtime state: the full state, a small summary for
 * every push (Orca drops panel messages over 256 KiB), or the event timeline.
 */
const invalidView = () => Object.assign(new Error('지원되지 않는 실행 조회 형식입니다.'), { code: 'invalid_params' });
// Keep transport payloads small without changing the durable evidence record.
function reportSummary(report) {
  if (!report || typeof report !== 'object') return report;
  const { evidence, ...summary } = report;
  return { ...summary, evidenceCount: Array.isArray(evidence) ? evidence.length : 0 };
}
function nodeSummary(node) {
  const { history, report, review, feedback, lastFailure, receipt, ...summary } = node;
  return {
    ...summary, report: reportSummary(report), review: reportSummary(review),
    ...(feedback === undefined ? {} : { feedback: reportSummary(feedback) }),
    ...(lastFailure === undefined ? {} : { lastFailure: reportSummary(lastFailure) }),
    ...(receipt ? { receipt: {
      path: receipt.path, at: receipt.at, phase: receipt.phase,
      artifactCount: Array.isArray(receipt.artifacts) ? receipt.artifacts.length : 0
    } } : {})
  };
}
function runSummary(run) {
  const { events, acceptedReports, nodes, jobs, ...summary } = run;
  const current = new Set(nodes.flatMap(node => [node.active?.nonce, node.pendingReceipt?.nonce]).filter(Boolean));
  return {
    ...summary, nodes: nodes.map(nodeSummary),
    jobs: (jobs || []).filter(job => current.has(job.nonce)),
    nodeCount: nodes.length, passedCount: nodes.filter(node => node.status === 'passed').length
  };
}
function archiveSummary(run) {
  return {
    id: run.id, goal: run.goal, status: run.status, projectId: run.projectId,
    archivedAt: run.archivedAt, createdAt: run.createdAt, updatedAt: run.updatedAt,
    nodeCount: run.nodes.length, passedCount: run.nodes.filter(node => node.status === 'passed').length
  };
}
function timelineRun(run) {
  return { id: run.id, goal: run.goal, projectId: run.projectId, updatedAt: run.updatedAt, events: run.events || [] };
}
export function projectState(state, view = 'full') {
  if (view === 'full') return state;
  if (view === 'summary') return {
    version: state.version, revision: state.revision, view,
    runs: state.runs.map(runSummary), archivedRuns: state.archivedRuns.map(archiveSummary)
  };
  if (view === 'timeline') return {
    version: state.version, revision: state.revision, view,
    runs: state.runs.map(timelineRun), archivedRuns: state.archivedRuns.map(timelineRun)
  };
  throw invalidView();
}
