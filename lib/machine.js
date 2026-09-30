"use strict";
// `spacesheep machine` — let spacesheep.dev reach this machine's coding sessions.
//
//   spacesheep machine on [--folder DIR]... [--mode safe|auto] [--name NAME] [--no-service]
//   spacesheep machine pair      add another passkey (a second device) to this machine
//   spacesheep machine status    what is set up, and whether the listener runs
//   spacesheep machine off       stop the listener and forget everything it trusted
//   spacesheep machine run       the listener itself (the background service runs this)
//
// One small background process per machine listens for the account owner's messages
// to ANY Claude Code session on it, and for requests to START a new session in one of
// the folders the owner allowed here. It replaces a listener per session (`talk
// listen`), which each session had to be talked into starting.
//
// Nothing the server says is trusted. `on` pairs the machine with the owner's passkey
// (Touch ID / Face ID) at THIS terminal: the person sees the same six digits here and
// on the page, the page makes a passkey assertion over the pairing code, and the
// machine verifies it before it keeps the key (machine-verify.js). From then on every
// command must carry signatures this machine checks itself against those keys, so a
// stolen web login — or the server — can't make it run anything. The server only
// relays: it hands out jobs (`wait`) and takes reports (`jobs/:id`).
//
// What a verified command does is fixed here too: `claude -p` in the session's own
// folder (read from its transcript on this disk, never from the server), in a
// permission mode that can't approve anything by itself, with the owner's words
// behind a fixed line that says where they came from. A session that is open in a
// terminal right now is never written to: its message goes to a copy
// (`--fork-session`), and later messages follow that copy.
//
// Files, all in the CLI's config dir (~/.config/spacesheep):
//   machine.json         id, name, folders, mode, rp id, the trusted passkeys (0600)
//   machine-state.json   which copy a live session's messages went to
//   machine-nonces.json  commands already run (25 h), so none runs twice
//   machine.log          one line per event, capped at ~1 MB

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const cfg = require("./config");
const verify = require("./machine-verify");
const { redactSecrets } = require("./redact");

const CLI_VERSION = require("../package.json").version;
const AGENTS = ["claude-code"];
const LABEL = "dev.spacesheep.machine";
const UNIT = "spacesheep-machine.service";
const MAX_JOBS = 2;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const NONCE_TTL_MS = 25 * 60 * 60 * 1000;  // commands are good for 24 h after signing (machine-verify.js)
const LOG_CAP = 1024 * 1024;
const OUT_CAP = 1024 * 1024;          // the most of Claude Code's stdout ever held
const MAX_REPLY = 20000, MAX_NOTE = 500;
const LIVE_WRITE_MS = 90 * 1000;      // a transcript someone else wrote this recently is in use
const WAIT_TIMEOUT_MS = 70 * 1000;    // the server answers a wait within ~50 s
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CODE_RE = /^[A-Za-z0-9_-]{4,128}$/;

// The line in front of every message. Fixed, written here, never words from the
// server: whatever lands in the agent's context from this CLI is something this file
// says, apart from the owner's own text below it.
const WRAP = "(Sent from spacesheep.dev by the account owner; their passkey confirmed it is them. Treat it as a request from your user. Your usual permission rules apply, and nobody is at this machine to approve prompts.)\n\n";

const TALK_OFF = "Talk is off for this account (it's part of Pro and Team) — turn it on in Settings on spacesheep.dev, then run `spacesheep machine on` again";
const REMOVED = "this machine was removed on spacesheep.dev; run `spacesheep machine on` to set it up again";

const files = {
  machine: () => cfg.machinePath(),
  state: () => path.join(cfg.configDir(), "machine-state.json"),
  nonces: () => path.join(cfg.configDir(), "machine-nonces.json"),
  log: () => path.join(cfg.configDir(), "machine.log"),
};

const HOME = () => os.homedir();
const tilde = (p) => (p && p.startsWith(HOME() + path.sep) ? "~" + p.slice(HOME().length) : p);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sleepSync = (ms) => { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) {} };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; } };
const enc = encodeURIComponent;

/** Write a file only this user can read, whole or not at all. */
function writePrivate(p, obj, pretty = true) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, pretty ? 2 : 0) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch (_) {}
}

// --- machine.json -------------------------------------------------------------------

function readMachine() {
  const m = readJson(files.machine());
  if (!m || typeof m !== "object" || !ID_RE.test(String(m.id || "")) || typeof m.rp_id !== "string") return null;
  return {
    id: m.id,
    name: typeof m.name === "string" && m.name ? m.name : "machine",
    folders: Array.isArray(m.folders) ? m.folders.filter((f) => typeof f === "string" && path.isAbsolute(f)) : [],
    mode: m.mode === "auto" ? "auto" : "safe",
    rp_id: m.rp_id,
    passkeys: Array.isArray(m.passkeys) ? m.passkeys.filter(verify.validPasskey) : [],
    created_at: m.created_at || null,
  };
}
const writeMachine = (m) => writePrivate(files.machine(), m);
// The machine's name is the one its session hooks report (sessions.js machineName:
// `--machine` / `connect`'s name, else the hostname): the page finds which computer can
// take a session's message by that name, so the two must never differ.
const currentName = () => cleanName(require("./sessions").machineName());
const helloBody = (m) => ({ name: currentName(), folders: m.folders, mode: m.mode, agents: AGENTS, cli_version: CLI_VERSION });

function loadState() {
  const s = readJson(files.state());
  const copies = {};
  if (s && s.copies && typeof s.copies === "object") {
    for (const [k, v] of Object.entries(s.copies)) if (verify.UUID_RE.test(k) && verify.UUID_RE.test(String(v))) copies[k] = v;
  }
  return { copies };
}
const saveState = (s) => { try { writePrivate(files.state(), s); } catch (_) {} };

/** Commands already run, for 25 hours (a command is good for 24 h after it was
 *  signed, plus clock skew). `seen` checks and remembers in one step, and
 *  refuses (throws) when it can't write the record down: a nonce kept only in memory
 *  would let a restart run the same command twice. The file is read again on every
 *  check, so a second listener started by hand shares the record instead of
 *  overwriting it. */
function nonceStore(file = files.nonces(), now = Date.now) {
  const map = new Map();
  const load = () => {
    const raw = readJson(file);
    if (raw && typeof raw === "object") {
      for (const [k, t] of Object.entries(raw)) if (typeof t === "number" && now() - t < NONCE_TTL_MS && !map.has(k)) map.set(k, t);
    }
  };
  load();
  return {
    seen(n) {
      load();
      const t = now();
      for (const [k, at] of map) if (t - at >= NONCE_TTL_MS) map.delete(k);
      if (map.has(n)) return true;
      map.set(n, t);
      const o = {};
      for (const [k, at] of map) o[k] = at;
      try { writePrivate(file, o, false); } catch (e) {
        map.delete(n);
        throw new Error(`couldn't record the command on this machine (${e.code || e.message}), so it didn't run`);
      }
      return false;
    },
    size: () => map.size,
  };
}

// --- talking to spacesheep.dev ------------------------------------------------------

/** One call to the app with the CLI's key. Never throws: status 0 is "no answer". */
async function api(key, method, route, body, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const headers = { authorization: "Bearer " + key, "cache-control": "no-store" };
    if (body) headers["content-type"] = "application/json";
    const r = await fetch(cfg.appOrigin() + route, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    let json = null;
    try { json = await r.json(); } catch (_) {}
    return { status: r.status, json };
  } catch (_) {
    return { status: 0, json: null };
  } finally {
    clearTimeout(t);
  }
}
const httpWhy = (r) => (r.status ? `HTTP ${r.status}` : "no answer");

