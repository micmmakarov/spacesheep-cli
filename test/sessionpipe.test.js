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

// Exercise the real runner, replacing only subprocess execution (never run npx).
function withSpawn(t, spawn) {
  t.mock.method(require("child_process"), "spawnSync", spawn);
  const file = require.resolve("../lib/sessionpipe");
  const cached = require.cache[file];
  delete require.cache[file];
  const loaded = require(file);
  require.cache[file] = cached;
  return loaded;
}

for (const failure of [{ status: 1 }, { status: null, signal: "SIGTERM" }, { status: null, signal: "SIGINT" }]) {
  test(`pair failure after migration reports completed work and retry (${failure.signal || failure.status})`, async (t) => {
    sandbox(t);
    process.env.SPACESHEEP_KEY = KEY;
    const ran = [], logs = [];
    const runner = withSpawn(t, (_cmd, args) => {
      ran.push(args[2]);
      return args[2] === "control" ? failure : { status: 0 };
    });
    const opts = { mode: "safe", folder: ["/projects/my app", "/other"], name: "My Mac", noService: true };
    await assert.rejects(runner.moveTo("machine", opts, s => logs.push(s), {
      dropOwnHooks: () => ran.push("drop"),
      machine: { readMachine: () => { assert.fail("old listener must stay on after failed pair"); } },
    }), e => {
      assert.match(e.message, /reporting is installed and migrated/);
      assert.match(e.message, /spacesheep's own session hooks are off/);
      assert.match(e.message, /Only pairing remains/);
      assert.ok(e.message.includes('npx -y sessionpipe@latest control pair https://spacesheep.dev --mode safe --folder "/projects/my app" --folder /other --name "My Mac" --no-service'));
      assert.match(e.message, failure.signal ? new RegExp(`signal ${failure.signal}`) : /exit 1/);
      assert.doesNotMatch(e.message, /nothing of spacesheep's own was removed|exit null/);
      return true;
    });
    assert.deepEqual(ran, ["sink", "drop", "install", "control"]);
    assert.ok(!logs.join("\n").includes(KEY));
  });
}

test("sink failure before removal reports nothing removed and hides the key", async (t) => {
  sandbox(t);
  process.env.SPACESHEEP_KEY = KEY;
  const runner = withSpawn(t, () => ({ status: 2 }));
  await assert.rejects(runner.moveTo("machine", {}, NOOP, {
    dropOwnHooks: () => assert.fail("must not remove hooks"),
  }), e => {
    assert.match(e.message, /exit 2.*nothing of spacesheep's own was removed/);
    assert.doesNotMatch(e.message, /reporting is installed|Only pairing remains/);
    assert.ok(!e.message.includes(KEY));
    return true;
  });
});

test("install failure after removal never claims nothing was removed", async (t) => {
  sandbox(t);
  process.env.SPACESHEEP_KEY = KEY;
  let dropped = false;
  const runner = withSpawn(t, (_cmd, args) => ({ status: args[2] === "install" ? 1 : 0 }));
  await assert.rejects(runner.moveTo("machine", {}, NOOP, {
    dropOwnHooks: () => { dropped = true; },
  }), e => {
    assert.equal(dropped, true);
    assert.match(e.message, /own session hooks are already off/);
    assert.match(e.message, /npx -y sessionpipe@latest install/);
    assert.doesNotMatch(e.message, /nothing of spacesheep's own was removed|reporting is installed|Only pairing remains/);
    return true;
  });
});
