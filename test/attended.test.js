"use strict";
// Whether a person attended a session, as Claude Code tells its hooks
// (CLAUDE_CODE_SESSION_ATTENDED). A `claude -p "reply with the word ok"` an agent
// runs to test the hooks says "0", and the board keeps a short run like that off
// its list (@yaroslavvb, 2026-09-25). Run: npm test
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const ses = require("../lib/sessions");

const BIN = path.join(__dirname, "..", "bin", "spacesheep.js");
const ID = "7d1e2f30-1111-4222-8333-944455566677";

function hook(env) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ss-att-"));
  const base = { ...process.env, HOME: home, SPACESHEEP_CONFIG_DIR: path.join(home, "cfg"), SPACESHEEP_KEY: "" };
  delete base.CLAUDE_CODE_SESSION_ATTENDED;
  spawnSync(process.execPath, [BIN, "sessions", "ping", "stop"], {
    input: JSON.stringify({ session_id: ID, cwd: home }), env: { ...base, ...env }, encoding: "utf8",
  });
  const dir = path.join(home, "cfg", "sessions", "jobs");
  return fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"))) : [];
}

describe("attended", () => {
  it("reads Claude Code's flag, and nothing else", () => {
    assert.strictEqual(ses.attendedFromEnv({ CLAUDE_CODE_SESSION_ATTENDED: "1" }), true);
    assert.strictEqual(ses.attendedFromEnv({ CLAUDE_CODE_SESSION_ATTENDED: "0" }), false);
    assert.strictEqual(ses.attendedFromEnv({ CLAUDE_CODE_SESSION_ATTENDED: "yes" }), undefined);
    assert.strictEqual(ses.attendedFromEnv({}), undefined);
  });
  it("rides the hook's job, and is left out when Claude Code doesn't say", () => {
    const off = hook({ CLAUDE_CODE_SESSION_ATTENDED: "0" });
    const on = hook({ CLAUDE_CODE_SESSION_ATTENDED: "1" });
    const unsaid = hook({});
    // The detached child may already have taken a job; when one is left, it says so.
    if (off.length) assert.strictEqual(off[0].attended, false);
    if (on.length) assert.strictEqual(on[0].attended, true);
    if (unsaid.length) assert.ok(!("attended" in unsaid[0]));
    assert.ok(off.length + on.length + unsaid.length > 0, "no job was written");
  });
});
