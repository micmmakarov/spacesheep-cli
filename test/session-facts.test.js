"use strict";
// What a Claude Code session is called and where it opens, from the files Claude
// Code leaves on the machine. The cases are Yaroslav's reports from the Intel and
// aifoundry2 (24 Sep): a derived registry name, a registry filed under another
// sessionId, a Remote Control link only the transcript still has, a first prompt
// with pasted screenshots, a title buried mid-file. Run: npm test
const { describe, it, before } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ss-facts-"));
process.env.HOME = HOME;
process.env.SPACESHEEP_CONFIG_DIR = path.join(HOME, "cfg");
const ses = require("../lib/sessions");
const mem = require("../lib/memory");

const CONFIG = path.join(HOME, ".claude");
const PROJECT = path.join(CONFIG, "projects", "-home-y-claude");
fs.mkdirSync(PROJECT, { recursive: true });
fs.mkdirSync(path.join(CONFIG, "sessions"), { recursive: true });

let n = 0;
const newId = () => `0000000${++n}-de26-4000-8000-000000000000`.slice(-36);
const line = (o) => JSON.stringify(o) + "\n";
const user = (text, extra = {}) => ({ type: "user", timestamp: "2026-09-19T16:00:00Z", cwd: "/home/y/claude", version: "2.1.278", entrypoint: "cli", message: { role: "user", content: text }, ...extra });
const reply = (extra = {}) => ({ type: "assistant", timestamp: "2026-09-24T16:00:00Z", version: "2.1.280", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "ok" }] }, ...extra });
function transcript(id, records) {
  const f = path.join(PROJECT, id + ".jsonl");
  fs.writeFileSync(f, records.map(line).join(""));
  return f;
}
const registry = (pid, o) => { fs.writeFileSync(path.join(CONFIG, "sessions", pid + ".json"), JSON.stringify({ pid, ...o })); ses._resetCaches(); };

describe("titles", () => {
  it("never titles a row with a derived process name", () => {
    const id = newId();
    const f = transcript(id, [user("I'm interested in figuring out performance cutoffs for permutation invariant nets"), reply()]);
    registry(101, { sessionId: id, name: "sutro-problems-6a", nameSource: "derived" });
    const facts = ses.claudeFacts(f, id);
    assert.strictEqual(facts.title, "I'm interested in figuring out performance cutoffs...");
    assert.strictEqual(facts.title_source, "first-ask");
    assert.strictEqual(facts.title_auto, true);
  });

  it("cuts a first ask the way the Claude Code app does: 50 characters, then ...", () => {
    assert.strictEqual(ses.appTitle("Check the PRs and merge them if they're records and nothing else"), "Check the PRs and merge them if they're records an...");
    assert.strictEqual(ses.appTitle("Give a brief summary of yesterday."), "Give a brief summary of yesterday.");
    assert.strictEqual(ses.appTitle("Test.\n\n  Tell me about this repo."), "Test. Tell me about this repo.");
  });

  it("takes Claude Code's auto title from the registry, and keeps it after the process exits", () => {
    const id = newId();
    const f = transcript(id, [user("look at the session titles"), reply()]);
    registry(102, { sessionId: id, name: "Spacesheep session titles analysis", nameSource: "auto" });
    assert.deepStrictEqual([ses.claudeFacts(f, id).title, ses.claudeFacts(f, id).title_source], ["Spacesheep session titles analysis", "harness"]);
    fs.unlinkSync(path.join(CONFIG, "sessions", "102.json"));
    // A fresh process (as a backfill is) with no registry file still has the name.
    const again = require("child_process").spawnSync(process.execPath, ["-e", `console.log(JSON.stringify(require(${JSON.stringify(path.join(__dirname, "..", "lib", "sessions"))}).claudeFacts(${JSON.stringify(f)}, ${JSON.stringify(id)})))`], { env: process.env, encoding: "utf8" });
    const facts = JSON.parse(again.stdout);
    assert.strictEqual(facts.title, "Spacesheep session titles analysis");
    assert.strictEqual(facts.title_source, "harness");
  });

  it("puts a name the person gave the session above Claude Code's own", () => {
    const id = newId();
    const f = transcript(id, [user("hello"), { type: "ai-title", aiTitle: "Greeting" }, { type: "custom-title", customTitle: "Power budget" }, reply()]);
    assert.deepStrictEqual([ses.claudeFacts(f, id).title, ses.claudeFacts(f, id).title_source], ["Power budget", "custom"]);
    registry(103, { sessionId: id, name: "Renamed in the app", nameSource: "user" });
    assert.deepStrictEqual([ses.claudeFacts(f, id).title, ses.claudeFacts(f, id).title_source], ["Renamed in the app", "custom"]);
  });

  it("finds a first ask that sits past the 64 KB head (pasted screenshots)", () => {
    const id = newId();
    const img = { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(300 * 1024) } };
    const f = transcript(id, [user([img, { type: "text", text: "Why is the board title different from the app?" }]), reply()]);
    const facts = ses.claudeFacts(f, id);
    assert.strictEqual(facts.first_ask, "Why is the board title different from the app?");
    assert.strictEqual(facts.title, "Why is the board title different from the app?");
  });

  it("finds a title buried mid-file, and next time reads only the new bytes", () => {
    const id = newId();
    const pad = (k) => Array.from({ length: k }, () => reply({ message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text: "x".repeat(2000) }] } }));
    const f = transcript(id, [user("start"), ...pad(100), { type: "ai-title", aiTitle: "Memory latency analysis" }, ...pad(200)]);
    assert.strictEqual(ses.claudeFacts(f, id).title, "Memory latency analysis");
    const memoFile = path.join(HOME, "cfg", "sessions", "facts", "claude-code-" + id + ".json");
    const upto = JSON.parse(fs.readFileSync(memoFile, "utf8")).scan_upto;
    assert.strictEqual(upto, fs.statSync(f).size);
    fs.appendFileSync(f, pad(10).map(line).join(""));
    assert.strictEqual(ses.claudeFacts(f, id).title, "Memory latency analysis");
    assert.ok(JSON.parse(fs.readFileSync(memoFile, "utf8")).scan_upto > upto);
  });

  it("reports the Claude Code that is running, not the one the session started on", () => {
    const id = newId();
    const f = transcript(id, [user("hi"), reply()]);
    assert.strictEqual(ses.claudeFacts(f, id).agent_version, "2.1.280");
  });
});

