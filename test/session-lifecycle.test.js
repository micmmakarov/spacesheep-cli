"use strict";
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "ss-lifecycle-"));
process.env.HOME = home;
process.env.SPACESHEEP_CONFIG_DIR = path.join(home, "cfg");
process.env.SPACESHEEP_KEY = "ss_test_lifecycle";
const sessions = require("../lib/sessions");
const memory = require("../lib/memory");
const originalFetch = global.fetch;
let sent = [];
global.fetch = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return { ok: true, json: async () => ({ ok: true }) }; };
after(() => { global.fetch = originalFetch; fs.rmSync(home, { recursive: true, force: true }); });
const old = "2026-09-19T05:16:56Z";
const now = Date.parse("2026-09-28T18:41:36Z");
function transcript(id, at = old) {
  const file = path.join(home, id + ".jsonl");
  const records = [
    { type: "user", timestamp: old, message: { content: "Fix it" } },
    { type: "assistant", timestamp: at, message: { content: [{ type: "text", text: "Fixed." }] } },
    // Teardown metadata must not refresh the transcript clock.
    { type: "system", timestamp: new Date(now).toISOString(), subtype: "stop_hook_summary" },
  ];
  fs.writeFileSync(file, records.map(JSON.stringify).join("\n") + "\n");
  return file;
}
async function job(command, data) {
  const file = path.join(home, "job.json");
  fs.writeFileSync(file, JSON.stringify(data));
  await command(["--child", file]);
}
const cursor = (id) => path.join(home, "cfg", "memory", "claude-code", id + ".cursor");

test("ping posts explicit event at and transcript dates, excluding shutdown metadata", async () => {
  sent = [];
  await job(sessions.ping, { source: "claude-code", session_id: "dates", event: "stop", at: now, transcript: transcript("dates") });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.at, Date.parse(old));
  assert.equal(sent[0].body.last_at, Date.parse(old));
  assert.equal(sent[0].body.started_at, Date.parse(old));
});

test("a ping without a readable transcript still carries the captured event time", async () => {
  sent = [];
  await job(sessions.ping, { source: "claude-code", session_id: "missing", event: "stop", at: now });
  assert.equal(sent[0].body.at, now);
  assert.equal(sent[0].body.last_at, undefined);
});

test("17 warm archived sessions stop/end in one second: no ingestion and no fresh cursors", async () => {
  sent = [];
  for (let i = 0; i < 17; i++) {
    const id = "archived-" + i;
    const file = transcript(id);
    for (const event of ["Stop", "SessionEnd"]) {
      await job(memory.sync, { source: "claude-code", sessionId: id, transcript: file, event, at: now });
    }
    assert.equal(fs.existsSync(cursor(id)), false);
  }
  assert.deepEqual(sent, []);
});

test("a real completed turn syncs; its repeated stop/end preserves the cursor", async () => {
  sent = [];
  const id = "live";
  const file = transcript(id, new Date(now - 1000).toISOString());
  const data = { source: "claude-code", sessionId: id, transcript: file, event: "Stop", at: now };
  await job(memory.sync, data);
  assert.equal(sent.length, 1);
  const before = fs.readFileSync(cursor(id), "utf8");
  const modified = fs.statSync(cursor(id)).mtimeMs;
  await job(memory.sync, data);
  await job(memory.sync, { ...data, event: "SessionEnd" });
  assert.equal(sent.length, 1);
  assert.equal(fs.readFileSync(cursor(id), "utf8"), before);
  assert.equal(fs.statSync(cursor(id)).mtimeMs, modified);
});

test("a failed live upload keeps the cursor absent and retries", async () => {
  sent = [];
  const data = { source: "claude-code", sessionId: "retry", transcript: transcript("retry", new Date(now).toISOString()), event: "Stop", at: now };
  const goodFetch = global.fetch;
  global.fetch = async () => ({ ok: false });
  try { await job(memory.sync, data); } finally { global.fetch = goodFetch; }
  assert.equal(fs.existsSync(cursor("retry")), false);
  await job(memory.sync, data);
  assert.equal(sent.length, 1);
  assert.equal(fs.existsSync(cursor("retry")), true);
});
