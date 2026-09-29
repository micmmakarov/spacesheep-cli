"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { stagedSha, preflightError, refusalError, stageAll, wantsPreflight } = require("../lib/deploy");

test("the staged address matches the server's (sha256 of path NUL bytes NUL, 12 hex)", () => {
  // The same fixture the MCP worker's e2e stages and gets back from PUT /stage.
  const html = '<!doctype html><title>Preflight</title><h1 data-ss-id="h">preflight</h1>';
  assert.equal(stagedSha("index.html", Buffer.from(html)), "d63139cc0c94");
});

test("only a big site asks the server first", () => {
  assert.equal(wantsPreflight([{ size: 10 }, { size: 10 }]), false);
  assert.equal(wantsPreflight(Array.from({ length: 201 }, () => ({ size: 1 }))), true);
  assert.equal(wantsPreflight([{ size: 60 * 1024 * 1024 }]), true);
});

test("a refused preflight names every wall and says nothing was uploaded", () => {
  const msg = preflightError({ preflight: { ok: false, problems: [
    { error: "text_payload_too_large", message: "52.7 MB of pages" },
    { error: "worker_restricted", message: "root worker.js", paths: ["worker.js"] },
  ] } });
  assert.match(msg, /nothing was uploaded/);
  assert.match(msg, /text_payload_too_large: 52\.7 MB/);
  assert.match(msg, /worker_restricted: root worker\.js \(worker\.js\)/);
  assert.equal(preflightError({ preflight: { ok: true, problems: [] } }), null);
  assert.equal(preflightError({ upload_url: "x" }), null);
});

test("a deploy refusal is an error, never 'Created undefined'", () => {
  const e = refusalError({ error: "text_payload_too_large", message: "too much text" }, "deploy");
  assert.match(e.message, /deploy refused — text_payload_too_large: too much text/);
  assert.match(refusalError({ error: "rate_limited", message: "m", retry_after: 30 }, "deploy").message, /retry in 30s/);
  assert.match(refusalError("worker_restricted: x", "deploy").message, /deploy failed: worker_restricted/);
  assert.equal(refusalError({ uuid: "u", url: "https://x" }, "deploy"), null);
});

async function withServer(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

function tree(n) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-stage-"));
  return Array.from({ length: n }, (_, i) => {
    const abs = path.join(dir, `f${i}.txt`);
    fs.writeFileSync(abs, `file ${i}`);
    const bytes = fs.readFileSync(abs);
    return { path: `f${i}.txt`, abs, size: bytes.length, sha: stagedSha(`f${i}.txt`, bytes) };
  });
}

test("stageAll skips what is staged, waits out a 429, and renews an expired link", async () => {
  const files = tree(5);
  const puts = [];
  let limited = false;
  let expired = false;
  await withServer((req, res) => {
    const p = new URL(req.url, "http://x").searchParams.get("path");
    let body = [];
    req.on("data", (c) => body.push(c)).on("end", () => {
      if (req.url.startsWith("/old/") && !expired) { expired = true; res.writeHead(401); return res.end("{}"); }
      if (req.url.startsWith("/old/")) { res.writeHead(401); return res.end("{}"); }
      if (!limited) {
        limited = true;
        res.writeHead(429, { "Content-Type": "application/json", "Retry-After": "1" });
        return res.end(JSON.stringify({ error: "rate_limited", message: "Too many requests", retry_after: 1 }));
      }
      puts.push(p);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ path: p, sha: stagedSha(p, Buffer.concat(body)), size: 1 }));
    });
  }, async (base) => {
    const client = { call: async () => ({ upload_url: `${base}/new/tok` }) };
    const logs = [];
    const out = await stageAll(client, files, (l) => logs.push(l), { upload_url: `${base}/old/tok` }, {
      alreadyStaged: [files[0].sha, files[1].sha],
    });
    assert.equal(out.length, 5);
    assert.deepEqual(puts.sort(), ["f2.txt", "f3.txt", "f4.txt"]);
    for (const f of files) assert.equal(out.find((o) => o.path === f.path).staged_sha, f.sha);
    assert.ok(logs.some((l) => /2 file\(s\) already staged/.test(l)));
    assert.ok(logs.some((l) => /upload rate limit .* resuming in 1 min/.test(l)), logs.join("\n"));
  });
});

test("a failed upload says what is staged and that a rerun uploads only the rest", async () => {
  const files = tree(1);
  await withServer((req, res) => { req.resume(); req.on("end", () => { res.writeHead(413); res.end(JSON.stringify({ error: "file too large" })); }); },
    async (base) => {
      await assert.rejects(
        stageAll({ call: async () => ({}) }, files, () => {}, { upload_url: `${base}/t` }),
        /upload of f0\.txt failed: file too large\. 0 file\(s\) are staged .* uploads only the rest/,
      );
    });
});
