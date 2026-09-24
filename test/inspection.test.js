"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { sessionArgs, feedbackArgs } = require("../lib/inspection");
const bin = path.resolve(__dirname, "../bin/spacesheep.js");
function cli(args, env) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [bin, ...args], { env: { ...process.env, SPACESHEEP_NO_UPDATE_CHECK: "1", ...env } });
    let stdout = "", stderr = "";
    p.stdout.on("data", b => stdout += b); p.stderr.on("data", b => stderr += b);
    p.on("close", code => resolve({ code, stdout, stderr }));
  });
}
test("commands use authenticated MCP and preserve filters, receipts, pagination and errors", async t => {
  const calls = [];
  let reject = false;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer ss_test_only");
    let input = ""; for await (const part of req) input += part;
    const body = JSON.parse(input);
    res.setHeader("Content-Type", "application/json");
    if (!body.id) { res.writeHead(202); return res.end(); }
    let result = {};
    if (body.method === "tools/call") {
      calls.push(body.params);
      result = { content: [{ type: "text", text: JSON.stringify(reject ? { error: "write access required" } : { created: false, message_id: "m1", sessions: [], next_offset: 42, has_more: { turns: true } }) }], isError: reject };
    }
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-inspection-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const env = { SPACESHEEP_ORIGIN: `http://127.0.0.1:${server.address().port}`, SPACESHEEP_KEY: "ss_test_only", SPACESHEEP_CONFIG_DIR: tmp };
  let r = await cli(["sessions", "list", "--source", "codex", "--state", "done", "--machine", "laptop", "--since", "1000", "--offset", "20", "--limit", "10", "--json"], env);
  assert.equal(r.code, 0, r.stderr); assert.equal(JSON.parse(r.stdout).next_offset, 42);
  assert.deepEqual(calls.pop(), { name: "list_sessions", arguments: { source: "codex", state: "done", machine: "laptop", since: 1000, offset: 20, limit: 10 } });
  r = await cli(["sessions", "get", "exact-id", "--source", "claude-code", "--limit", "5"], env);
  assert.equal(r.code, 0, r.stderr); assert.equal(JSON.parse(r.stdout).has_more.turns, true);
  assert.deepEqual(calls.pop(), { name: "get_session", arguments: { source: "claude-code", session_id: "exact-id", limit: 5 } });
  const args = ["feedback", "Deploy failed", "--client-id", "report-001", "--category", "bug", "--tag", "deploy", "--tag", "cli", "--metadata", '{"status":503}'];
  for (let i = 0; i < 2; i++) {
    r = await cli(args, env); assert.equal(r.code, 0, r.stderr); assert.equal(JSON.parse(r.stdout).created, false);
  }
  assert.deepEqual(calls[0], calls[1]);
  assert.deepEqual(calls[0], { name: "submit_feedback", arguments: { message: "Deploy failed", client_id: "report-001", category: "bug", tags: ["deploy", "cli"], metadata: { status: 503 } } });
  reject = true;
  r = await cli(args, env); assert.equal(r.code, 1); assert.match(r.stderr, /write access required/);
  r = await cli(["sessions", "list"], { ...env, SPACESHEEP_KEY: "" }); assert.equal(r.code, 3);
});
test("invalid input fails locally, including zero, partial integers and oversized context", () => {
  for (const opts of [{ limit: "0" }, { offset: "-1" }, { since: "123ms" }, { state: "running" }, { limit: "101" }])
    assert.throws(() => sessionArgs({ _: ["list"], ...opts }));
  assert.throws(() => sessionArgs({ _: ["get", "id"] }));
  assert.deepEqual(sessionArgs({ _: ["list"], offset: "0", since: "0" }), { offset: 0, since: 0 });
  const opts = { _: ["hello"], clientId: "report-001" };
  for (const extra of [{ clientId: "short" }, { metadata: "[]" }, { metadata: '{"x":{}}' }, { metadata: '{"x":1e999}' }, { _: ["x".repeat(4000)] }, { tags: [""] }])
    assert.throws(() => feedbackArgs({ ...opts, ...extra }));
});
test("hook child posts a named observation without arguments or output", async t => {
  let posted;
  const server = http.createServer(async (req, res) => {
    let input = ""; for await (const b of req) input += b;
    posted = JSON.parse(input); res.end('{}');
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ss-tool-name-"));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const job = path.join(tmp, "job.json");
  fs.writeFileSync(job, JSON.stringify({ source: "claude-code", session_id: "test-id", event: "tool", tool_name: "Bash", tool_input: "private args", tool_output: "private output", cwd: tmp }));
  const r = await cli(["sessions", "ping", "--child", job], { SPACESHEEP_KEY: "ss_test_only", SPACESHEEP_CONFIG_DIR: tmp, SPACESHEEP_APP_ORIGIN: `http://127.0.0.1:${server.address().port}` });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(posted.tool_name, "Bash");
  assert.equal(posted.tool_input, undefined); assert.equal(posted.tool_output, undefined);
});
