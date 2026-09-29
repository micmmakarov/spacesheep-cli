"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { stagedSha, preflightError, refusalError, stageAll, wantsStagingLookup } = require("../lib/deploy");

test("the staged address matches the server's (sha256 of path NUL bytes NUL, 12 hex)", () => {
  // The same fixture the MCP worker's e2e stages and gets back from PUT /stage.
  const html = '<!doctype html><title>Preflight</title><h1 data-ss-id="h">preflight</h1>';
  assert.equal(stagedSha("index.html", Buffer.from(html)), "d63139cc0c94");
});

test("only a big site requests a staging reuse lookup", () => {
  assert.equal(wantsStagingLookup([{ size: 10 }, { size: 10 }]), false);
  assert.equal(wantsStagingLookup(Array.from({ length: 201 }, () => ({ size: 1 }))), true);
  assert.equal(wantsStagingLookup([{ size: 60 * 1024 * 1024 }]), true);
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

const { deploy } = require('../lib/deploy');
async function withDeployTree(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-preflight-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<h1>Test</h1>');
  fs.writeFileSync(path.join(dir, 'worker.js'), 'self.onmessage = () => {};');
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('an over-cap manifest makes ZERO upload calls and never calls deploy', async () => {
  await withDeployTree(async (dir) => {
    let puts = 0;
    const originalFetch = global.fetch;
    global.fetch = async () => { puts++; throw new Error('must not upload'); };
    const calls = [];
    try {
      await assert.rejects(deploy({ call: async (name, args) => {
        calls.push(name);
        assert.equal(name, 'stage_begin');
        assert.equal(args.files.length, 2);
        assert.ok(args.files.every((f) => Number.isInteger(f.size)));
        return { plan: 'team', limits: { max_files: 1 }, upload_url: 'https://stage.test',
          preflight: { ok: false, problems: [{ error: 'too_many_files', message: 'Team plan holds at most 1' }] } };
      } }, dir, { new: true }, () => {}), /too_many_files.*Team plan/);
      assert.equal(puts, 0);
      assert.deepEqual(calls, ['stage_begin']);
      assert.equal(fs.existsSync(path.join(dir, '.spacesheep.json')), false);
    } finally { global.fetch = originalFetch; }
  });
});

test('a small root-worker or exhausted-headroom manifest also stops before any PUT', async () => {
  for (const problem of [
    { error: 'worker_restricted', message: 'worker.js requires team access', paths: ['worker.js'] },
    { error: 'rate_limited', message: '0 uploads remain; reset at 2030-01-01', retry_after: 75 },
  ]) await withDeployTree(async (dir) => {
    const originalFetch = global.fetch;
    let puts = 0;
    global.fetch = async () => { puts++; throw new Error('must not upload'); };
    try {
      await assert.rejects(deploy({ call: async (name, args) => {
        assert.equal(name, 'stage_begin');
        assert.deepEqual(args.files.map((f) => f.path), ['index.html', 'worker.js']);
        // Small-site reuse policy stays as on main: metadata only, no hash lookup.
        assert.ok(args.files.every((f) => !f.sha));
        return { upload_url: 'https://stage.test', preflight: { ok: false, problems: [problem] } };
      } }, dir, { new: true }, () => {}), (e) => {
        assert.match(e.message, /nothing was uploaded/);
        assert.ok(e.message.includes(problem.error));
        if (problem.retry_after) assert.match(e.message, /Retry in 75 seconds/);
        return true;
      });
      assert.equal(puts, 0);
    } finally { global.fetch = originalFetch; }
  });
});

test('missing staging results explain that this command created no space', async () => {
  for (const result of [null, undefined, {}]) await withDeployTree(async (dir) => {
    await assert.rejects(deploy({ call: async () => result }, dir, { new: true }, () => {}),
      /stage_begin failed: no upload_url.*no space was created/);
  });
});

test('malformed deploy replies name the uncertainty and never write a pin', async () => {
  for (const result of [null, undefined, {}, { uuid: 'u' }, { uuid: 7, url: 'https://x' }]) await withDeployTree(async (dir) => {
    const originalFetch = global.fetch;
    global.fetch = async () => new Response(JSON.stringify({ sha: 'aaaaaaaaaaaa' }));
    try {
      await assert.rejects(deploy({ call: async (name) => name === 'stage_begin'
        ? { upload_url: 'https://stage.test' } : result }, dir, { new: true }, () => {}),
      /unclear whether anything was published.*spacesheep list/);
      assert.equal(fs.existsSync(path.join(dir, '.spacesheep.json')), false);
    } finally { global.fetch = originalFetch; }
  });
});
