"use strict";
// Antigravity session hooks: the stdin it sends, the stdout it requires, the
// hooks.json shape it reads, and what its transcript says. Run: npm test
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const ses = require("../lib/sessions");

const BIN = path.join(__dirname, "..", "bin", "spacesheep.js");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ss-ag-"));
const ID = "5c5e41a5-7ce9-4789-b200-28567b586871";

function hook(event, stdin) {
  const home = tmp();
  const r = spawnSync(process.execPath, [BIN, "sessions", "ping", event, "--antigravity"], {
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    env: { ...process.env, HOME: home, SPACESHEEP_CONFIG_DIR: path.join(home, "cfg"), SPACESHEEP_KEY: "" },
    encoding: "utf8",
  });
  const dir = path.join(home, "cfg", "sessions", "jobs");
  const jobs = fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"))) : [];
  return { stdout: r.stdout, status: r.status, jobs };
}

describe("ping --antigravity", () => {
  it("always answers {} on stdout, even with no usable input", () => {
    for (const input of ["", "not json", {}, { conversationId: ID, workspacePaths: ["/w"] }]) {
      const r = hook("stop", input);
      assert.strictEqual(r.status, 0);
      assert.deepStrictEqual(JSON.parse(r.stdout), {});
    }
  });

  it("reads conversationId, the first workspace and the model", () => {
    const r = hook("stop", { conversationId: ID, workspacePaths: ["file:///Users/yv/git/my%20repo"], transcriptPath: "/t.jsonl", modelName: "gemini-3-pro" });
    assert.strictEqual(r.jobs.length, 1);
    assert.deepStrictEqual(r.jobs[0], { source: "antigravity", event: "stop", session_id: ID, cwd: "/Users/yv/git/my repo", transcript: "/t.jsonl", model: "gemini-3-pro" });
  });

  it("only the first model call of an execution is the ask; the rest are heartbeats", () => {
    assert.strictEqual(hook("prompt", { conversationId: ID, invocationNum: 0 }).jobs[0].event, "prompt");
    assert.strictEqual(hook("prompt", { conversationId: ID, invocationNum: 3 }).jobs[0].event, "tool");
  });

  it("forwards only a valid tool name, never its arguments or output", () => {
    const r = hook("tool", { conversationId: ID, toolName: "mcp__repo.read", toolInput: { secret: "do-not-send" }, toolOutput: "private" });
    assert.strictEqual(r.jobs[0].tool_name, "mcp__repo.read");
    assert.ok(!JSON.stringify(r.jobs).includes("do-not-send"));
    assert.ok(!JSON.stringify(r.jobs).includes("private"));
    assert.strictEqual(hook("tool", { conversationId: ID, toolName: "Bash secret args" }).jobs[0].tool_name, undefined);
    assert.strictEqual(hook("stop", { conversationId: ID, toolName: "Bash" }).jobs[0].tool_name, undefined);
  });

  it("drops a ping with no id rather than inventing one", () => {
    assert.strictEqual(hook("prompt", { workspacePaths: ["/w"] }).jobs.length, 0);
  });
});

describe("antigravityEntry — the hooks.json shape agy reads", () => {
  const e = ses.antigravityEntry();
  it("tool events hold {matcher, hooks} groups; PreInvocation and Stop hold handlers", () => {
    assert.strictEqual(e.enabled, true);
    assert.strictEqual(e.PostToolUse[0].matcher, "*");
    assert.match(e.PostToolUse[0].hooks[0].command, /sessions ping tool --antigravity$/);
    assert.match(e.PreInvocation[0].command, /sessions ping prompt --antigravity$/);
    assert.match(e.Stop[0].command, /sessions ping stop --antigravity$/);
  });
  it("timeouts are seconds, not milliseconds", () => {
    for (const h of [e.PreInvocation[0], e.Stop[0], e.PostToolUse[0].hooks[0]]) assert.strictEqual(h.timeout, 5);
  });
});

describe("antigravityFacts — the transcript", () => {
  it("titles the session with the first ask and spans its steps", () => {
    const f = path.join(tmp(), "transcript.jsonl");
    fs.writeFileSync(f, [
      { step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", created_at: "2026-09-24T21:40:00Z", content: "<user_information>…</user_information>" },
      { step_index: 1, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-09-24T21:40:05Z", content: "<USER_REQUEST>\nnpm install -g github:micmmakarov/spacesheep-cli && spacesheep sessions install\n</USER_REQUEST>" },
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-09-24T21:55:00Z", content: "Done." },
    ].map((j) => JSON.stringify(j)).join("\n") + "\n");
    const facts = ses.antigravityFacts(f);
    assert.strictEqual(facts.title, "npm install -g github:micmmakarov/spacesheep-cli && spacesheep sessions install");
    assert.strictEqual(facts.title_auto, true);
    assert.strictEqual(facts.started_at, Date.parse("2026-09-24T21:40:00Z"));
    assert.strictEqual(facts.last_at, Date.parse("2026-09-24T21:55:00Z"));
  });
  it("an empty or missing transcript gives nothing, not a crash", () => {
    assert.deepStrictEqual(ses.antigravityFacts("/nope/transcript.jsonl"), {});
  });
});

describe("agWorkspace", () => {
  it("takes paths and file:// URLs", () => {
    assert.strictEqual(ses.agWorkspace(["/a/b"]), "/a/b");
    assert.strictEqual(ses.agWorkspace(["file:///a/b%20c"]), "/a/b c");
    assert.strictEqual(ses.agWorkspace([]), null);
    assert.strictEqual(ses.agWorkspace(undefined), null);
  });
});
