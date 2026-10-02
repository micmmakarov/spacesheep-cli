"use strict";
// The old session commands run sessionpipe (lib/sessionpipe.js): the exact argv, the
// order (sink → this CLI's hooks out → install → pair → old listener off), and the key
// never shown.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const sp = require("../lib/sessionpipe");

const KEY = "ss_" + "k".repeat(40);
const NOOP = () => {}; // never the real hook removal: it edits ~/.claude, ~/.codex and ~/.gemini
const O = "https://spacesheep.dev";

test("plan: hooks = sink at tier 2 with the CLI's key, then install; no pairing", () => {
  const p = sp.plan("hooks", {}, KEY, O);
  assert.deepEqual(p.sink, ["sink", "add", O, "--name", "spacesheep", "--tier", "2", "--token", KEY]);
  assert.deepEqual(p.install, ["install"]);
  assert.equal(p.pair, null);
});

test("plan: --no-memory keeps the words home (tier 1); harness and machine flags pass through", () => {
  const p = sp.plan("hooks", { noMemory: true, claude: true, codex: true, antigravity: true, machine: "Misha's Air" }, KEY, O);
  assert.equal(p.sink[6], "1");
  assert.deepEqual(p.install, ["install", "--claude-code", "--codex", "--antigravity", "--machine", "Misha's Air"]);
});

test("plan: machine on pairs in auto mode by default, with folders, name and --no-service", () => {
  const p = sp.plan("machine", { folder: ["/a", "/b"], name: "Box", noService: true }, KEY, O);
  assert.deepEqual(p.pair, ["control", "pair", O, "--mode", "auto", "--folder", "/a", "--folder", "/b", "--name", "Box", "--no-service"]);
  assert.deepEqual(p.install, ["install", "--machine", "Box"]);
  assert.equal(sp.plan("machine", { mode: "safe" }, null, O).pair[4], "safe");
  assert.equal(sp.plan("machine", { mode: "anything" }, null, O).pair[4], "auto");
  assert.equal(sp.plan("machine", {}, null, O).sink, null); // not signed in: the pairing mints the sink
});

test("shown: the key never reaches the screen", () => {
  const line = sp.shown(sp.plan("hooks", {}, KEY, O).sink);
  assert.ok(!line.includes(KEY) && line.includes("--token ss_…"));
});

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-sp-"));
  const keep = { SPACESHEEP_CONFIG_DIR: process.env.SPACESHEEP_CONFIG_DIR, SPACESHEEP_KEY: process.env.SPACESHEEP_KEY };
  process.env.SPACESHEEP_CONFIG_DIR = dir;
  t.after(() => {
    for (const [k, v] of Object.entries(keep)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

test("moveTo hooks: refuses without a key, before running anything", async (t) => {
  sandbox(t);
  delete process.env.SPACESHEEP_KEY;
  const ran = [];
  await assert.rejects(sp.moveTo("hooks", {}, () => {}, { run: (a) => ran.push(a), dropOwnHooks: NOOP, login: null }), /spacesheep login/);
  assert.equal(ran.length, 0);
});

test("moveTo machine: sink, this CLI's hooks out, install, pair, then the old listener off — and a failed pair leaves it on", async (t) => {
  sandbox(t);
  process.env.SPACESHEEP_KEY = KEY;
  const ran = [];
  let off = 0;
  const machine = { readMachine: () => ({ id: "m_x" }), off: async () => { off++; } };
  const dropOwnHooks = () => ran.push("drop");
  await sp.moveTo("machine", {}, () => {}, { run: (a) => ran.push(a[0] === "control" ? "pair" : a[0]), machine, dropOwnHooks });
  assert.deepEqual(ran, ["sink", "drop", "install", "pair"]);
  assert.equal(off, 1);

  const failing = (a) => { if (a[0] === "control") throw new Error("expired"); };
  await assert.rejects(sp.moveTo("machine", {}, () => {}, { run: failing, machine, dropOwnHooks: NOOP }), /expired/);
  assert.equal(off, 1); // the old listener stays until a pairing succeeds
});

test("moveTo hooks: signs in first when there's no key and someone is at the terminal", async (t) => {
  sandbox(t);
  delete process.env.SPACESHEEP_KEY;
  const ran = [];
  const login = async () => { process.env.SPACESHEEP_KEY = KEY; ran.push("login"); };
  await sp.moveTo("hooks", {}, () => {}, { run: (a) => ran.push(a[0]), dropOwnHooks: NOOP, login });
  assert.deepEqual(ran, ["login", "sink", "install"]);
});

test("moveTo: a failed install says how to finish, since this CLI's hooks are already out", async (t) => {
  sandbox(t);
  process.env.SPACESHEEP_KEY = KEY;
  const run = (a) => { if (a[0] === "install") throw new Error("`sessionpipe install` stopped (exit 1)"); };
  await assert.rejects(sp.moveTo("hooks", {}, () => {}, { run, dropOwnHooks: NOOP }), /npx -y sessionpipe@latest install/);
});
