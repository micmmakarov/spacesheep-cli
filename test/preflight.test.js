"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { deploy } = require("../lib/deploy");

function fixture(t, extra = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-preflight-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>Hello é</h1>");
  for (let i = 0; i < extra; i++) fs.writeFileSync(path.join(dir, `${i}.json`), "{}");
  return dir;
}

for (const issue of [
  { error: "too_many_files", message: "12001 files; the Pro plan allows 12000 per space." },
  { error: "text_payload_too_large", message: "55259955 text bytes; limit 50331648 bytes. Examples: data.json." },
  { error: "worker_restricted", message: "worker_restricted: worker.js selects server worker mode." },
  { error: "rate_limited", message: "stage_upload/3600: 5900 needed, 100 remaining; retry in 36 min (2146 seconds)." },
]) test(`preflight ${issue.error} makes zero upload requests`, async t => {
  const dir = fixture(t);
  let uploads = 0, publishes = 0;
  t.mock.method(global, "fetch", async () => { uploads++; throw new Error("unexpected upload"); });
  const client = { call: async (name, args) => {
    if (name === "deploy") publishes++;
    assert.equal(name, "stage_begin");
    assert.deepEqual(args.manifest, [{ path: "index.html", size: Buffer.byteLength("<h1>Hello é</h1>") }]);
    return { preflight: { ok: false, issues: [issue] } };
  } };
  await assert.rejects(deploy(client, dir, {}, () => {}), e => e.message.includes(issue.message));
  assert.equal(uploads, 0);
  assert.equal(publishes, 0);
});

test("all preflight issues appear together", async t => {
  const dir = fixture(t);
  const client = { call: async () => ({ preflight: { ok: false, issues: [{ message: "file cap" }, { message: "text cap" }, { message: "worker.js" }] } }) };
  await assert.rejects(deploy(client, dir, {}, () => {}), /file cap\n.*text cap\n.*worker.js/);
});

for (const rejectsArgument of [false, true]) test(`old server fallback (${rejectsArgument}) still deploys`, async t => {
  const dir = fixture(t), logs = [];
  t.mock.method(global, "fetch", async () => new Response(JSON.stringify({ sha: "0123456789ab" })));
  const client = { call: async (name, args) => {
    if (name === "stage_begin") {
      if (rejectsArgument && args?.manifest) throw new Error("unknown manifest argument");
      return { upload_url: "https://upload.example/stage", plan: "pro", limits: { max_files: 12000 } };
    }
    return { uuid: "created-id", url: "https://example.test/created-id" };
  } };
  assert.equal((await deploy(client, dir, {}, line => logs.push(line))).uuid, "created-id");
  assert.ok(logs.some(line => /preflight unavailable/.test(line)));
});

for (const header of [true, false]) test(`429 shows seconds and minutes (${header ? "header" : "body"}) and stops queue`, async t => {
  const dir = fixture(t, 20);
  let uploads = 0;
  t.mock.method(global, "fetch", async () => {
    uploads++;
    return new Response(JSON.stringify({ error: "rate_limited", retry_after: 2146 }), { status: 429, headers: header ? { "retry-after": "2146" } : {} });
  });
  const client = { call: async name => {
    assert.equal(name, "stage_begin");
    return { upload_url: "https://upload.example/stage", preflight: { ok: true, issues: [] } };
  } };
  await assert.rejects(deploy(client, dir, {}, () => {}), /rate limited, retry in 36 min \(2146 seconds\)/);
  assert.equal(uploads, 6); // only already-in-flight PUTs, never the remaining queue
});

for (const result of ["not json", {}, null, { uuid: "created-id" }, { error: "payload_too_large", message: "Pro cap exceeded" }]) {
  test(`invalid deploy result ${JSON.stringify(result)} never looks successful`, async t => {
    const dir = fixture(t);
    t.mock.method(global, "fetch", async () => new Response(JSON.stringify({ sha: "0123456789ab" })));
    const client = { call: async name => name === "stage_begin" ? { upload_url: "https://upload.example/stage" } : result };
    await assert.rejects(deploy(client, dir, {}, () => {}), e => {
      assert.doesNotMatch(e.message, /undefined/);
      assert.match(e.message, result?.uuid ? /Space created-id was created/ : result?.error ? /No new space was created/ : /status is unknown/);
      return true;
    });
    if (result?.uuid) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, ".spacesheep.json"))).space, "created-id");
  });
}

test("platform worker preflight sends template inputs and hashes, never source", t => {
  const { workerTemplateProof } = require("../lib/deploy");
  const { createHash } = require("node:crypto");
  const dir = fixture(t);
  const code = 'const SLIDES = [{"url":"https://example.test/a.png","label":"A"}];\nconst CAPTION = "Hello";\nconst ACCOUNT = "";\n';
  fs.writeFileSync(path.join(dir, "worker.js"), code);
  fs.writeFileSync(path.join(dir, "schema.sql"), " CREATE TABLE test (id TEXT);\n");
  const files = ["worker.js", "schema.sql"].map(p => ({ path: p, abs: path.join(dir, p) }));
  const proof = workerTemplateProof(files);
  assert.equal(proof.caption, "Hello");
  assert.equal(proof.sha256, createHash("sha256").update(code).digest("hex"));
  assert.equal(proof.schema_sha256, createHash("sha256").update("CREATE TABLE test (id TEXT);").digest("hex"));
  assert.equal(proof.content, undefined);
  fs.writeFileSync(path.join(dir, "worker.js"), "self.onmessage = () => {};");
  assert.equal(workerTemplateProof(files), undefined);
});

test("failed JSON parsing names the failure and unknown publication status", async t => {
  const dir = fixture(t);
  t.mock.method(global, "fetch", async () => new Response(JSON.stringify({ sha: "0123456789ab" })));
  const client = { call: async name => {
    if (name === "stage_begin") return { upload_url: "https://upload.example/stage" };
    throw new SyntaxError("Unexpected token in JSON");
  } };
  await assert.rejects(deploy(client, dir, {}, () => {}), /Deploy response failed: Unexpected token in JSON.*status is unknown/);
});
