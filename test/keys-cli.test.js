"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("child_process");
const path = require("path");
const bin = path.join(__dirname, "..", "bin", "spacesheep.js");
const run = (args, input) => spawnSync(process.execPath, [bin, ...args], { input, encoding: "utf8", env: { ...process.env, SPACESHEEP_CONFIG_DIR: require("fs").mkdtempSync(path.join(require("os").tmpdir(), "ss-keys-")), SPACESHEEP_KEY: "" } });

test("keys create refuses an unknown scope before touching the network", () => {
  const r = run(["keys", "create", "--scope", "root"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--scope takes stream, sessions or full/);
});

test("keys save refuses what isn't a spacesheep key, and prints nothing to stdout", () => {
  const r = run(["keys", "save"], "not-a-key\n");
  assert.notEqual(r.status, 0);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /reads an ss_ key from stdin/);
});

test("keys create without a stored key says how to sign in", () => {
  const r = run(["keys", "create", "--scope", "stream"]);
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not signed in/);
});