// --- folders ------------------------------------------------------------------------

const real = (p) => { try { return fs.realpathSync.native(p); } catch (_) { return null; } };
const inside = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

/** `--folder` values as absolute real paths of folders that exist. */
function resolveFolders(list, cwd = process.cwd()) {
  const out = [];
  for (const raw of list) {
    let f = String(raw);
    if (f === "~" || f.startsWith("~/")) f = path.join(HOME(), f.slice(1));
    const r = real(path.resolve(cwd, f));
    if (!r) throw new Error(`--folder ${raw}: no such folder`);
    if (!fs.statSync(r).isDirectory()) throw new Error(`--folder ${raw} is a file, not a folder`);
    // The whole disk is not a project. Pick the folders your sessions work in.
    if (r === path.parse(r).root) throw new Error(`--folder ${raw} is the whole disk; name the project folders instead`);
    if (!out.includes(r)) out.push(r);
  }
  return out;
}
const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];

/** The folders this computer's Claude Code sessions worked in over the last 30 days,
 *  newest first: what `machine on` offers when it is run from the home folder, which
 *  is not a project. Reads the newest transcript of the 40 most recent project dirs. */
function recentFolders(dirs = require("./sessions").claudeDirs(), now = Date.now()) {
  const seen = [];
  for (const dir of dirs) {
    let projects = [];
    try { projects = fs.readdirSync(path.join(dir, "projects"), { withFileTypes: true }).filter((p) => p.isDirectory()); } catch (_) { continue; }
    for (const p of projects) {
      const pdir = path.join(dir, "projects", p.name);
      let newest = null;
      try {
        for (const f of fs.readdirSync(pdir)) {
          if (!f.endsWith(".jsonl")) continue;
          const m = fs.statSync(path.join(pdir, f)).mtimeMs;
          if (!newest || m > newest.m) newest = { f, m };
        }
      } catch (_) { continue; }
      if (newest && now - newest.m < 30 * 86400 * 1000) seen.push({ file: path.join(pdir, newest.f), project: p.name, m: newest.m });
    }
  }
  seen.sort((a, b) => b.m - a.m);
  const out = [];
  for (const t of seen.slice(0, 40)) {
    const f = sessionFolder(t);
    const r = f && real(f);
    if (!r || r === HOME() || r === path.parse(r).root || out.includes(r)) continue;
    // A worktree lives inside its project: the project covers it.
    if (out.some((o) => inside(r, o))) continue;
    out.push(r);
  }
  return out;
}

function askLine(q) {
  return new Promise((resolve) => {
    const rl = require("readline").createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); resolve(a); });
  });
}

/** Where the agent may work when `--folder` wasn't given: the folder this runs in,
 *  unless that is the home folder (or the disk), which is not a project — then the
 *  folders recent sessions used, to pick from. */
async function defaultFolders(log, deps = {}) {
  const cwd = real(process.cwd());
  if (cwd && cwd !== HOME() && cwd !== path.parse(cwd).root) return [cwd];
  const recent = (deps.recentFolders || recentFolders)();
  const ask = deps.ask || (process.stdin.isTTY ? askLine : null);
  if (!recent.length || !ask) {
    const hint = recent.length ? ` Lately your sessions worked in ${recent.slice(0, 4).map(tilde).join(", ")}.` : "";
    throw new Error(`run this inside the project folder the agent may work in, or pass --folder <dir>.${hint}`);
  }
  const list = recent.slice(0, 6);
  log("  Which folders may the agent work in? Your recent sessions ran in:");
  list.forEach((f, i) => log(`    ${i + 1}) ${tilde(f)}`));
  const a = String(await ask(`  Pick with numbers (Enter = 1): `)).trim();
  const picks = (a || "1").split(/[\s,]+/).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= list.length);
  if (!picks.length) throw new Error("no folder picked — run it again, or pass --folder <dir>");
  return [...new Set(picks.map((n) => list[n - 1]))];
}

/** The real path of `dir` when it is one of the allowed folders or inside one, else null. */
function allowedFolder(dir, folders) {
  if (typeof dir !== "string" || !path.isAbsolute(dir)) return null;
  const r = real(dir);
  if (!r) return null;
  try { if (!fs.statSync(r).isDirectory()) return null; } catch (_) { return null; }
  return folders.some((f) => inside(r, real(f) || f)) ? r : null;
}

// --- Claude Code on this machine -----------------------------------------------------

