import test from "node:test";
import assert from "node:assert/strict";
import { productionStatus } from "../src/playstatus.mjs";
import { summarizeApp } from "../src/play.mjs";

const track = (name, releases, extra = {}) => ({ track: name, releases, observedAt: "2026-11-24T00:00:00.000Z", stale: false, error: null, ...extra });
const r = (state, code) => ({ name: state, state, versionCodes: code === undefined ? [] : [code] });

test("each production lifecycle state maps to the row status", () => {
  const cases = [["draft", "draft"], ["not_sent_for_review", "draft"], ["in_review", "in_review"], ["published", "published"],
    ["not_approved", "rejected"], ["approved_not_published", "approved_not_published"], ["unknown", "unknown"]];
  for (const [state, expected] of cases) {
    assert.deepEqual(productionStatus([track("production", [r(state, 5)])]), [expected], state);
  }
});

test("only production releases decide: an internal draft does not hide a published production release", () => {
  const tracks = [track("production", [r("published", 3)]), track("internal", [r("draft", 4)])];
  assert.deepEqual(productionStatus(tracks), ["published"]);
});

test("only production releases decide: a test track in review does not hide a production draft", () => {
  const tracks = [track("beta", [r("in_review", 6)]), track("production", [r("draft", 5)])];
  assert.deepEqual(productionStatus(tracks), ["draft"]);
});

test("a newer production release shows its state first and keeps the live release", () => {
  for (const [state, expected] of [["in_review", "in_review"], ["draft", "draft"], ["approved_not_published", "approved_not_published"], ["not_approved", "rejected"]]) {
    assert.deepEqual(productionStatus([track("production", [r("published", 9), r(state, 10)])]), [expected, "published"], state);
  }
});

test("a release without a build yet counts as newer than the live release", () => {
  assert.deepEqual(productionStatus([track("production", [r("published", 9), r("draft")])]), ["draft", "published"]);
});

test("a rejection replaced by a newer published or approved release does not show", () => {
  assert.deepEqual(productionStatus([track("production", [r("not_approved", 2), r("published", 3)])]), ["published"]);
  assert.deepEqual(productionStatus([track("production", [r("not_approved", 2), r("approved_not_published", 3)])]), ["approved_not_published"]);
});

test("an unreplaced rejection shows even when a newer draft exists", () => {
  assert.deepEqual(productionStatus([track("production", [r("published", 5), r("not_approved", 7), r("draft", 8)])]), ["rejected", "published"]);
});

test("pending releases of the same age rank by state, not by the order Google listed them", () => {
  assert.deepEqual(productionStatus([track("production", [r("draft"), r("in_review")])]), ["in_review"]);
  assert.deepEqual(productionStatus([track("production", [r("in_review"), r("draft")])]), ["in_review"]);
  assert.deepEqual(productionStatus([track("production", [r("approved_not_published", 4), r("in_review", 4)])]), ["in_review"]);
});

test("no production release reads as no production; an unobserved or unconfigured production track stays unknown", () => {
  assert.deepEqual(productionStatus([track("production", []), track("internal", [r("published", 1)])]), ["no_production"]);
  assert.deepEqual(productionStatus([track("production", [], { observedAt: null, stale: true })]), ["unknown"]);
  assert.deepEqual(productionStatus([track("production", [], { error: { message: "denied" } })]), ["unknown"]);
  assert.deepEqual(productionStatus([track("internal", [r("published", 1)])]), ["unknown"]);
});

test("plain production wins over a form-factor production track; a form-factor track alone is used", () => {
  const tracks = [track("wear:production", [r("in_review", 4)]), track("production", [r("published", 3)])];
  assert.deepEqual(productionStatus(tracks), ["published"]);
  assert.deepEqual(productionStatus([track("wear:production", [r("in_review", 4)])]), ["in_review"]);
});

test("a stale production lookup still reports its cached releases for the row to mark with the check badge", () => {
  assert.deepEqual(productionStatus([track("production", [r("published", 3)], { stale: true })]), ["published"]);
});

test("the app summary carries the production status beside the unchanged all-track status", () => {
  const summary = summarizeApp([track("production", [r("published", 3)]), track("internal", [r("draft", 4)])]);
  assert.deepEqual(summary.production, ["published"]);
  assert.equal(summary.status, "draft");
  assert.equal(summary.published, true);
});
