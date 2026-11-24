// Where an app stands in production, for the Play Store tab's row badge (panel/studio.mjs).
// Test tracks never decide it; their detail stays in the expanded track list.
const ROW = { draft: "draft", not_sent_for_review: "draft", in_review: "in_review", approved_not_published: "approved_not_published",
  not_approved: "rejected", published: "published" };
const RANK = { not_approved: 0, in_review: 1, approved_not_published: 2, draft: 3, not_sent_for_review: 3, unknown: 4 };
const isProduction =name => name === "production" || name.endsWith(":production");
const top = release => Math.max(0, ...release.versionCodes);
// A release with no build yet is work in progress, so it counts as newer than anything already live.
const newness = release => release.versionCodes.length ? top(release) : Infinity;

/**
 * Row statuses, newest first: ["published"]; ["in_review", "published"] while an update waits behind
 * the live release; ["no_production"]; ["unknown"] when the production track is unconfigured or never read.
 * A rejection a newer published or approved release replaced does not show (same rule as summarizeApp).
 */
export function productionStatus(tracks) {
  const candidates = tracks.filter(item => isProduction(item.track));
  const production = candidates.find(item => item.track === "production") ?? candidates[0];
  if (!production) return ["unknown"];
  const releases = production.releases ?? [];
  if (!releases.length) return production.error || !production.observedAt ? ["unknown"] : ["no_production"];
  const live = releases.filter(release => release.state === "published");
  const liveTop = Math.max(0, ...live.map(top));
  const replaced = release => releases.some(newer => ["published", "approved_not_published"].includes(newer.state) && top(newer) > top(release));
  const pending = releases.filter(release => release.state !== "published" &&
    (release.state === "not_approved" ? !replaced(release) : !live.length || newness(release) > liveTop));
  // A rejection nothing replaced always shows; otherwise the newest release, ties ranked like summarizeApp.
  const rejectedFirst = release => release.state === "not_approved" ? 0 : 1;
  const rank = release => Object.hasOwn(RANK, release.state) ? RANK[release.state] : RANK.unknown;
  const newest = pending.toSorted((a, b) => rejectedFirst(a) - rejectedFirst(b) || newness(b) - newness(a) || rank(a) - rank(b))[0];
  return [...(newest ? [Object.hasOwn(ROW, newest.state) ? ROW[newest.state] : "unknown"] : []), ...(live.length ? ["published"] : [])];
}