function isExe(p) {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch (_) { return false; }
}
const cmpVersion = (a, b) => {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

/** The `claude` to run: on PATH, else where the installers put it, else the newest
 *  copy the Claude desktop app ships. Null when this machine has none. */
function findClaude(env = process.env) {
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"];
  for (const d of String(env.PATH || "").split(path.delimiter)) {
    if (!d || !path.isAbsolute(d)) continue;
    for (const n of names) if (isExe(path.join(d, n))) return path.join(d, n);
  }
  const home = HOME();
  for (const p of [path.join(home, ".claude", "local", "claude"), path.join(home, ".local", "bin", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"]) {
    if (isExe(p)) return p;
  }
  const app = path.join(home, "Library", "Application Support", "Claude", "claude-code");
  let versions = [];
  try { versions = fs.readdirSync(app).filter((n) => /^\d+(\.\d+)*$/.test(n)).sort(cmpVersion).reverse(); } catch (_) {}
  for (const v of versions) {
    const p = path.join(app, v, "claude.app", "Contents", "MacOS", "claude");
    if (isExe(p)) return p;
  }
  return null;
}

/** One option's text in `claude --help`: its line and the lines under it. An option
 *  starts at the left margin (commander indents them two spaces); its description
 *  wraps onto deeper-indented lines, which can themselves begin with a flag name
 *  ("--print: …"), so only the indent tells a new option from a continuation. */
function optionBlock(help, flag) {
  const lines = String(help || "").split("\n");
  const re = new RegExp(`^\\s{0,4}(?:-\\w, )?${flag.replace(/[-]/g, "\\-")}(?![\\w-])`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length && lines[i].trim() && !/^\s{0,4}-/.test(lines[i]); i++) out.push(lines[i]);
  return out.join(" ");
}

/** What this Claude Code's `--help` says it can do: the permission modes it lists,
 *  whether prompts can be pointed at nobody, whether a session can be copied. */
function parseCaps(help) {
  const pm = optionBlock(help, "--permission-mode");
  const pp = optionBlock(help, "--permission-prompts");
  return {
    hasMode: !!pm,
    modes: pm ? [...pm.matchAll(/"([A-Za-z]+)"/g)].map((m) => m[1]) : [],
    promptsNone: !!pp && /"none"/.test(pp),
    fork: !!optionBlock(help, "--fork-session"),
  };
}

/** The permission flags for this machine's mode. Safe: `dontAsk` (nothing that needs
 *  approval runs), else the default mode with prompts answered by nobody. Auto:
 *  Claude Code's own auto mode, or a refusal when this one has none. Never
 *  bypassPermissions — there is no path here that writes it. */
function modeFlags(mode, caps) {
  if (mode === "auto") {
    if (!caps.modes.includes("auto")) return { error: "this machine is in auto mode, but its Claude Code has no auto permission mode — update Claude Code, or run `spacesheep machine on --mode safe`" };
    return { args: ["--permission-mode", "auto"] };
  }
  if (caps.modes.includes("dontAsk")) return { args: ["--permission-mode", "dontAsk"] };
  const args = [];
  if (caps.hasMode) args.push("--permission-mode", caps.modes.includes("manual") && !caps.modes.includes("default") ? "manual" : "default");
  if (caps.promptsNone) args.push("--permission-prompts", "none");
  return { args };
}

/** The env a job's Claude Code runs with: the listener's own, minus the markers that
 *  make a Claude Code think it runs inside another session, with CLAUDE_CONFIG_DIR
 *  naming the account the session belongs to (undefined: leave it as it is). */
function claudeEnv(configDir) {
  const env = { ...process.env };
  for (const k of ["CLAUDECODE", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "CLAUDE_CODE_SSE_PORT"]) delete env[k];
  // Marks the run as a machine job, so a Stop hook that would force one more turn
  // (a "save this to memory" continuation) can stand down: the job's last words are
  // the reply the person reads on the page, and a continuation replaces them.
  env.SPACESHEEP_MACHINE_JOB = "1";
  if (configDir !== undefined) {
    if (path.resolve(configDir) === path.resolve(HOME(), ".claude")) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = configDir;
  }
  return env;
}

function detectCaps(bin) {
  let help = "";
  try {
    help = execFileSync(bin, ["--help"], { encoding: "utf8", timeout: 30000, env: claudeEnv(), stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 });
  } catch (e) {
    help = String((e && e.stdout) || "");
  }
  return parseCaps(help);
}

// --- sessions on this disk ------------------------------------------------------------

/** A session's transcript: <config dir>/projects/<folder>/<session>.jsonl, in any
 *  Claude Code config dir on this machine. The id is a validated uuid, so it can't
 *  climb out of the projects dir. */
function findTranscript(session, dirs = require("./sessions").claudeDirs()) {
  if (!verify.UUID_RE.test(String(session))) return null;
  for (const dir of dirs) {
    let projects = [];
    try { projects = fs.readdirSync(path.join(dir, "projects"), { withFileTypes: true }); } catch (_) { continue; }
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const file = path.join(dir, "projects", p.name, session + ".jsonl");
      try { if (fs.statSync(file).isFile()) return { file, configDir: dir, project: p.name }; } catch (_) {}
    }
  }
  return null;
}

/** Claude Code files a session under its folder with every non-alphanumeric
 *  character turned into "-" (/Users/me/app → -Users-me-app). */
const projectName = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

/** The folder a session runs in, from its transcript's own records: the `cwd` whose
 *  project name is the folder the transcript is filed under (that is the one
 *  `--resume` looks in), else the first `cwd`. Reads line by line, a few MB at most;
 *  a line longer than 2 MB (pasted screenshots) is skipped, not held. */
function sessionFolder(t, cap = 8 * 1024 * 1024) {
  let first = null, fd, count = 0;
  const look = (line) => {
    if (line.indexOf('"cwd"') < 0) return null;
    let j;
    try { j = JSON.parse(line.toString("utf8")); } catch (_) { return null; }
    if (!j || typeof j.cwd !== "string" || !path.isAbsolute(j.cwd)) return null;
    if (projectName(j.cwd) === t.project) return j.cwd;
    if (!first) first = j.cwd;
    count++;
    return null;
  };
  try {
    fd = fs.openSync(t.file, "r");
    const buf = Buffer.alloc(256 * 1024);
    let pos = 0, rest = Buffer.alloc(0), skipping = false;
    while (pos < cap && count < 50) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) { if (!skipping && rest.length) { const hit = look(rest); if (hit) return hit; } break; }
      pos += n;
      let chunk = rest.length ? Buffer.concat([rest, buf.subarray(0, n)]) : buf.subarray(0, n);
      let nl;
      while ((nl = chunk.indexOf(10)) >= 0) {
        const line = chunk.subarray(0, nl);
        chunk = chunk.subarray(nl + 1);
        if (skipping) { skipping = false; continue; }
        const hit = look(line);
        if (hit) return hit;
      }
      if (chunk.length > 2 * 1024 * 1024) { skipping = true; rest = Buffer.alloc(0); }
      else rest = skipping ? Buffer.alloc(0) : Buffer.from(chunk);
    }
  } catch (_) {
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
  return first;
}

function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/** A Claude Code process that has this session open right now: its registry file,
 *  <config dir>/sessions/<pid>.json, names the session and the pid is alive. */
function liveProcess(session, configDir) {
  let names = [];
  try { names = fs.readdirSync(path.join(configDir, "sessions")).filter((n) => /^\d+\.json$/.test(n)); } catch (_) { return false; }
  for (const n of names) {
    const j = readJson(path.join(configDir, "sessions", n));
    if (!j || String(j.sessionId) !== session) continue;
    if (pidAlive(Number(j.pid || n.slice(0, -5)))) return true;
  }
  return false;
}

/** The transcript was written in the last 90 seconds, and not by a job of ours. The
 *  registry can miss a live process (a session resumed with --continue files its
 *  entry under another id), and two writers on one transcript is exactly what the
 *  copy exists to avoid — so a session that is visibly working counts as open. */
function recentlyWritten(file, ourLastEnd, now = Date.now()) {
  let m;
  try { m = fs.statSync(file).mtimeMs; } catch (_) { return false; }
  if (now - m > LIVE_WRITE_MS) return false;
  return !(ourLastEnd && m <= ourLastEnd + 2000);
}

// --- running one job ------------------------------------------------------------------

/** Run Claude Code, holding at most OUT_CAP of its stdout and the tail of its stderr.
 *  Its own process group, so the 30-minute limit stops the tools it started too. */
function runClaude(bin, args, { cwd, env, timeoutMs = JOB_TIMEOUT_MS, children }) {
  return new Promise((resolve) => {
    let out = [], outLen = 0, tooBig = false, errTail = "", timedOut = false, settled = false;
    let child;
    try {
      child = spawn(bin, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    } catch (e) {
      return resolve({ error: e.message });
    }
    if (children) children.add(child);
    const kill = (sig) => {
      try { if (process.platform !== "win32") process.kill(-child.pid, sig); else child.kill(sig); } catch (_) { try { child.kill(sig); } catch (_) {} }
    };
    child.stdout.on("data", (b) => {
      if (tooBig) return;
      if (outLen + b.length > OUT_CAP) { tooBig = true; out = []; return; }
      out.push(b); outLen += b.length;
    });
    child.stderr.on("data", (b) => { errTail = (errTail + b.toString("utf8")).slice(-4000); });
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 10000).unref();
    }, timeoutMs);
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (children) children.delete(child);
      resolve(r);
    };
    const result = (code, signal) => ({ code, signal, stdout: tooBig ? null : Buffer.concat(out).toString("utf8"), tooBig, stderr: errTail, timedOut });
    child.on("error", (e) => finish({ error: e.message }));
    // A tool the agent left running can hold stdout open after Claude Code exits, so
    // "exit" plus a moment for the pipes, not "close", ends the wait.
    child.on("exit", (code, signal) => setTimeout(() => finish(result(code, signal)), 2000).unref());
    child.on("close", (code, signal) => finish(result(code, signal)));
  });
}

/** `--output-format json`'s answer: one result object (or, with --verbose, an array
 *  whose last `result` entry it is). */
function parseResult(stdout) {
  const s = String(stdout || "").trim();
  if (!s) return null;
  const pick = (j) => {
    if (Array.isArray(j)) { for (let i = j.length - 1; i >= 0; i--) if (j[i] && j[i].type === "result") return j[i]; return null; }
    return j && typeof j === "object" ? j : null;
  };
  try { return pick(JSON.parse(s)); } catch (_) {}
  const lines = s.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try { const j = pick(JSON.parse(lines[i])); if (j && (j.type === "result" || "result" in j)) return j; } catch (_) {}
  }
  return null;
}

/** The reply for the session's thread: the agent's answer, redacted like everything
 *  else that leaves this machine, and a line naming the tools it wasn't allowed. */
