// A key pasted with wrapping, and a 401 that isn't spacesheep's (a proxy or a
// sandbox's network allowlist) — reported as "rejected the key" in a Claude Code
// cloud session on 2026-09-26 when the key itself was fine.
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { cleanKey } = require("../lib/config");
const { connectWithKey } = require("../lib/login");

test("cleanKey drops quotes, whitespace and invisible characters", () => {
  assert.strictEqual(cleanKey('  "ss_abc123"\n'), "ss_abc123");
  assert.strictEqual(cleanKey("'ss_abc123'"), "ss_abc123");
  assert.strictEqual(cleanKey("​ss_abc123﻿"), "ss_abc123");
  assert.strictEqual(cleanKey("ss_abc123"), "ss_abc123");
  assert.strictEqual(cleanKey(undefined), "");
});

function serve(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, "127.0.0.1", () => resolve({ srv, origin: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test("connect: spacesheep's own 401 is a rejected key", async () => {
  const { srv, origin } = await serve((req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Unknown or revoked API key.", code: "unauthorized" }));
  });
  try {
    await assert.rejects(connectWithKey(origin, "ss_x", "m", () => {}), (e) => e.code === "EAUTH" && /revoked/.test(e.message));
  } finally { srv.close(); }
});

test("connect: a bare 403 from a proxy is a network problem, not the key", async () => {
  const { srv, origin } = await serve((req, res) => { res.writeHead(403, { "content-type": "text/plain" }); res.end("blocked by policy"); });
  try {
    await assert.rejects(connectWithKey(origin, "ss_x", "m", () => {}), (e) => e.code === "ENET" && /not from spacesheep/.test(e.message));
  } finally { srv.close(); }
});
