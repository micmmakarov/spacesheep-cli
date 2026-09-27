"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { fileCapError, FALLBACK_MAX_FILES } = require("../lib/deploy");

// The cap comes from the server's stage_begin answer, never from a number kept
// here: the copy this file used to carry (7,000) went stale against the server's
// Pro cap (12,000) and refused a site the plan allowed.
test("a tree within the account's cap passes", () => {
  assert.equal(fileCapError(11206, { plan: "pro", limits: { max_files: 12000 } }), null);
  assert.equal(fileCapError(200, { plan: "free", limits: { max_files: 200 } }), null);
  assert.equal(fileCapError(12000, { plan: "pro", limits: { max_files: 12000 } }), null);
});

test("a tree over the cap is refused with the plan and the cap named", () => {
  const pro = fileCapError(12001, { plan: "pro", limits: { max_files: 12000 } });
  assert.match(pro, /^12,001 files — the Pro plan holds at most 12,000 per space; deploy the built output/);
  assert.doesNotMatch(pro, /pricing/);
  const free = fileCapError(5279, { plan: "free", limits: { max_files: 200 } });
  assert.match(free, /the Free plan holds at most 200 per space \(Pro holds 12,000 — spacesheep\.dev\/pricing\)/);
});

test("a server older than the field falls back to the Pro cap, and only refuses what no plan allows", () => {
  assert.equal(FALLBACK_MAX_FILES, 12000);
  assert.equal(fileCapError(11206, { upload_url: "https://x" }), null);
  assert.match(fileCapError(12001, { upload_url: "https://x" }), /this plan holds at most 12,000/);
  assert.match(fileCapError(12001, null), /this plan holds at most 12,000/);
  assert.equal(fileCapError(5000, { plan: "pro", limits: { max_files: "nonsense" } }), null);
});