describe("links", () => {
  it("finds the registry entry by process when it is filed under another sessionId", () => {
    const id = newId();
    const f = transcript(id, [user("enable remote control on this session"), { type: "ai-title", aiTitle: "Enable remote control" }, reply()]);
    registry(1422081, { sessionId: "e442f603-08f7-4000-8000-000000000000", name: "claude-1a", nameSource: "derived", bridgeSessionId: "session_01Hcd8Dn7oPTor4" });
    assert.strictEqual(ses.claudeFacts(f, id).url, undefined);
    const facts = ses.claudeFacts(f, id, 1422081);
    assert.strictEqual(facts.url, "https://claude.ai/code/session_01Hcd8Dn7oPTor4");
    assert.strictEqual(facts.title, "Enable remote control");
  });

  it("reads the link from the transcript when no registry file has it", () => {
    const id = newId();
    const f = transcript(id, [user("hi"), { type: "bridge-session", bridgeSessionId: "cse_01Abc", lastSequenceNum: 4 }, reply()]);
    assert.strictEqual(ses.claudeFacts(f, id).url, "https://claude.ai/code/session_01Abc");
    assert.strictEqual(ses.transcriptLink([{ type: "system", subtype: "bridge_status", url: "https://claude.ai/code/session_01Xyz" }]), "https://claude.ai/code/session_01Xyz");
    assert.strictEqual(ses.transcriptLink([{ type: "system", subtype: "bridge_status", url: "https://evil.example/session_01Xyz" }]), null);
  });

  it("keeps a link it once saw after the registry file is gone", () => {
    const id = newId();
    const f = transcript(id, [user("hi"), reply()]);
    registry(104, { sessionId: id, nameSource: "derived", name: "x-1", bridgeSessionId: "session_01Kept" });
    assert.strictEqual(ses.claudeFacts(f, id).url, "https://claude.ai/code/session_01Kept");
    fs.unlinkSync(path.join(CONFIG, "sessions", "104.json"));
    const again = require("child_process").spawnSync(process.execPath, ["-e", `console.log(require(${JSON.stringify(path.join(__dirname, "..", "lib", "sessions"))}).claudeFacts(${JSON.stringify(f)}, ${JSON.stringify(id)}).url)`], { env: process.env, encoding: "utf8" });
    assert.strictEqual(again.stdout.trim(), "https://claude.ai/code/session_01Kept");
  });
});

describe("hook commands", () => {
  it("write Homebrew's stable node link instead of the versioned Cellar path", () => {
    const prefix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ss-brew-")));
    const cellar = path.join(prefix, "Cellar", "node", "25.2.1", "bin");
    fs.mkdirSync(cellar, { recursive: true });
    fs.writeFileSync(path.join(cellar, "node"), "");
    fs.mkdirSync(path.join(prefix, "opt"), { recursive: true });
    fs.symlinkSync(path.join(prefix, "Cellar", "node", "25.2.1"), path.join(prefix, "opt", "node"));
    assert.strictEqual(mem.stableNode(path.join(cellar, "node")), path.join(prefix, "opt", "node", "bin", "node"));
    assert.strictEqual(mem.stableNode("/home/y/.local/node/bin/node"), "/home/y/.local/node/bin/node");
  });
});

describe("running count", () => {
  it("counts Claude Code processes by their executable, not by an argument ending in /claude", () => {
    const cases = [
      ["/Users/m/Library/Application Support/Claude/claude-code/2.1.280/claude.app/Contents/MacOS/claude", "/Users/m/Library/Application Support/Claude/claude-code/2.1.280/claude.app/Contents/MacOS/claude --output-format stream-json", true],
      ["claude", "claude --continue --remote-control", true],
      ["2.1.280", "/home/y/.local/share/claude/versions/2.1.280 --continue", true],
      ["node", "node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js", true],
      ["tmux", "tmux new-session -d -s claude -c /home/y/claude", false],
      ["/Applications/Claude.app/Contents/MacOS/Claude", "/Applications/Claude.app/Contents/MacOS/Claude", false],
      ["disclaimer", "disclaimer /path/to/claude", false],
    ];
    for (const [exe, cmd, want] of cases) assert.strictEqual(ses.isClaudeCode(exe, cmd), want, exe);
  });
});
