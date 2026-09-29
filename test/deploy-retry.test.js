"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { deploy, stagedSha } = require("../lib/deploy");

test("failed deploy saves receipts; retry validates them and uploads only changed/missing files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-retry-"));
  const manifest = path.join(dir, ".spacesheep.json");
  fs.writeFileSync(path.join(dir, "index.html"), "<title>Retry</title>");
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  fs.writeFileSync(path.join(dir, "b.txt"), "b");
  fs.writeFileSync(manifest, JSON.stringify({ space: "existing", custom: "keep" }));
  const uploaded = [];
  const staged = new Set();
  let fail = true;
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const p = new URL(url).searchParams.get("path");
    const sha = stagedSha(p, opts.body);
    uploaded.push(p); staged.add(sha);
    return new Response(JSON.stringify({ sha }), { status: 200 });
  };
  const client = { call: async (name, args) => {
    if (name === "stage_begin") return { upload_url: "https://example.invalid/stage", already_staged: (args.files || []).filter(f => staged.has(f.sha)).map(f => f.sha) };
    if (fail) throw new Error("no response from deploy");
    assert.equal(args.files.length, 3);
    return { uuid: "existing", url: "https://spacesheep.dev/test" };
  } };
  try {
    await assert.rejects(deploy(client, dir, {}, () => {}), /no response/);
    const saved = JSON.parse(fs.readFileSync(manifest));
    assert.equal(saved.custom, "keep"); assert.equal(saved.space, "existing");
    assert.equal(saved.staged_files.length, 3);
    for (const receipt of saved.staged_files) {
      assert.ok(Date.parse(receipt.expires_at) > Date.now());
      assert.equal(receipt.sha, receipt.content_sha);
    }
    assert.ok(!fs.readFileSync(manifest, "utf8").includes("upload_url"));
    uploaded.length = 0;
    fail = false;
    await deploy(client, dir, {}, () => {});
    assert.deepEqual(uploaded, []);
    fs.writeFileSync(path.join(dir, "a.txt"), "changed");
    staged.delete(saved.staged_files.find(r => r.path === "b.txt").sha);
    await deploy(client, dir, {}, () => {});
    assert.deepEqual(uploaded.sort(), ["a.txt", "b.txt"]);
    const final = JSON.parse(fs.readFileSync(manifest));
    assert.equal(final.custom, "keep");
    assert.equal(final.staged_files.find(r => r.path === "a.txt").sha, stagedSha("a.txt", Buffer.from("changed")));
    // A different account returns no matches; locally cached receipts alone
    // never authorize skipping an upload.
    uploaded.length = 0; staged.clear();
    await deploy(client, dir, {}, () => {});
    assert.equal(uploaded.length, 3);
  } finally { global.fetch = original; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("partial upload failure saves completed receipts and no-manifest creates no cache", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-partial-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<title>Retry</title>");
  fs.writeFileSync(path.join(dir, "fail.txt"), "fail");
  const original = global.fetch;
  const client = { call: async () => ({ upload_url: "https://example.invalid/stage" }) };
  global.fetch = async (url, opts) => {
    const p = new URL(url).searchParams.get("path");
    return p === "fail.txt" ? new Response('{}', { status: 500 }) : new Response(JSON.stringify({ sha: stagedSha(p, opts.body) }));
  };
  try {
    await assert.rejects(deploy(client, dir, {}, () => {}), /upload of fail.txt failed/);
    const file = path.join(dir, ".spacesheep.json");
    assert.equal(JSON.parse(fs.readFileSync(file)).staged_files.length, 1);
    fs.unlinkSync(file);
    await assert.rejects(deploy(client, dir, { noManifest: true }, () => {}));
    assert.equal(fs.existsSync(file), false);
  } finally { global.fetch = original; fs.rmSync(dir, { recursive: true, force: true }); }
});