function replyFrom(r) {
  const denials = Array.isArray(r.permission_denials) ? r.permission_denials : [];
  const names = [...new Set(denials.map((d) => d && d.tool_name).filter((n) => typeof n === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(n)))];
  const line = !denials.length ? ""
    : names.length ? `\n\n(Not allowed on this machine, since nobody was there to approve: ${names.join(", ")}.)`
      : `\n\n(${denials.length} action${denials.length === 1 ? " was" : "s were"} not allowed on this machine, since nobody was there to approve.)`;
  let text = typeof r.result === "string" && r.result.trim() ? r.result : "(Claude Code finished without a written reply.)";
  text = redactSecrets(text);
  return text.slice(0, MAX_REPLY - line.length) + line;
}
const noteText = (s) => redactSecrets(String(s || "").replace(/\s+/g, " ").trim()).slice(0, MAX_NOTE);

/** Jobs run at most MAX_JOBS at once; two for the same session never at once, and in
 *  the order they came. */
class Scheduler {
  constructor(max = MAX_JOBS) { this.max = max; this.queue = []; this.busy = new Set(); this.active = 0; this.waiters = []; }
  push(key, task) { this.queue.push({ key, task }); this.pump(); }
  pump() {
    for (let i = 0; i < this.queue.length && this.active < this.max;) {
      const j = this.queue[i];
      if (this.busy.has(j.key)) { i++; continue; }
      this.queue.splice(i, 1);
      this.busy.add(j.key);
      this.active++;
      Promise.resolve().then(j.task).catch(() => {}).finally(() => {
        this.busy.delete(j.key);
        this.active--;
        this.pump();
        if (!this.active && !this.queue.length) this.waiters.splice(0).forEach((w) => w());
      });
    }
  }
  idle() { return !this.active && !this.queue.length ? Promise.resolve() : new Promise((r) => this.waiters.push(r)); }
}

/** The original a copy was made from, so a message to either queues behind the other. */
function rootOf(session, state) {
  for (const [orig, copy] of Object.entries(state.copies)) if (copy === session) return orig;
  return session;
}

/** Can Claude Code run on this machine, and with which flags? Detected once, and
 *  again only when the binary changes (Claude Code updates itself). */
function claudeInfo(ctx) {
  const bin = (ctx.findClaude || findClaude)();
  if (!bin) { ctx.claude = null; return null; }
  let sig = bin;
  try { const r = fs.realpathSync(bin); const st = fs.statSync(r); sig = `${r}:${st.size}:${st.mtimeMs}`; } catch (_) {}
  if (ctx.claude && ctx.claude.sig === sig) return ctx.claude;
  const caps = detectCaps(bin);
  ctx.claude = { bin, sig, caps };
  ctx.log(`Claude Code: ${tilde(bin)} · permission modes: ${caps.modes.join(", ") || "none listed"}${caps.promptsNone ? " · prompts can go to nobody" : ""}${caps.fork ? "" : " · can't copy a session"}`);
  return ctx.claude;
}

/** What a verified command will do, decided before the page is told "working on it".
 *  { ok:true, key } or { ok:false, status:"refused"|"failed", note }. */
function planJob(cmd, ctx) {
  const m = ctx.machine;
  const claude = claudeInfo(ctx);
  if (!claude) return { ok: false, status: "failed", note: `Claude Code isn't installed on ${m.name}` };
  const mf = modeFlags(m.mode, claude.caps);
  if (mf.error) return { ok: false, status: "refused", note: mf.error };
  if (cmd.action === "start") {
    if (!allowedFolder(cmd.cwd, m.folders)) {
      return { ok: false, status: "refused", note: real(cmd.cwd) ? `${tilde(cmd.cwd)} isn't inside a folder this machine allows — add it with \`spacesheep machine on --folder <dir>\` on ${m.name}` : `${tilde(cmd.cwd)} doesn't exist on ${m.name}` };
    }
    if (findTranscript(cmd.session)) return { ok: false, status: "refused", note: "that new session's id is already taken on this machine" };
    return { ok: true, key: cmd.session };
  }
  const t = findTranscript(cmd.session);
  if (!t) return { ok: false, status: "refused", note: `there's no Claude Code session ${cmd.session.slice(0, 8)} on ${m.name}` };
  const folder = sessionFolder(t);
  if (!folder) return { ok: false, status: "refused", note: "couldn't tell which folder that session runs in" };
  if (!allowedFolder(folder, m.folders)) {
    return { ok: false, status: "refused", note: real(folder) ? `that session runs in ${tilde(folder)}, which isn't a folder this machine allows — add it with \`spacesheep machine on --folder <dir>\` on ${m.name}` : `that session's folder, ${tilde(folder)}, is gone from ${m.name}` };
  }
  return { ok: true, key: rootOf(cmd.session, ctx.state) };
}

/** Run one planned job and report how it went. Everything is looked up again here:
 *  the job may have waited behind another for the same session. */
async function execute(job, cmd, ctx) {
  const m = ctx.machine;
  const fail = (status, note) => { ctx.log(`job ${job.id}: ${status} — ${note}`); return report(ctx, job.id, { status, note }); };
  ctx.running.add(job.id);
  try {
    const claude = claudeInfo(ctx);
    if (!claude) return await fail("failed", `Claude Code isn't installed on ${m.name}`);
    const mf = modeFlags(m.mode, claude.caps);
    if (mf.error) return await fail("refused", mf.error);
    let cwd, configDir, resume, target = cmd.session, forked = false;
    if (cmd.action === "start") {
      cwd = allowedFolder(cmd.cwd, m.folders);
      if (!cwd) return await fail("refused", `${tilde(cmd.cwd)} isn't inside a folder this machine allows`);
      resume = ["--session-id", cmd.session];
    } else {
      // Messages to a session that was open when an earlier message came went to a
      // copy; they keep going there, so the thread on the page stays one thread.
      let t = null;
      const copy = ctx.state.copies[cmd.session];
      if (copy) { t = findTranscript(copy); if (t) target = copy; }
      if (!t) { target = cmd.session; t = findTranscript(target); }
      if (!t) return await fail("refused", `there's no Claude Code session ${cmd.session.slice(0, 8)} on ${m.name}`);
      const folder = sessionFolder(t);
      cwd = folder && allowedFolder(folder, m.folders);
      if (!cwd) return await fail("refused", "that session's folder isn't one this machine allows");
      configDir = t.configDir;
      if (liveProcess(target, t.configDir) || recentlyWritten(t.file, ctx.lastEnd.get(target))) {
        if (!claude.caps.fork) return await fail("refused", "that session is open right now, and this Claude Code can't make a copy of it (no --fork-session) — try again once it has ended");
        resume = ["--resume", target, "--fork-session"];
        forked = true;
      } else {
        resume = ["--resume", target];
      }
    }
    const args = ["-p", "--output-format", "json", ...mf.args, ...resume, WRAP + cmd.text];
    ctx.log(`job ${job.id}: claude -p ${[...mf.args, ...resume].join(" ")} in ${tilde(cwd)} (${cmd.text.length} chars)`);
    const started = Date.now();
    const r = await runClaude(claude.bin, args, { cwd, env: claudeEnv(configDir), children: ctx.children, timeoutMs: ctx.jobTimeoutMs });
    ctx.lastEnd.set(target, Date.now());
    if (r.error) return await fail("failed", `couldn't start Claude Code: ${r.error}`);
    if (r.timedOut) return await fail("failed", "Claude Code was still working after 30 minutes, so it was stopped");
    if (r.tooBig) return await fail("failed", "Claude Code's answer was too large to read");
    const res = parseResult(r.stdout);
    if (!res) {
      const why = r.stderr.trim().split("\n").slice(-3).join(" ");
      return await fail("failed", `Claude Code exited (${r.signal || "code " + r.code}) without an answer${why ? ": " + why : ""}`);
    }
    const ran = typeof res.session_id === "string" && verify.UUID_RE.test(res.session_id) ? res.session_id : target;
    if (forked && ran !== target) {
      ctx.state.copies[cmd.session] = ran;
      saveState(ctx.state);
      ctx.lastEnd.set(ran, Date.now());
    }
    const body = { status: res.is_error ? "failed" : "done", session: ran };
    if (ran !== cmd.session) body.copy_of = cmd.session;
    if (res.is_error) body.note = noteText(res.result || res.subtype || "Claude Code reported an error");
    else body.reply = replyFrom(res);
    ctx.log(`job ${job.id}: ${body.status} in ${Math.round((Date.now() - started) / 1000)}s${ran !== cmd.session ? ` (as ${ran.slice(0, 8)}, a copy of ${cmd.session.slice(0, 8)})` : ""}${Array.isArray(res.permission_denials) && res.permission_denials.length ? ` · ${res.permission_denials.length} denied` : ""}`);
    return await report(ctx, job.id, body);
  } finally {
    ctx.running.delete(job.id);
  }
}

