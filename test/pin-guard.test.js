"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { deploy, pageTitle, pinMismatch } = require("../lib/deploy");

// A folder's .spacesheep.json pins it to one space. On 2026-09-22 a stale pin put
// a new report over an unrelated brief with no question asked; a page whose
// <title> changed is another document until the caller says otherwise.
test("the page title is read as a reader sees it", () => {
  assert.equal(pageTitle("<html><head><title>  DVFS &amp; leakage\n brief </title></head></html>"), "DVFS & leakage brief");
  assert.equal(pageTitle("<title></title>"), null);
  assert.equal(pageTitle("<p>no title</p>"), null);
});

test("a pin refuses a page with another title and names both ways out", () => {
  const pin = { space: "abc", url: "https://spacesheep.dev/@y/dvfs-brief", page_title: "DVFS brief" };
  const e = pinMismatch(pin, "ET-SoC1 hot line");
  assert.match(e, /pinned to https:\/\/spacesheep\.dev\/@y\/dvfs-brief \("DVFS brief"\)/);
  assert.match(e, /--space https:\/\/spacesheep\.dev\/@y\/dvfs-brief/);
  assert.match(e, /--new/);
});

test("the same page, a pin from before titles were kept, or no pin all pass", () => {
  assert.equal(pinMismatch({ space: "abc", page_title: "DVFS  Brief" }, "dvfs brief"), null);
  assert.equal(pinMismatch({ space: "abc" }, "Anything"), null);
  assert.equal(pinMismatch({}, "Anything"), null);
  assert.equal(pinMismatch({ space: "abc", page_title: "DVFS brief" }, null), null);
});

test("deploy stops before touching the network when the pin names another page", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-pin-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html><head><title>ET-SoC1 hot line</title></head><body>new</body></html>");
  fs.writeFileSync(path.join(dir, ".spacesheep.json"), JSON.stringify({ space: "abc", url: "https://spacesheep.dev/@y/dvfs-brief", page_title: "DVFS brief" }));
  const client = { call: async () => { throw new Error("the network was touched"); } };
  await assert.rejects(deploy(client, dir, {}, () => {}), /pinned to https:\/\/spacesheep\.dev\/@y\/dvfs-brief/);
});

test("--new publishes a new space from a pinned folder and re-pins it to the new page", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-pin-new-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html><head><title>ET-SoC1 hot line</title></head><body>new</body></html>");
  fs.writeFileSync(path.join(dir, ".spacesheep.json"), JSON.stringify({ space: "abc", url: "https://spacesheep.dev/@y/dvfs-brief", page_title: "DVFS brief", title: "DVFS brief" }));
  const calls = [];
  const client = { call: async (name, args) => {
    calls.push([name, args]);
    if (name === "stage_begin") return { upload_url: "https://stage.example/u", plan: "pro", limits: { max_files: 12000 } };
    return { uuid: "new-id", url: "https://spacesheep.dev/@y/et-soc1-hot-line" };
  } };
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ sha: "s1" }) });
  try { await deploy(client, dir, { new: true }, () => {}); } finally { global.fetch = realFetch; }
  const sent = calls.find(([n]) => n === "deploy")[1];
  assert.equal(sent.uuid, undefined);
  assert.equal(sent.title, "ET-SoC1 hot line");
  const pin = JSON.parse(fs.readFileSync(path.join(dir, ".spacesheep.json"), "utf-8"));
  assert.deepEqual({ space: pin.space, url: pin.url, page_title: pin.page_title }, { space: "new-id", url: "https://spacesheep.dev/@y/et-soc1-hot-line", page_title: "ET-SoC1 hot line" });
  // The next plain run from this folder updates the new page, not the brief.
  assert.equal(pinMismatch(pin, "ET-SoC1 hot line"), null);
});

test("in GitHub Actions a retitled site still deploys to its committed pin", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-pin-ci-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html><head><title>Docs v2</title></head><body>new</body></html>");
  fs.writeFileSync(path.join(dir, ".spacesheep.json"), JSON.stringify({ space: "site-id", page_title: "Docs" }));
  const calls = [];
  const client = { call: async (name, args) => {
    calls.push([name, args]);
    if (name === "stage_begin") return { upload_url: "https://stage.example/u", plan: "pro", limits: { max_files: 12000 } };
    return { uuid: "site-id", url: "https://spacesheep.dev/@y/docs" };
  } };
  const realFetch = global.fetch, prev = process.env.GITHUB_ACTIONS;
  global.fetch = async () => ({ ok: true, json: async () => ({ sha: "s1" }) });
  process.env.GITHUB_ACTIONS = "true";
  try { await deploy(client, dir, {}, () => {}); } finally { global.fetch = realFetch; if (prev === undefined) delete process.env.GITHUB_ACTIONS; else process.env.GITHUB_ACTIONS = prev; }
  assert.equal(calls.find(([n]) => n === "deploy")[1].uuid, "site-id");
});
