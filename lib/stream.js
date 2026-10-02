// `spacesheep stream <name>` — push live values from this machine to a stream, and
// run the buttons pages press on it.
//
// A stream is a name under your account (`lab-work/gcp-1`), made by its first push.
// Pages that declare it (<meta name="ss-streams" content="lab-work/gcp-1">) draw it
// live; nothing is published and no version is made. The server side is
// spacesheep's /api/streams routes and the owner's StreamHub.
//
// Where values come from, one of:
//   --run "cmd"            a long-running command; every line it prints is a value
//   --every 1s -- cmd …    run a command on an interval; its output is the value
//   (nothing)              lines on stdin: `collector | spacesheep stream lab/x`
// A line that parses as JSON is sent as JSON, anything else as text.
//
// Buttons: `--on name=cmd` (repeatable) and/or `--on-dir DIR` (DIR/<name>, executable).
// Only what is listed runs; any other press is answered "refused". A press that
// happened before this process started is never run.
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const readline = require("readline");

const BATCH_MAX = 50;
const QUEUE_MAX = 200;
const KIDS_MAX = 4;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseEvery(s) {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)?$/.exec(String(s || "").trim());
  if (!m) return null;
  const n = Number(m[1]) * (m[2] === "m" ? 60000 : m[2] === "ms" ? 1 : 1000);
  return n >= 50 ? n : null;
}