/** Tell the server how a job went. Retried through a blip or a deploy; a job left
 *  unreported sits at "working on it" on the page forever. */
async function report(ctx, jobId, body) {
  const b = { ...body };
  if (b.note) b.note = noteText(b.note);
  if (b.reply) b.reply = String(b.reply).slice(0, MAX_REPLY);
  const route = `/api/machines/${enc(ctx.machine.id)}/jobs/${jobId}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await api(ctx.key, "POST", route, b);
    if (r.status >= 200 && r.status < 300) return true;
    if (r.status && r.status < 500 && r.status !== 429) { ctx.log(`job ${jobId}: the server wouldn't take the "${b.status}" report (${httpWhy(r)})`); return false; }
    await ctx.sleep(2000 * (attempt + 1));
  }
  ctx.log(`job ${jobId}: couldn't report "${b.status}" to ${cfg.appOrigin()}`);
  return false;
}

/** A job as the server handed it: verified (or refused) right away, in arrival order
 *  — nothing here awaits before the nonce is recorded and the job is queued. */
function receive(job, ctx) {
  if (!job || typeof job !== "object" || !Number.isSafeInteger(job.id) || job.id <= 0) { ctx.log("skipped a job without a usable id"); return; }
  if (ctx.seenJobs.has(job.id)) return;
  ctx.seenJobs.add(job.id);
  if (ctx.seenJobs.size > 1000) ctx.seenJobs.delete(ctx.seenJobs.values().next().value);
  const m = ctx.machine;
  let a;
  try {
    a = verify.authorize(job, { machineId: m.id, rpId: m.rp_id, trusted: m.passkeys, now: Date.now(), seenNonce: ctx.nonces.seen });
  } catch (e) {
    a = { ok: false, why: e.message };
  }
  if (!a.ok) {
    ctx.log(`job ${job.id}: refused — ${a.why}`);
    ctx.track(report(ctx, job.id, { status: "refused", note: a.why }));
    return;
  }
  const cmd = a.cmd;
  ctx.log(`job ${job.id}: ${cmd.action} ${cmd.session.slice(0, 8)} verified (${a.via})`);
  const plan = planJob(cmd, ctx);
  if (!plan.ok) {
    ctx.log(`job ${job.id}: ${plan.status} — ${plan.note}`);
    ctx.track(report(ctx, job.id, { status: plan.status, note: plan.note }));
    return;
  }
  const running = report(ctx, job.id, { status: "running" });
  ctx.track(running);
  ctx.scheduler.push(plan.key, async () => { await running; await execute(job, cmd, ctx); });
}

// --- the listener -------------------------------------------------------------------

function logLine(msg) {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
}

/** Keep machine.log near LOG_CAP: cut it to its newest half. Rewritten in place (same
 *  file), because launchd / systemd hold it open for appending as our stdout. */
function trimLog(p = files.log(), cap = LOG_CAP) {
  try {
    const size = fs.statSync(p).size;
    if (size <= cap) return false;
    const keep = Math.floor(cap / 2);
    const buf = Buffer.alloc(keep);
    const fd = fs.openSync(p, "r");
    try { fs.readSync(fd, buf, 0, keep, size - keep); } finally { fs.closeSync(fd); }
    const nl = buf.indexOf(10);
    fs.writeFileSync(p, nl >= 0 ? buf.subarray(nl + 1) : buf);
    return true;
  } catch (_) { return false; }
}

/** `spacesheep machine run`. Returns the exit code: 0 whenever it stops on purpose
 *  (not set up, removed on the site, Talk off, turned off), so the service manager,
 *  which restarts only a failed exit, leaves it down. */
async function run(opts = {}, deps = {}) {
  let lines = 0;
  const log = deps.log || ((s) => { logLine(s); if (++lines % 500 === 0) trimLog(); });
  if (!deps.log) trimLog();
  let m = readMachine();
  if (!m) { log("this machine isn't set up — run `spacesheep machine on`"); return 0; }
  if (!m.passkeys.length) { log("this machine trusts no passkey — run `spacesheep machine pair`"); return 0; }
  const k = cfg.resolveKey();
  if (!k) { log("not signed in — run `spacesheep login`, then `spacesheep machine on`"); return 0; }

  const pending = new Set();
  const ctx = {
    key: k.key, log, machine: m,
    state: loadState(), nonces: nonceStore(), scheduler: new Scheduler(MAX_JOBS),
    seenJobs: new Set(), lastEnd: new Map(), children: new Set(), running: new Set(),
    sleep: deps.sleep || sleep, findClaude: deps.findClaude, jobTimeoutMs: deps.jobTimeoutMs,
    track: (p) => { pending.add(p); p.catch(() => {}).finally(() => pending.delete(p)); },
  };
  claudeInfo(ctx);
  log(`listening as "${m.name}" (${m.id}) · ${m.folders.length} folder${m.folders.length === 1 ? "" : "s"} · ${m.mode} mode · ${m.passkeys.length} passkey${m.passkeys.length === 1 ? "" : "s"} · CLI ${CLI_VERSION}`);
  if (!ctx.claude) log(`Claude Code isn't installed on ${m.name}; messages will be answered with that until it is`);

  const drain = async () => { await ctx.scheduler.idle(); await Promise.allSettled([...pending]); };
  let stopping = false;
  if (deps.signals !== false) {
    const onSignal = async (sig) => {
      if (stopping) return;
      stopping = true;
      log(`${sig}: stopping${ctx.running.size ? ` (${ctx.running.size} job${ctx.running.size === 1 ? "" : "s"} cut short)` : ""}`);
      for (const c of ctx.children) { try { process.kill(-c.pid, "SIGTERM"); } catch (_) { try { c.kill("SIGTERM"); } catch (_) {} } }
      const cut = [...ctx.running].map((id) => api(ctx.key, "POST", `/api/machines/${enc(ctx.machine.id)}/jobs/${id}`, { status: "failed", note: `the listener on ${ctx.machine.name} was stopped mid-job` }, 3000));
      await Promise.race([Promise.allSettled(cut), sleep(4000)]);
      process.exit(0);
    };
    process.on("SIGTERM", () => onSignal("SIGTERM"));
    process.on("SIGINT", () => onSignal("SIGINT"));
  }

  let helloed = null, waitTrouble = null;
  const stop = async (msg) => { log(msg); await drain(); return 0; };
  for (;;) {
    if (stopping) return 0;
    try {
      m = readMachine();
      if (!m) return await stop("machine.json is gone (turned off) — stopping");
      ctx.machine = m;
      const settings = JSON.stringify(helloBody(m));
      if (helloed !== settings) {
        const h = await api(ctx.key, "POST", `/api/machines/${enc(m.id)}/hello`, helloBody(m));
        if (h.status === 404) return await stop(REMOVED);
        if (h.status === 410) return await stop(TALK_OFF);
        if (h.status === 200) { helloed = settings; log("hello: online"); }
        else log(`hello: ${httpWhy(h)} — will say hello again`);
      }
      const w = await api(ctx.key, "GET", `/api/machines/${enc(m.id)}/wait`, null, deps.waitTimeoutMs || WAIT_TIMEOUT_MS);
      if (w.status === 200) {
        if (waitTrouble) { log("back online"); waitTrouble = null; }
        const jobs = w.json && Array.isArray(w.json.jobs) ? w.json.jobs : [];
        // A passkey paired a moment ago (`machine pair`) is trusted from its first job.
        if (jobs.length) ctx.machine = readMachine() || ctx.machine;
        for (const job of jobs) receive(job, ctx);
        continue;
      }
      if (w.status === 404) return await stop(REMOVED);
      if (w.status === 410) return await stop(TALK_OFF);
      const trouble = httpWhy(w);
      if (trouble !== waitTrouble) { log(`wait: ${trouble} — retrying every ${w.status === 429 ? 30 : 5} s`); waitTrouble = trouble; }
      await ctx.sleep(w.status === 429 ? 30000 : 5000);
    } catch (e) {
      log(`error: ${e && e.message ? e.message : e}`);
      await ctx.sleep(5000);
    }
  }
}

