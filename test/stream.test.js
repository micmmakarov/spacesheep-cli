"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { lineValue, parseEvery, resolveButton, buttonsFrom } = require("../lib/stream");

test("a line that is JSON goes as JSON, anything else as text", () => {
  assert.deepEqual(lineValue('{"load":[1,2,3]}'), { load: [1, 2, 3] });
  assert.equal(lineValue("0.52 0.58 0.59 1/389 12345"), "0.52 0.58 0.59 1/389 12345");
  assert.equal(lineValue("42"), 42);
  assert.equal(lineValue("{not json"), "{not json");
  assert.equal(lineValue("   "), undefined);
});

test("--every takes 500ms, 1s, 2.5s, 1m — and never faster than 50 ms", () => {
  assert.equal(parseEvery("500ms"), 500);
  assert.equal(parseEvery("1s"), 1000);
  assert.equal(parseEvery("2.5"), 2500);
  assert.equal(parseEvery("1m"), 60000);
  assert.equal(parseEvery("10ms"), null);
  assert.equal(parseEvery("soon"), null);
});

test("only a listed button runs: --on names, or an executable file in --on-dir", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-stream-"));
  fs.writeFileSync(path.join(dir, "cpu_all"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "notes"), "not executable\n", { mode: 0o644 });
  const b = buttonsFrom({ on: ["stop=pkill stress-ng"], onDir: dir });
  assert.deepEqual(resolveButton(b, "stop"), { shell: "pkill stress-ng" });
  assert.deepEqual(resolveButton(b, "cpu_all"), { file: path.join(dir, "cpu_all") });
  assert.equal(resolveButton(b, "notes"), null);
  assert.equal(resolveButton(b, "rm"), null);
  assert.equal(resolveButton(b, "../etc/passwd"), null);
  assert.equal(resolveButton(b, ".."), null);
  assert.throws(() => buttonsFrom({ on: ["nocommand"] }), /name=command/);
});
