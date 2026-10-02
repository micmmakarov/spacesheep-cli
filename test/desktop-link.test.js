"use strict";
// Drive the installed hook entrypoint, including stdin, detached child and beat
// throttle. The server is local; all transcript/registry/config data is synthetic.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const bin = path.resolve(__dirname, "../bin/spacesheep.js");

test("desktop's first tool discovers a late bridge, then heartbeats are bare", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-desktop-link-"));
  const bodies = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const part of req) body += part;
    assert.equal(req.url, "/api/sessions/ping");
    bodies.push(JSON.parse(body));
    res.setHeader("content-type", "application/json");
    res.end('{"ok":true}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const config = path.join(dir, "cfg"), claude = path.join(dir, ".claude");
  const project = path.join(claude, "projects", "demo");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(path.join(claude, "sessions"), { recursive: true });
  const env = { ...process.env, HOME: dir, CLAUDE_CONFIG_DIR: claude,
    SPACESHEEP_CONFIG_DIR: config, SPACESHEEP_KEY: "ss_test_desktop_link",
    SPACESHEEP_APP_ORIGIN: `http://127.0.0.1:${server.address().port}`,
    CLAUDE_CODE_HOST_SESSION_ID: "local_11111111-2222-4333-8444-555555555555" };
  const url = "https://claude.ai/code/session_01DesktopLate";
  const line = (v) => JSON.stringify(v) + "\n";
  function transcript(id) {
    const file = path.join(project, id + ".jsonl");
    fs.writeFileSync(file, line({ type: "user", timestamp: new Date().toISOString(), cwd: project,
      entrypoint: "claude-desktop", message: { role: "user", content: "Check the desktop link" } }));
    return file;
  }
  function due(id) {
    const file = path.join(config, "sessions", "beats", "claude-code-" + id);
    if (fs.existsSync(file)) fs.utimesSync(file, new Date(0), new Date(0));
  }
  async function hook(event, id, file, desktop = true) {
    const before = bodies.length;
    const childEnv = { ...env };
    if (!desktop) delete childEnv.CLAUDE_CODE_HOST_SESSION_ID;
    const p = spawn(process.execPath, [bin, "sessions", "ping", event], { env: childEnv, stdio: ["pipe", "pipe", "pipe"] });
    p.stdin.end(JSON.stringify({ session_id: id, transcript_path: file, cwd: dir, tool_name: "Bash" }));
    const [code] = await once(p, "close");
    assert.equal(code, 0);
    for (let n = 0; bodies.length === before && n < 150; n++) await delay(20);
    assert.equal(bodies.length, before + 1, "detached hook posted to the local server");
    return bodies.at(-1);
  }
  try {
    for (const source of ["registry", "transcript"]) {
      const id = "desktop-" + source, file = transcript(id);
      assert.equal((await hook("start", id, file)).url, undefined);
      assert.equal((await hook("prompt", id, file)).url, undefined);
      if (source === "registry") fs.writeFileSync(path.join(claude, "sessions", "123.json"), JSON.stringify({
        pid: 123, sessionId: id, bridgeSessionId: "session_01DesktopLate", name: "Desktop work", nameSource: "auto" }));
      else fs.appendFileSync(file, line({ type: "bridge-session", bridgeSessionId: "session_01DesktopLate" }));
      const tool = await hook("tool", id, file);
      assert.equal(tool.event, "tool");
      assert.equal(tool.url, url);
      assert.equal(tool.title, source === "registry" ? "Desktop work" : "Check the desktop link");
      assert.equal(tool.cwd, project, "uses transcript's original folder, not hook cwd");
      due(id);
      const bare = await hook("tool", id, file);
      for (const field of ["url", "title", "cwd", "last_at"]) assert.equal(bare[field], undefined);
    }
    const id = "bridge-still-missing", file = transcript(id);
    assert.equal((await hook("tool", id, file)).url, undefined);
    fs.appendFileSync(file, line({ type: "bridge-session", bridgeSessionId: "session_01DesktopLate" }));
    due(id);
    assert.equal((await hook("tool", id, file)).url, url, "retries on a later due heartbeat");
    const terminal = await hook("tool", "terminal", file, false);
    for (const field of ["url", "title", "cwd", "desktop_id"]) assert.equal(terminal[field], undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    // The child records post success immediately after the HTTP response.
    await delay(100);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