// --- pairing ------------------------------------------------------------------------

/** The rp id passkeys are made for: the app origin's hostname. A loopback address
 *  pairs as `localhost`, which is what a local app worker uses. */
function rpMatches(rp, origin) {
  let host;
  try { host = new URL(origin).hostname; } catch (_) { return false; }
  if (rp === host) return true;
  return rp === "localhost" && ["127.0.0.1", "[::1]", "::1"].includes(host);
}


/** Pair a passkey with this machine: start, show the code, wait for the page, and
 *  verify the proof HERE before trusting the key. `machineId` adds a passkey to a
 *  machine that is already paired. Returns { machine_id, rp_id, passkey }. */
async function pairFlow(key, { machineId, name, folders, mode }, log, deps = {}) {
  const body = { name, folders, mode, agents: AGENTS, cli_version: CLI_VERSION, platform: process.platform };
  if (machineId) body.machine_id = machineId;
  const s = await api(key, "POST", "/api/machines/pair/start", body);
  if (s.status === 410) throw new Error((s.json && s.json.error) || TALK_OFF);
  if (s.status === 404 && machineId) throw new Error("spacesheep.dev no longer knows this machine — run `spacesheep machine off`, then `spacesheep machine on`");
  if (s.status === 401 || s.status === 403) throw Object.assign(new Error(`the server rejected this machine's key (${httpWhy(s)}) — run \`spacesheep login\``), { code: "EAUTH" });
  if (s.status !== 200 || !s.json) throw new Error(`couldn't start pairing (${httpWhy(s)}${s.json && s.json.error ? `: ${String(s.json.error).slice(0, 200)}` : ""})`);
  const j = s.json;
  const check = String(j.check || "");
  let expires = Number(j.expires_at);
  if (expires > 0 && expires < 1e12) expires *= 1000; // seconds, not ms
  if (!ID_RE.test(String(j.machine_id || "")) || !CODE_RE.test(String(j.code || "")) || !/^\d{6}$/.test(check) || !(expires > 0)) throw new Error("the server's pairing answer is malformed — nothing was paired");
  if (machineId && j.machine_id !== machineId) throw new Error("the server answered for a different machine — nothing was paired");
  if (!rpMatches(j.rp_id, cfg.appOrigin())) throw new Error(`the server wants passkeys for "${String(j.rp_id).slice(0, 80)}", but this CLI talks to ${cfg.appOrigin()} — nothing was paired`);
  let url = null;
  try { const u = new URL(j.pair_url); if (u.protocol === "https:" || u.protocol === "http:") url = u.href; } catch (_) {}
  if (j.talk_turned_on) log("  ✓ Turned on “Talk to your sessions” for your account.");
  log("");
  log(`  ${machineId ? "Add a passkey" : "Confirm with your passkey"} (Touch ID / Face ID) on the page that just opened:`);
  log(`    ${url || "(the server sent no link)"}`);
  log(`    It shows ${check.slice(0, 3)} ${check.slice(3)}, the same as here. Waiting… (Ctrl+C to cancel)`);
  if (url) (deps.openBrowser || require("./login").openBrowser)(url);
  const deadline = Math.min(expires, Date.now() + 30 * 60 * 1000);
  const every = deps.pollMs || 2000;
  while (Date.now() < deadline) {
    await sleep(every);
    const p = await api(key, "GET", `/api/machines/pair/poll?code=${enc(j.code)}`);
    if (p.status === 404 || p.status === 410) throw new Error("the pairing expired or was cancelled — run the command again");
    if (p.status !== 200 || !p.json) continue;
    const st = String(p.json.status || "");
    if (st === "pending") continue;
    if (st === "paired") {
      const v = verify.verifyPairProof({ machineId: j.machine_id, code: j.code, passkey: p.json.passkey, proof: p.json.proof, rpId: j.rp_id });
      if (!v.ok) throw new Error(`the pairing answer didn't verify (${v.why}) — nothing was trusted`);
      const pk = p.json.passkey;
      return { machine_id: j.machine_id, rp_id: j.rp_id, passkey: { id: pk.id, alg: pk.alg, spki: pk.spki } };
    }
    if (/denied|cancel|expired|fail/i.test(st)) throw new Error(`the pairing was ${st} — run the command again`);
  }
  throw new Error("the pairing timed out — run the command again");
}

// --- the background service -----------------------------------------------------------

function sh(cmd, args) {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, out };
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || ""), err: String((e && e.stderr) || (e && e.message) || "") };
  }
}

/** What the service runs and with which environment: this node and this script by
 *  absolute path (memory.js hookArgv, so a Homebrew upgrade doesn't strand it), and a
 *  PATH that finds node and claude — launchd starts with almost none. */
function serviceSpec() {
  const argv = require("./memory").hookArgv(["machine", "run"]);
  const claude = findClaude();
  const dirs = [path.dirname(argv[0])];
  if (claude) dirs.push(path.dirname(claude));
  for (const d of String(process.env.PATH || "").split(path.delimiter)) if (d && path.isAbsolute(d)) dirs.push(d);
  dirs.push("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin");
  const env = { PATH: [...new Set(dirs)].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch (_) { return false; } }).join(path.delimiter) };
  for (const k of ["SPACESHEEP_APP_ORIGIN", "SPACESHEEP_CONFIG_DIR", "SPACESHEEP_ORIGIN", "CLAUDE_CONFIG_DIR"]) if (process.env[k]) env[k] = process.env[k];
  return { argv, env, log: files.log() };
}

const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The launchd agent. KeepAlive only on a failed exit: when the listener stops on
 *  purpose (removed on the site, Talk off) it exits 0 and stays down, instead of
 *  being restarted into the same answer every ten seconds. */
