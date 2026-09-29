"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { run, readStoreZip, exportArgs, crc32 } = require("../lib/session-export");

// The server's writer (packages/app/src/session-export.ts zipWriter), in miniature.
function zip(files) {
  const locals = [], central = [];
  let offset = 0;
  for (const [name, body] of files) {
    const n = Buffer.from(name), d = Buffer.from(body), crc = crc32(d);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt32LE(crc, 14); head.writeUInt32LE(d.length, 18); head.writeUInt32LE(d.length, 22); head.writeUInt16LE(n.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(d.length, 20); cd.writeUInt32LE(d.length, 24); cd.writeUInt16LE(n.length, 28); cd.writeUInt32LE(offset, 42);
    locals.push(head, n, d); central.push(cd, n);
    offset += 30 + n.length + d.length;
  }
  const dir = Buffer.concat(central), eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(dir.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, dir, eocd]);
}
const archive = zip([
  ["sessions/index.md", "# Coding sessions\n"],
  ["sessions/claude-code/2026-09-29-abc.md", "# Fix the lane\n"],
  ["sessions/claude-code/2026-09-29-abc.part-2.md", "# Fix the lane — part 2\n"],
]);
const fakeFetch = (buf, status = 200) => async () => ({ ok: status < 300, status, arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length) });

test("writes every session file under DIR/sessions and says how many", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-export-"));
  const calls = [], lines = [];
  await run({ _: ["export"], out: dir, since: "1790000000000" }, async (name, args) => { calls.push([name, args]); return { download_url: "https://spacesheep.dev/api/sessions/export/sse_x", sessions: 5, included: 2 }; }, (l) => lines.push(l), () => {}, fakeFetch(archive));
  assert.deepStrictEqual(calls, [["export_sessions", { since: 1790000000000 }]]);
  assert.strictEqual(fs.readFileSync(path.join(dir, "sessions/claude-code/2026-09-29-abc.part-2.md"), "utf8"), "# Fix the lane — part 2\n");
  assert.strictEqual(fs.readFileSync(path.join(dir, "sessions/index.md"), "utf8"), "# Coding sessions\n");
  assert.match(lines[0], /Exported 2 of 5 sessions .* \(3 files\)/);
});

test("--json reports files and parts; --zip keeps the archive whole", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-export-"));
  let printed;
  await run({ _: ["export"], out: dir, json: true }, async () => ({ download_url: "u", sessions: 1, included: 1 }), () => {}, (v) => { printed = v; }, fakeFetch(archive));
  assert.deepStrictEqual({ files: printed.files, parts: printed.parts, incomplete: printed.incomplete }, { files: 3, parts: 1, incomplete: false });
  const file = path.join(dir, "all.zip");
  await run({ _: ["export"], zip: file }, async () => ({ download_url: "u", sessions: 1, included: 1 }), () => {}, () => {}, fakeFetch(archive));
  assert.deepStrictEqual(fs.readFileSync(file), archive);
});

test("refuses a damaged archive and any path that would leave the folder", async () => {
  const bad = Buffer.from(archive); bad[30 + "sessions/index.md".length + 2] ^= 0xff; // a byte of the first file
  assert.throws(() => readStoreZip(bad), /damaged/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ss-export-"));
  for (const name of ["../escape.md", "/etc/x", "sessions/../../x", "a\\b"]) {
    const evil = zip([[name, "x"]]);
    await assert.rejects(run({ _: ["export"], out: dir }, async () => ({ download_url: "u" }), () => {}, () => {}, fakeFetch(evil)), /unsafe path/);
  }
});

test("a failed download or an old server says so", async () => {
  await assert.rejects(run({ _: ["export"] }, async () => ({ download_url: "u" }), () => {}, () => {}, fakeFetch(archive, 404)), /HTTP 404/);
  await assert.rejects(run({ _: ["export"] }, async () => "no", () => {}, () => {}, fakeFetch(archive)), /did not return an export link/);
  assert.throws(() => exportArgs({ _: ["export"], since: "yesterday" }), /Unix milliseconds/);
});
