"use strict";
// `spacesheep sessions export`: every coding session, complete, into a folder — for a
// backup an agent or a cron keeps. The server's export_sessions tool mints a one-hour,
// read-only link to ONE zip (sessions/index.md, then sessions/<harness>/<start day>-<id>.md
// per session with its whole synced thread, long ones continued in .part-N.md); this
// downloads it and writes the files, or keeps the zip itself with --zip. File names are
// stable, so a later export (--since) writes over the same files.
const fs = require("fs");
const path = require("path");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The entries of a stored (uncompressed) zip — what the server writes — checked
 *  against their CRCs. Anything else is refused rather than half-read. */
function readStoreZip(buf) {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error("the download is not a zip archive");
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("the zip's directory is damaged");
    const method = buf.readUInt16LE(at + 10), crc = buf.readUInt32LE(at + 16), size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28), extraLen = buf.readUInt16LE(at + 30), commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    if (method !== 0) throw new Error(`unexpected compressed entry ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`the download is damaged at ${name}; export again`);
    entries.push({ name, data });
    at += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Where an entry lands under `root`; never outside it. */
function target(root, name) {
  if (!name || path.isAbsolute(name) || name.includes("\\") || name.split("/").some((s) => s === ".." || s === "")) throw new Error(`refusing an unsafe path in the archive: ${name}`);
  const base = path.resolve(root), full = path.resolve(base, name);
  if (!full.startsWith(base + path.sep)) throw new Error(`refusing an unsafe path in the archive: ${name}`);
  return full;
}

function exportArgs(opts) {
  if (opts._.length !== 1) throw new Error("usage: spacesheep sessions export [-o DIR] [--since MS] [--zip FILE] [--json]");
  const args = {};
  if (opts.since !== undefined) {
    if (!/^\d+$/.test(String(opts.since))) throw new Error("--since must be Unix milliseconds, e.g. $(( $(date +%s) * 1000 - 86400000 )) for the last day");
    args.since = Number(opts.since);
  }
  return args;
}

async function run(opts, call, log, out, fetchImpl = fetch) {
  const args = exportArgs(opts);
  const r = await call("export_sessions", args);
  if (!r || typeof r !== "object" || !r.download_url) throw new Error("the server did not return an export link — update the server or try again");
  const res = await fetchImpl(r.download_url);
  if (!res.ok) throw new Error(`the export download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const summary = { sessions: r.sessions, included: r.included, bytes: buf.length };
  if (opts.zip) {
    fs.writeFileSync(opts.zip, buf);
    summary.zip = path.resolve(opts.zip);
  } else {
    const root = opts.out || ".";
    const entries = readStoreZip(buf);
    for (const e of entries) {
      const file = target(root, e.name);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, e.data);
    }
    summary.dir = path.resolve(root, "sessions");
    summary.files = entries.length;
    summary.parts = entries.filter((e) => /\.part-\d+\.md$/.test(e.name)).length;
    summary.incomplete = entries.some((e) => e.name === "sessions/INCOMPLETE.md");
  }
  if (opts.json) return out(summary);
  const what = args.since ? `${r.included} of ${r.sessions} sessions (active since ${new Date(args.since).toISOString()})` : `${r.sessions} session${r.sessions === 1 ? "" : "s"}`;
  log(summary.zip ? `Saved ${what} to ${summary.zip}` : `Exported ${what} to ${summary.dir} (${summary.files} files)`);
  if (summary.incomplete) log(`The export stopped early: see ${path.join(summary.dir, "INCOMPLETE.md")}.`);
}

module.exports = { run, readStoreZip, exportArgs, target, crc32 };