function launchdPlist(spec) {
  const env = Object.entries(spec.env).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${spec.argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(spec.log)}</string>
  <key>StandardErrorPath</key><string>${xml(spec.log)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
</dict>
</plist>
`;
}

// systemd's own quoting: a double-quoted word, backslash escapes, %% for a literal %.
const sdQuote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

/** The systemd user unit. Restart only on failure, for the same reason as launchd. */
function systemdUnit(spec) {
  const env = Object.entries(spec.env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`).join("\n");
  return `[Unit]
Description=spacesheep machine listener (spacesheep.dev → this machine's coding sessions)
After=network-online.target

[Service]
ExecStart=${spec.argv.map(sdQuote).join(" ")}
Restart=on-failure
RestartSec=10
${env}
StandardOutput=append:${spec.log.replace(/%/g, "%%")}
StandardError=append:${spec.log.replace(/%/g, "%%")}

[Install]
WantedBy=default.target
`;
}

const macService = {
  kind: "launchd",
  file: () => path.join(HOME(), "Library", "LaunchAgents", LABEL + ".plist"),
  domains: () => [`gui/${process.getuid()}`, `user/${process.getuid()}`],
  install(spec) {
    const p = this.file();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, launchdPlist(spec), { mode: 0o644 });
    fs.mkdirSync(path.dirname(spec.log), { recursive: true, mode: 0o700 });
    this.stop();
    // A bootout finishes asynchronously; bootstrapping the same label right after can
    // fail with "Input/output error" for a moment.
    const [gui, user] = this.domains();
    for (let i = 0; i < 6; i++) {
      if (sh("launchctl", ["bootstrap", gui, p]).ok) return { ok: true, how: `launchd agent ${LABEL}` };
      sleepSync(500);
    }
    if (sh("launchctl", ["bootstrap", user, p]).ok) return { ok: true, how: `launchd agent ${LABEL} (${user})` };
    if (sh("launchctl", ["load", "-w", p]).ok) return { ok: true, how: `launchd agent ${LABEL}` };
    return { ok: false, why: `launchctl wouldn't load ${tilde(p)}` };
  },
  stop() {
    for (const d of this.domains()) sh("launchctl", ["bootout", `${d}/${LABEL}`]);
  },
  uninstall() {
    this.stop();
    const p = this.file();
    if (fs.existsSync(p)) { sh("launchctl", ["unload", p]); try { fs.unlinkSync(p); } catch (_) {} return true; }
    return false;
  },
  status() {
    for (const d of this.domains()) {
      const r = sh("launchctl", ["print", `${d}/${LABEL}`]);
      if (!r.ok) continue;
      const state = (/^\s*state = (\S+)/m.exec(r.out) || [])[1] || "loaded";
      const pid = (/^\s*pid = (\d+)/m.exec(r.out) || [])[1];
      return { installed: true, running: state === "running", detail: `${state}${pid ? ` (pid ${pid})` : ""}`, how: `launchd ${d}/${LABEL}` };
    }
    return { installed: fs.existsSync(this.file()), running: false, detail: fs.existsSync(this.file()) ? "installed, not loaded" : "not installed", how: "launchd" };
  },
};

const linuxService = {
  kind: "systemd",
  file: () => path.join(process.env.XDG_CONFIG_HOME || path.join(HOME(), ".config"), "systemd", "user", UNIT),
  install(spec) {
    const p = this.file();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, systemdUnit(spec));
    fs.mkdirSync(path.dirname(spec.log), { recursive: true, mode: 0o700 });
    sh("systemctl", ["--user", "daemon-reload"]);
    const en = sh("systemctl", ["--user", "enable", UNIT]);
    const rs = sh("systemctl", ["--user", "restart", UNIT]);
    if (en.ok && rs.ok) return { ok: true, how: `systemd user service ${UNIT}`, hint: "On a machine you log out of, `loginctl enable-linger $USER` keeps it running." };
    return { ok: false, why: `systemctl --user couldn't start it (${(rs.err || en.err || "").trim().split("\n")[0].slice(0, 160)})` };
  },
  uninstall() {
    sh("systemctl", ["--user", "disable", "--now", UNIT]);
    const p = this.file();
    if (fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (_) {} sh("systemctl", ["--user", "daemon-reload"]); return true; }
    return false;
  },
  status() {
    const r = sh("systemctl", ["--user", "is-active", UNIT]);
    const state = (r.out || "").trim() || "unknown";
    return { installed: fs.existsSync(this.file()), running: state === "active", detail: fs.existsSync(this.file()) ? state : "not installed", how: `systemd --user ${UNIT}` };
  },
};

const noService = (why) => ({
  kind: "none",
  install: () => ({ ok: false, manual: true, why }),
  uninstall: () => false,
  status: () => ({ installed: false, running: false, detail: why, how: "none" }),
});

/** The service manager here; tests (SPACESHEEP_MACHINE_NO_SERVICE=1) get none. */
function platformService() {
  if (process.env.SPACESHEEP_MACHINE_NO_SERVICE === "1") return noService("skipped (SPACESHEEP_MACHINE_NO_SERVICE)");
  if (process.platform === "darwin") return macService;
  if (process.platform === "linux" && sh("sh", ["-c", "command -v systemctl"]).ok) return linuxService;
  return noService("no service manager this CLI knows here");
}

// --- the commands -----------------------------------------------------------------------

const cleanName = (n) => String(n).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || "machine";

/** Run from npx: install this version for real and hand over to it. The background
 *  listener must run an installed copy (an npx cache path can vanish), and asking the
 *  person to install first was a step they had to know about. */
function handToGlobal(opts, log) {
  const pkg = require("../package.json");
  const target = require("./prefix").pathPrefix();
  log(`  Installing ${pkg.name}@${pkg.version}, so the listener can run in the background…`);
  try {
    execFileSync("npm", ["install", "-g", `${pkg.name}@${pkg.version}`, ...(target ? ["--prefix", target] : [])], { stdio: ["ignore", "ignore", "inherit"] });
  } catch (_) {
    throw new Error("couldn't install it (`npm install -g spacesheep` failed) — run that yourself, with sudo if your npm needs it, then `spacesheep machine on`");
  }
  let bin = target || "";
  if (!bin) try { bin = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim(); } catch (_) {}
  const global = process.platform === "win32" ? path.join(bin, "spacesheep.cmd") : path.join(bin, "bin", "spacesheep");
  const args = ["machine", "on",
    ...[].concat(opts.folder || []).flatMap((f) => ["--folder", path.resolve(String(f))]),
    ...(opts.mode ? ["--mode", String(opts.mode)] : []), ...(opts.name ? ["--name", String(opts.name)] : [])];
  execFileSync(global, args, { stdio: "inherit" });
}