/** A line of output → the value to send. */
function lineValue(line) {
  const t = String(line).replace(/\s+$/, "");
  if (!t) return undefined;
  if (/^[\[{"\d-]|^(true|false|null)$/.test(t)) { try { return JSON.parse(t); } catch {} }
  return t;
}

function buttonsFrom(opts) {
  const map = new Map();
  for (const spec of [].concat(opts.on || [])) {
    const i = String(spec).indexOf("=");
    if (i < 1) throw new Error(`--on takes name=command (got "${spec}")`);
    map.set(spec.slice(0, i).trim().toLowerCase(), { cmd: spec.slice(i + 1) });
  }
  const dir = opts.onDir ? path.resolve(opts.onDir) : null;
  if (dir && !fs.existsSync(dir)) throw new Error(`--on-dir ${dir} does not exist`);
  return { map, dir };
}

function resolveButton(buttons, name) {
  if (buttons.map.has(name)) return { shell: buttons.map.get(name).cmd };
  if (buttons.dir && /^[a-z0-9][a-z0-9_:.-]{0,63}$/.test(name) && name !== "." && name !== "..") {
    const file = path.join(buttons.dir, name);
    try {
      const st = fs.statSync(file);
      if (st.isFile()) { fs.accessSync(file, fs.constants.X_OK); return { file }; }
    } catch {}
  }
  return null;
}

async function run(opts, cfg, log) {
  const name = String(opts._[0] || "").trim().toLowerCase();
  if (!name) throw new Error("usage: spacesheep stream <name> [--run \"cmd\" | --every 1s -- cmd …] [--on name=cmd]… [--on-dir DIR]");
  const k = cfg.resolveKey();
  if (!k) throw Object.assign(new Error("not signed in — run `spacesheep login --scope stream` (a key that can only push to your streams), or set SPACESHEEP_KEY"), { code: "EAUTH" });
  const base = `${cfg.appOrigin()}/api/streams/${name.split("/").map(encodeURIComponent).join("/")}`;
  const auth = { Authorization: `Bearer ${k.key}` };
  const buttons = buttonsFrom(opts);
  // --load-test: the built-in buttons (lib/loadtest.js). --on / --on-dir entries win
  // over a built-in of the same name.
  const lt = opts.loadTest ? require("./loadtest").createLoadTest() : null;
  const listening = buttons.map.size > 0 || !!buttons.dir || !!lt;
  const every = opts.every ? parseEvery(opts.every) : null;
  if (opts.every && !every) throw new Error(`--every takes a duration like 500ms, 1s or 1m (at least 50ms)`);
  const cmdArgv = Array.isArray(opts.cmd) && opts.cmd.length ? opts.cmd : null;
  const producer = opts.run ? { shell: String(opts.run) } : cmdArgv ? { argv: cmdArgv } : null;
  // --system: this machine's own numbers, read in-process (lib/system.js) — no script.
  const system = !!opts.system;
  if (system && producer) throw new Error("--system reads this machine itself; drop --run / the command, or drop --system");
  if (every && !producer && !system) throw new Error("--every needs a command: --every 1s -- cat /proc/loadavg");
  const fromStdin = !producer && !system && !process.stdin.isTTY;
  if (!producer && !system && !fromStdin && !listening) throw new Error("nothing to push: give --system, --run \"cmd\", --every 1s -- cmd, or pipe lines in");

  let stopping = false;
  const kids = new Set();
  const stats = { pushed: 0, failed: 0, ms: [], viewers: 0, since: Date.now() };
  const say = (s) => log(`  ${new Date().toISOString().slice(11, 19)} ${s}`);

  // --- pushing: one request in flight, everything that arrived meanwhile goes as one batch.
  const queue = [];
  let flushing = false;
  function enqueue(v) {
    if (v === undefined) return;
    queue.push({ v, t: Date.now() });
    if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
    if (!flushing) flush();
  }
  async function flush() {
    flushing = true;
    let backoff = 1000;
    while (queue.length && !stopping) {
      const items = queue.splice(0, BATCH_MAX);
      const t0 = Date.now();
      let res, body;
      try {
        res = items.length === 1
          ? await fetch(`${base}?t=${items[0].t}`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(items[0].v) })
          : await fetch(`${base}?batch=1`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(items) });
        body = await res.json().catch(() => ({}));
      } catch (e) {
        queue.unshift(...items);
        if (queue.length > QUEUE_MAX) queue.splice(0, queue.length - QUEUE_MAX);
        stats.failed++;
        say(`! push failed (${e.message}); retrying in ${backoff / 1000}s`);
        await sleep(backoff); backoff = Math.min(backoff * 2, 30000);
        continue;
      }
      if (res.status === 429) { queue.unshift(...items); await sleep(Number(body.retry_ms) || 200); continue; }
      if (res.status === 401 || res.status === 403) return fatal(body.error || `the server refused the key (HTTP ${res.status})`);
      if (!res.ok) { stats.failed++; say(`! push refused: ${body.error || `HTTP ${res.status}`}`); continue; }
      backoff = 1000;
      if (body.created) say(`✓ stream ${name} created — declare it on a page: <meta name="ss-streams" content="${name}">`);
      stats.pushed += items.length;
      stats.ms.push(Date.now() - t0);
      stats.viewers = body.viewers || 0;
    }
    flushing = false;
  }

  // --- producing
  function lines(stream) {
    const rl = readline.createInterface({ input: stream });
    rl.on("line", (l) => enqueue(lineValue(l)));
    return rl;
  }
  async function runLong() {
    while (!stopping) {
      const child = producer.shell ? spawn("/bin/sh", ["-c", producer.shell], { stdio: ["ignore", "pipe", "inherit"] }) : spawn(producer.argv[0], producer.argv.slice(1), { stdio: ["ignore", "pipe", "inherit"] });
      kids.add(child);
      lines(child.stdout);
      const code = await new Promise((r) => { child.on("exit", r); child.on("error", (e) => { say(`! ${e.message}`); r(1); }); });
      kids.delete(child);
      if (stopping) break;
      if (opts.once) { stopping = true; break; }
      say(`! the command exited (${code}); starting it again in 2s`);
      await sleep(2000);
    }
  }
  async function runEvery() {
    while (!stopping) {
      const t0 = Date.now();
      const out = await new Promise((resolve) => {
        const child = producer.shell ? spawn("/bin/sh", ["-c", producer.shell], { stdio: ["ignore", "pipe", "inherit"] }) : spawn(producer.argv[0], producer.argv.slice(1), { stdio: ["ignore", "pipe", "inherit"] });
        let buf = "";
        child.stdout.on("data", (d) => { if (buf.length < 16384) buf += d; });
        child.on("exit", () => resolve(buf));
        child.on("error", (e) => { say(`! ${e.message}`); resolve(""); });
      });
      enqueue(lineValue(out.trim()));
      if (opts.once) { stopping = true; break; }
      await sleep(Math.max(0, every - (Date.now() - t0)));
    }
  }

  async function runSystem() {
    const sample = require("./system").createSampler({ host: opts.host });
    const ms = every || 500;
    const offered = lt ? lt.buttons.concat([...buttons.map.keys()]) : buttons.map.size ? [...buttons.map.keys()] : undefined;
    await sleep(Math.min(ms, 500));
    while (!stopping) {
      const t0 = Date.now();
      enqueue(sample({ test: lt ? lt.state() : null, ...(offered ? { buttons: offered } : {}) }));
      if (opts.once) { stopping = true; break; }
      await sleep(Math.max(0, ms - (Date.now() - t0)));
    }
  }

  // --- listening for presses
  async function ack(seq, status, note) {
    try {
      await fetch(`${base}/-/ack`, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ seq, status, note: String(note || "").slice(0, 300) }) });
    } catch {}
  }
  function press(ev) {
    const b = resolveButton(buttons, ev.name);
    if (!b && lt && lt.has(ev.name)) {
      const r = lt.press(ev.name, ev.data);
      say(`${r.status === "refused" ? "·" : "▶"} ${ev.name}: ${r.note} (pressed by ${ev.from || "someone"})`);
      return ack(ev.seq, r.status, r.note);
    }
    if (!b) { say(`· press "${ev.name}" refused (not a button on this machine)`); return ack(ev.seq, "refused", `no button "${ev.name}" on this machine`); }
    if (kids.size >= KIDS_MAX + (producer ? 1 : 0)) return ack(ev.seq, "refused", "busy: too many buttons running");
    const env = { ...process.env, SS_STREAM: name, SS_STREAM_EVENT: ev.name, SS_STREAM_DATA: JSON.stringify(ev.data ?? null) };
    delete env.SPACESHEEP_KEY;
    const child = b.file ? spawn(b.file, [], { env, stdio: ["ignore", "pipe", "pipe"] }) : spawn("/bin/sh", ["-c", b.shell], { env, stdio: ["ignore", "pipe", "pipe"] });
    kids.add(child);
    let tail = "";
    const keep = (d) => { tail = (tail + d).slice(-600); };
    child.stdout.on("data", keep); child.stderr.on("data", keep);
    say(`▶ ${ev.name} (pressed by ${ev.from || "someone"})`);
    ack(ev.seq, "started", ev.name);
    child.on("exit", (code) => {
      kids.delete(child);
      const last = tail.trim().split("\n").pop() || "";
      say(`${code === 0 ? "✓" : "✗"} ${ev.name} exited ${code}${last ? ` — ${last.slice(0, 120)}` : ""}`);
      ack(ev.seq, code === 0 ? "done" : "failed", last || `exit ${code}`);
    });
    child.on("error", (e) => { kids.delete(child); ack(ev.seq, "failed", e.message); });
  }
  async function listen() {
    let cursor = 0, first = true, backoff = 1000;
    while (!stopping) {
      let r;
      try {
        const res = await fetch(`${base}/-/events?after=${cursor}&wait=${first ? 0 : 25000}`, { headers: auth });
        if (res.status === 401 || res.status === 403) { const b = await res.json().catch(() => ({})); return fatal(b.error || `the server refused the key (HTTP ${res.status})`); }
        r = await res.json();
      } catch (e) {
        await sleep(backoff); backoff = Math.min(backoff * 2, 30000); continue;
      }
      backoff = 1000;
      // The first answer only sets the cursor: a press from before this process started never runs.
      if (!first) for (const ev of r.events || []) press(ev);
      cursor = Math.max(cursor, Number(r.cursor) || 0);
      if (first) { first = false; say(`listening for ${[...buttons.map.keys()].concat(buttons.dir ? [`${buttons.dir}/*`] : [], lt ? lt.buttons : []).join(", ")}`); }
    }
  }

  // A refused key ends the process (exit 3) — a service manager restarting it would
  // only be refused again, so say why once, loudly.
  function fatal(msg) {
    stopping = true;
    console.error(`\n  ✗ ${msg}\n`);
    for (const c of kids) { try { c.kill("SIGTERM"); } catch {} }
    process.exit(3);
  }
  const stop = () => { stopping = true; if (lt) lt.stop(); for (const c of kids) { try { c.kill("SIGTERM"); } catch {} } setTimeout(() => process.exit(0), 300); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const report = setInterval(() => {
    if (!stats.pushed && !stats.failed) return;
    const ms = stats.ms.slice().sort((a, b) => a - b);
    say(`${stats.pushed} value(s) in ${Math.round((Date.now() - stats.since) / 1000)}s · push p50 ${ms[Math.floor(ms.length / 2)] ?? "–"} ms · ${stats.viewers} viewer(s)${stats.failed ? ` · ${stats.failed} failed` : ""}`);
    stats.pushed = 0; stats.failed = 0; stats.ms = []; stats.since = Date.now();
  }, 60000);
  report.unref();

  say(`streaming to ${name} on ${cfg.appOrigin()}`);
  const jobs = [];
  if (system) jobs.push(runSystem());
  else if (producer) jobs.push(every ? runEvery() : runLong());
  else if (fromStdin) jobs.push(new Promise((resolve) => lines(process.stdin).on("close", resolve)));
  if (listening) jobs.push(listen());
  await Promise.all(jobs);
  // Drain what is still queued before exiting (stdin closed, --once).
  while (queue.length || flushing) { if (!flushing) await flush(); else await sleep(50); }
}

async function list(opts, cfg, out) {
  const k = cfg.resolveKey();
  if (!k) throw Object.assign(new Error("not signed in — run `spacesheep login`"), { code: "EAUTH" });
  const prefix = opts._[0] ? `?prefix=${encodeURIComponent(opts._[0])}` : "";
  const res = await fetch(`${cfg.appOrigin()}/api/streams${prefix}`, { headers: { Authorization: `Bearer ${k.key}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  if (opts.json) return out(body.streams || []);
  if (!(body.streams || []).length) return out("no streams yet — `spacesheep stream <name> …` makes one with its first value");
  for (const s of body.streams) {
    const age = s.last_at ? `${Math.round((Date.now() - s.last_at) / 1000)}s ago` : "never";
    out(`${s.path.padEnd(32)} ${String(s.hz).padStart(5)} Hz  ${String(s.viewers).padStart(3)} watching  ${s.listening ? "listening" : "         "}  last ${age}`);
  }
}

/** Does this key open the stream routes? Throws EAUTH with the server's words if not. */
async function checkKey(cfg, key) {
  let res;
  try { res = await fetch(`${cfg.appOrigin()}/api/streams`, { headers: { Authorization: `Bearer ${key}` } }); }
  catch (e) { throw Object.assign(new Error(`could not reach ${cfg.appOrigin()} (${e.message})`), { code: "ENET" }); }
  if (res.ok) return true;
  const body = await res.json().catch(() => ({}));
  throw Object.assign(new Error(body.error || `the server refused the key (HTTP ${res.status})`), { code: "EAUTH" });
}

module.exports = { run, list, checkKey, lineValue, parseEvery, resolveButton, buttonsFrom };