async function on(opts, log, deps = {}) {
  const skip = !!opts.noService || process.env.SPACESHEEP_MACHINE_NO_SERVICE === "1";
  if (!skip && !deps.service && require("./memory").binPath().viaNpx) return handToGlobal(opts, log);
  let k = cfg.resolveKey();
  if (!k) {
    // Not signed in: do it here rather than send them off to another command.
    log("  First, sign in to spacesheep.dev.");
    const { key, username } = await (deps.deviceLogin || require("./login").deviceLogin)(cfg.origin(), log);
    cfg.writeConfig({ ...cfg.readConfig(), key, username, origin: process.env.SPACESHEEP_ORIGIN || undefined });
    log(`  ✓ Signed in${username ? ` as @${username}` : ""}.`);
    k = { key, source: "config" };
  }
  const service = deps.service || (skip ? null : platformService());
  if (service && service.kind !== "none" && !deps.service) {
    if (k.source === "env" && !cfg.readConfig().key) throw new Error("the background listener uses the key `spacesheep login` saves, and SPACESHEEP_KEY from this shell isn't passed to it — run `spacesheep login` first (or add --no-service and keep `spacesheep machine run` open yourself)");
  }
  if (opts.mode !== undefined && opts.mode !== "safe" && opts.mode !== "auto") throw new Error("--mode takes safe or auto");
  const added = resolveFolders([].concat(opts.folder || []).filter((f) => typeof f === "string"));
  // --name renames the machine everywhere: the hooks report it too, so a session and
  // the listener that can reach it always carry the same name.
  if (opts.name) { const c = cfg.readConfig(); c.machine = cleanName(opts.name); cfg.writeConfig(c); }
  const existing = readMachine();
  let m = null;
  if (existing && existing.passkeys.length) {
    m = { ...existing, folders: union(existing.folders, added), mode: opts.mode || existing.mode, name: currentName() };
    writeMachine(m);
    const h = await api(k.key, "POST", `/api/machines/${enc(m.id)}/hello`, helloBody(m));
    if (h.status === 410) throw new Error(TALK_OFF);
    if (h.status === 404) {
      log("  ! spacesheep.dev no longer knows this machine — pairing it again.");
      removeLocal();
      m = null;
    } else if (h.status !== 200) {
      log(`  ! couldn't reach ${cfg.appOrigin()} (${httpWhy(h)}); the listener says hello when it starts.`);
    }
    if (m && !added.length && !opts.mode && !opts.name) log(`  (Already set up. \`--folder <dir>\` adds a folder, \`--mode safe|auto\` changes the mode.)`);
  }
  if (!m) {
    let folders = union(existing ? existing.folders : [], added);
    if (!folders.length) folders = await defaultFolders(log, deps);
    const name = currentName();
    const mode = opts.mode || (existing && existing.mode) || "safe";
    const p = await pairFlow(k.key, { name, folders, mode }, log, deps);
    m = { id: p.machine_id, name, folders, mode, rp_id: p.rp_id, passkeys: [{ ...p.passkey, added_at: Date.now() }], created_at: Date.now() };
    writeMachine(m);
    log(`  ✓ Paired. This computer trusts that passkey, and only it.`);
  }
  // The board must know this computer's sessions (and their folders) for a message to
  // find its way here: turn on the session hooks if they aren't — state and titles
  // only, never what was said (`spacesheep sessions install` adds turn sync).
  if (!deps.skipHooks) {
    try {
      const s = require("./sessions");
      const missing = s.hooksMissing();
      if (missing.length) {
        s.installStateHooks(missing);
        await s.backfill(() => {}, missing, { claude: true, codex: false, antigravity: false });
        log(`  ✓ Sessions on this computer now show up on ${cfg.appOrigin()}/sessions (their state and titles only).`);
      }
    } catch (e) {
      log(`  ! couldn't turn on session reporting (${e.message}); run \`spacesheep sessions install\`.`);
    }
  }
  let svc = null;
  if (service) {
    try { svc = service.install(serviceSpec(), log); } catch (e) { svc = { ok: false, why: e.message }; }
  }
  log("");
  log(`  ✓ "${m.name}" takes your sessions from spacesheep.dev · ${m.folders.map(tilde).join(", ")} · ${m.mode} mode`);
  if (svc && svc.ok) log(`    Running in the background (about 45 MB).`);
  else if (svc && svc.manual) log(`    ${svc.why} — run \`spacesheep machine run\` in a terminal you leave open.`);
  else if (svc) log(`    The listener didn't start (${svc.why}) — run \`spacesheep machine run\` in a terminal you leave open.`);
  else log(`    Not installed as a service (--no-service) — run \`spacesheep machine run\` in a terminal you leave open.`);
  if (svc && svc.hint) log(`    ${svc.hint}`);
  log(`  Open ${cfg.appOrigin()}/sessions to message a session there or start a new one. Off any time: \`spacesheep machine off\`.`);
  for (const w of require("./prefix").installWarnings()) log(`  ! ${w}`);
  return m;
}

async function pair(opts, log, deps = {}) {
  const k = cfg.resolveKey();
  if (!k) throw Object.assign(new Error("not signed in — run `spacesheep login` first"), { code: "EAUTH" });
  const m = readMachine();
  if (!m) throw new Error("this machine isn't set up — run `spacesheep machine on` first");
  const p = await pairFlow(k.key, { machineId: m.id, name: m.name, folders: m.folders, mode: m.mode }, log, deps);
  const cur = readMachine() || m;
  if (!cur.passkeys.some((x) => x.id === p.passkey.id)) cur.passkeys.push({ ...p.passkey, added_at: Date.now() });
  writeMachine(cur);
  log(`  ✓ Added that passkey: ${cur.passkeys.length} passkey${cur.passkeys.length === 1 ? "" : "s"} can reach "${cur.name}". The listener trusts it from its next job.`);
  return cur;
}

function removeLocal() {
  for (const f of [files.machine(), files.state(), files.nonces()]) { try { fs.unlinkSync(f); } catch (_) {} }
}

async function off(opts, log, deps = {}) {
  const m = readMachine();
  const service = deps.service || platformService();
  let removed = false;
  try { removed = service.uninstall(); } catch (_) {}
  // Nothing that can run a command stays behind: the trusted passkeys go with machine.json.
  removeLocal();
  if (!m) { log(`  ${removed ? "✓ Stopped the listener service. " : "= "}This machine had no listener set up.`); return; }
  const k = cfg.resolveKey();
  const r = k ? await api(k.key, "POST", `/api/machines/${enc(m.id)}/off`, {}) : { status: 0 };
  log(`  ✓ Turned off: "${m.name}" no longer listens, and the passkeys it trusted are forgotten here.`);
  if (r.status !== 200 && r.status !== 404) log(`  ! couldn't tell ${cfg.appOrigin()} (${httpWhy(r)}); it will show the machine as offline. Nothing can reach it either way.`);
  log(`  \`spacesheep machine on\` sets it up again (with a new pairing).`);
}

function tailLines(p, n) {
  try {
    const size = fs.statSync(p).size;
    const len = Math.min(size, 16 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(p, "r");
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    return buf.toString("utf8").split("\n").filter(Boolean).slice(-n);
  } catch (_) { return []; }
}

function status(opts, out, deps = {}) {
  const m = readMachine();
  const svc = (deps.service || platformService()).status();
  const last = tailLines(files.log(), 5);
  const report = m
    ? { set_up: true, name: m.name, id: m.id, folders: m.folders, mode: m.mode, passkeys: m.passkeys.length, rp_id: m.rp_id, listener: svc, log: files.log(), last_log: last }
    : { set_up: false, listener: svc, log: files.log(), last_log: last };
  if (opts.json) return out(report);
  if (!m) {
    out("  machine:   not set up — `spacesheep machine on` lets spacesheep.dev reach this machine's sessions");
    if (svc.installed) out(`  listener:  ${svc.detail} (${svc.how}) — \`spacesheep machine off\` removes it`);
    return;
  }
  out(`  machine:   ${m.name} (${m.id})`);
  out(`  folders:   ${m.folders.map(tilde).join(", ") || "none"}`);
  out(`  mode:      ${m.mode}`);
  out(`  passkeys:  ${m.passkeys.length} (for ${m.rp_id})`);
  out(`  listener:  ${svc.running ? "running" : "NOT running"} — ${svc.detail} (${svc.how})`);
  out(`  log:       ${tilde(files.log())}${last.length ? "" : " (empty)"}`);
  for (const l of last) out(`             ${l.slice(0, 160)}`);
}

module.exports = {
  on, pair, off, status, run,
  // for tests
  receive, pairFlow, planJob, execute, parseCaps, modeFlags, optionBlock, findClaude, findTranscript, sessionFolder,
  liveProcess, recentlyWritten, parseResult, replyFrom, resolveFolders, allowedFolder, nonceStore, trimLog, launchdPlist, systemdUnit,
  serviceSpec, readMachine, writeMachine, rpMatches, Scheduler, claudeEnv, WRAP, files, defaultFolders, recentFolders,
};
