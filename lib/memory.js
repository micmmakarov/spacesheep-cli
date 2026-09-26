"use strict";
// `spacesheep memory` — remember Claude Code / Codex sessions in spacesheep.
//
//   spacesheep memory install [--claude] [--codex]   write the hooks into the tools' configs
//   spacesheep memory uninstall                       remove them
//   spacesheep memory status                          what is wired, what has synced
//   spacesheep memory sync [--source codex] [json]    the hook entry point (never call by hand)
//
// The hook must never block the tool: Claude Code waits for a Stop hook to exit,
// and exit code 2 stops Claude from stopping. So `sync` reads stdin, writes a tiny
// job file, spawns THIS binary detached with stdio ignored, and exits 0 — in the
// time Node takes to start. The child tails the transcript from a per-session
// cursor, POSTs the new turns to spacesheep, and advances the cursor only on a 2xx;
// a failed post is retried by the next turn's hook, and the server dedupes on
// (source, session, seq), so a retry can never write a turn twice.
//
// Readers per tool (the only per-tool code):
//   claude-code  stdin JSON {session_id, transcript_path, cwd}; transcript JSONL of
//                {type:"user"|"assistant", message:{content: string | [{type:"text",text}…]}}
//   codex        one JSON argv with {"thread-id"}; rollout under $CODEX_HOME/sessions/
//                YYYY/MM/DD/rollout-*-<thread-id>.jsonl, JSONL of {type:"response_item",
//                payload:{type:"message", role, content:[{type:"input_text"|"output_text", text}]}}

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const cfg = require("./config");
const { redactSecrets, redactDeep } = require("./redact");

const HOME = os.homedir();
const STATE = path.join(cfg.configDir(), "memory"); // cursors, locks, job files
const codexCfg = require("./codex-config");
const prefix = require("./prefix");
const APP_ORIGIN = (process.env.SPACESHEEP_APP_ORIGIN || "https://spacesheep.dev").replace(/\/$/, "");
const BATCH = 50;
const TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 5 * 60 * 1000;
const MAX_SIDE = 20000;
const DEFAULT_CLAUDE_SETTINGS = path.join(HOME, ".claude", "settings.json");
const CLAUDE_SETTINGS = DEFAULT_CLAUDE_SETTINGS;
const CODEX_CONFIG = path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "config.toml");

// --- sync: the hook entry point --------------------------------------------------

function sync(argv) {
  if (argv[0] === "--child") return child(argv[1]);
  try {
    const source = flag(argv, "--source") || (argv.some((a) => a.startsWith("{")) ? "codex" : "claude-code");
    const job = readJob(argv, source);
    if (!job) return;
    fs.mkdirSync(path.join(STATE, "jobs"), { recursive: true });
    const jobFile = path.join(STATE, "jobs", Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8) + ".json");
    fs.writeFileSync(jobFile, JSON.stringify(job));
    const p = spawn(process.execPath, [process.argv[1], "memory", "sync", "--child", jobFile], { detached: true, stdio: "ignore", windowsHide: true });
    p.unref();
    // Codex has one notify, and it is ours: the same finished turn is also the
    // session's state change for spacesheep.dev/sessions.
    if (source === "codex") require("./sessions").ping(["turn", argv.find((a) => a.startsWith("{")) || "{}"]);
  } catch (_) {
    /* the hook must be invisible to the tool */
  }
}

function flag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

function readJob(argv, source) {
  if (source === "codex") {
    const raw = argv.find((a) => a.startsWith("{"));
    let ev = {};
    try { ev = raw ? JSON.parse(raw) : {}; } catch (_) {}
    const threadId = ev["thread-id"] || ev.thread_id || ev["session-id"] || ev.session_id;
    if (!threadId) return null;
    const file = findCodexRollout(String(threadId));
    if (!file) return null;
    return { source: "codex", sessionId: String(threadId), transcript: file, cwd: ev.cwd || process.cwd() };
  }
  let input = "";
  try { input = fs.readFileSync(0, "utf8"); } catch (_) {}
  let ev = {};
  try { ev = input ? JSON.parse(input) : {}; } catch (_) {}
  const sessionId = ev.session_id || ev.sessionId;
  const transcript = ev.transcript_path || ev.transcriptPath;
  if (!sessionId || !transcript) return null;
  return { source, sessionId: String(sessionId), transcript: String(transcript), cwd: ev.cwd || process.cwd() };
}

function findCodexRollout(threadId) {
  const base = path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "sessions");
  let best = null;
  const walk = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const n of names) {
      const p = path.join(dir, n);
      if (n.endsWith(".jsonl") && n.includes(threadId)) { best = p; return; }
      if (depth < 3) { walk(p, depth + 1); if (best) return; }
    }
  };
  walk(base, 0);
  return best;
}

async function child(jobFile) {
  let job;
  try { job = JSON.parse(fs.readFileSync(jobFile, "utf8")); } catch (_) { return; }
  try { fs.unlinkSync(jobFile); } catch (_) {}
  const dir = path.join(STATE, job.source);
  fs.mkdirSync(dir, { recursive: true });
  const stem = path.join(dir, job.sessionId.replace(/[^A-Za-z0-9_-]/g, "_"));
  const lock = stem + ".lock";
  if (!takeLock(lock)) return;
  try {
    const k = cfg.resolveKey();
    if (!k) return;
    const cursorFile = stem + ".cursor";
    let cursor = { line: 0, seq: -1 };
    try { cursor = Object.assign(cursor, JSON.parse(fs.readFileSync(cursorFile, "utf8"))); } catch (_) {}
    let text;
    try { text = fs.readFileSync(job.transcript, "utf8"); } catch (_) { return; }
    const lines = text.split("\n");
    const parsed = job.source === "codex" ? parseCodex(lines, cursor.line) : parseClaude(lines, cursor.line);
    let seq = cursor.seq;
    // Credentials never leave the machine: redact, then cut (a cut first could
    // leave half a key the patterns no longer recognise).
    const turns = parsed.turns.map((t) => ({ seq: ++seq, user: redactSecrets(t.user).slice(0, MAX_SIDE), assistant: redactSecrets(t.assistant).slice(0, MAX_SIDE), at: t.at, endLine: t.endLine }));
    if (!turns.length) return;
    for (let i = 0; i < turns.length; i += BATCH) {
      const batch = turns.slice(i, i + BATCH);
      const ok = await post(k.key, { source: job.source, session_id: job.sessionId, cwd: job.cwd, machine: machineName(), turns: batch.map(({ endLine, ...t }) => t) });
      if (!ok) return; // the cursor stays; the next hook retries from here
      const last = batch[batch.length - 1];
      cursor = { line: i + BATCH >= turns.length ? parsed.line : last.endLine + 1, seq: last.seq, at: Date.now() };
      fs.writeFileSync(cursorFile, JSON.stringify(cursor));
    }
  } catch (_) {
    /* nothing to report to; the next hook retries */
  } finally {
    try { fs.unlinkSync(lock); } catch (_) {}
  }
}

/** The machine's name on spacesheep.dev/sessions — the one `connect` or
 *  `sessions install --machine` saved, else the hostname. */
function machineName() {
  const c = cfg.readConfig();
  if (c.machine) return String(c.machine);
  return os.hostname().replace(/\.(local|lan|home)$/i, "");
}

function takeLock(lock) {
  try {
    const st = fs.statSync(lock);
    if (Date.now() - st.mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
    else return false;
  } catch (_) {}
  try { fs.writeFileSync(lock, String(process.pid), { flag: "wx" }); return true; } catch (_) { return false; }
}

async function post(key, body) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(APP_ORIGIN + "/api/memory/turns", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify(redactDeep(body)),
      signal: ctl.signal,
    });
    return r.ok;
  } catch (_) {
    return false;
  } finally {
    clearTimeout(t);
  }
}

// --- Readers -----------------------------------------------------------------------
// Both return complete turns (a person's message + everything the assistant said
// before the next one), each with the line it ends on, and the line the cursor may
// advance to once every turn is delivered.

function pairTurns(msgs, endLine) {
  const turns = [];
  let cur = null;
  for (const m of msgs) {
    if (m.role === "user") {
      // Never overwrite a prompt that has no reply yet: in an agentic turn the reply
      // comes after tool calls, and a second user record is not a new question.
      if (cur && !cur.assistant) { cur.user += "\n\n" + m.text; continue; }
      if (cur) turns.push(cur);
      cur = { user: m.text, assistant: "", at: m.at, startLine: m.line, endLine: m.line };
    } else if (m.role === "assistant") {
      if (!cur) cur = { user: "", assistant: "", at: m.at, startLine: m.line, endLine: m.line };
      cur.assistant += (cur.assistant ? "\n\n" : "") + m.text;
      cur.endLine = m.line;
    }
  }
  if (cur && cur.assistant) turns.push(cur);
  // A user message with no reply yet stays unsent: the cursor stops before it.
  const line = cur && !cur.assistant ? cur.startLine : endLine;
  return { turns: turns.map((t) => ({ user: t.user, assistant: t.assistant, at: t.at, endLine: t.endLine })), line };
}

const isInjected = (text) => (/^<[a-z_-]+>/i.test(text) && /<\/[a-z_-]+>\s*$/i.test(text)) || /^<!--\s/.test(text) || /^<command-/.test(text);

function parseClaude(lines, from) {
  const msgs = [];
  for (let i = from; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    let j;
    try { j = JSON.parse(raw); } catch (_) { continue; }
    if (j.isSidechain) continue;
    // Skill bodies, command caveats, and hand-backs from peers and sub-agents are
    // user-typed records the person never wrote. Without this, a skill loaded
    // before the first reply became the session's "prompt" (and its title).
    if (j.type === "user" && (j.isMeta || (j.origin && j.origin.kind && j.origin.kind !== "human"))) continue;
    const at = Date.parse(j.timestamp || "") || Date.now();
    const c = j.message && j.message.content;
    if (j.type === "user") {
      let text = "";
      if (typeof c === "string") text = c;
      else if (Array.isArray(c)) text = c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
      text = text.trim();
      // Tool results, injected context and a skill's own markdown are not the person.
      if (!text || isInjected(text)) continue;
      msgs.push({ role: "user", text, at, line: i });
    } else if (j.type === "assistant" && Array.isArray(c)) {
      const text = c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
      if (text) msgs.push({ role: "assistant", text, at, line: i });
    }
  }
  return pairTurns(msgs, lines[lines.length - 1] === "" ? lines.length - 1 : lines.length);
}

function parseCodex(lines, from) {
  const msgs = [];
  for (let i = from; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    let j;
    try { j = JSON.parse(raw); } catch (_) { continue; }
    if (j.type !== "response_item" || !j.payload || j.payload.type !== "message") continue;
    const at = Date.parse(j.timestamp || "") || Date.now();
    const content = Array.isArray(j.payload.content) ? j.payload.content : [];
    const text = content.filter((b) => b && (b.type === "input_text" || b.type === "output_text") && typeof b.text === "string").map((b) => b.text).join("\n").trim();
    if (!text) continue;
    if (j.payload.role === "user") {
      if (/^<[a-z_-]+>/i.test(text)) continue; // <environment_context>, <recommended_plugins>: Codex's own injections
      msgs.push({ role: "user", text, at, line: i });
    } else if (j.payload.role === "assistant") {
      msgs.push({ role: "assistant", text, at, line: i });
    }
  }
  return pairTurns(msgs, lines[lines.length - 1] === "" ? lines.length - 1 : lines.length);
}

// --- install / uninstall / status -----------------------------------------------------

/** The command the hooks should run: this binary, by the path the shell found it
 * at. A global install's symlink survives updates; an npx cache path does not,
 * and npx itself takes hundreds of milliseconds on every turn. */
function binPath() {
  const p = process.argv[1];
  return { path: p, viaNpx: /[\\/]_npx[\\/]/.test(p) || /[\\/]\.npm[\\/]/.test(p) };
}

/** Codex's `notify` as Codex itself reads it: the top level of config.toml only
 *  (codex-config.js says why). */
function codexNotify() {
  let text;
  try { text = fs.readFileSync(CODEX_CONFIG, "utf8"); } catch (_) { return null; }
  return codexCfg.readNotify(text);
}

/** Is Codex wired to us — directly, or through a wrapper script that calls us?
 * Codex allows one notify command, so a person who already had one points it at a
 * script that runs both; status and install must recognise that, or they report
 * "not installed" forever on a setup that works. `misplaced` is a line of ours that
 * Codex never reads; `other` is another tool's notify. */
function codexWired() {
  const n = codexNotify();
  if (!n) return { wired: false, via: null, notify: null };
  if (n.misplaced) return { wired: false, via: "misplaced", notify: n.raw };
  if (!n.other) return { wired: true, via: "direct", notify: n.raw, argv: n.argv };
  // Codex Computer Use's client, running what it found in the slot after itself.
  const prev = codexCfg.previousNotify(n.argv);
  if (prev) {
    if (codexCfg.OURS.test(JSON.stringify(prev))) return { wired: true, via: "previous", notify: n.raw, argv: n.argv, prev };
    if (scriptRunsUs(prev[0])) return { wired: true, via: "previous-wrapper", notify: n.raw, argv: n.argv, prev, wrapper: prev[0] };
  }
  const cmd = n.argv && typeof n.argv[0] === "string" ? n.argv[0] : null;
  const body = cmd ? scriptRunsUs(cmd) : null;
  if (body) return { wired: true, via: "wrapper", notify: n.raw, wrapper: cmd, chain: codexCfg.chainOriginal(body) };
  return { wired: false, via: "other", notify: n.raw, argv: n.argv };
}

/** The body of a small script that runs spacesheep's turn sync, or null. A wrapper is
 *  a small script; never slurp the megabytes of a real binary. */
function scriptRunsUs(cmd) {
  try {
    if (fs.statSync(cmd).size >= 256 * 1024) return null;
    const body = fs.readFileSync(cmd, "utf8");
    return /spacesheep(?:\.js)?["']?\s+memory\s+sync/.test(body) || /spacesheep(?:\.js)?",\s*"memory"/.test(body) ? body : null;
  } catch (_) {
    return null;
  }
}

/** The command a hook runs: this node, by absolute path, on this script, by its
 *  real path. Never `#!/usr/bin/env node` — a PATH whose node is v12 has no fetch,
 *  and a session the desktop app launched may have no node on PATH at all. Both
 *  cases lost every ping silently (reported 2026-09-24 from a three-machine install). */
/** The node a hook should run. Node reports its real path, and on Homebrew that is
 *  the versioned …/Cellar/node/25.2.1/bin/node, which the next `brew upgrade node`
 *  plus cleanup deletes — and every hook with it. Homebrew's own stable links,
 *  <prefix>/opt/node/bin/node and <prefix>/bin/node, follow upgrades; use one when it
 *  is this very binary. */
function stableNode(exe = process.execPath) {
  const m = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/.exec(exe);
  if (!m) return exe;
  let real;
  try { real = fs.realpathSync(exe); } catch (_) { return exe; }
  for (const c of [`${m[1]}/opt/${m[2]}/bin/node`, `${m[1]}/bin/node`]) {
    try { if (fs.realpathSync(c) === real) return c; } catch (_) {}
  }
  return exe;
}
function hookCommand(args) {
  let script = process.argv[1];
  try { script = fs.realpathSync(script); } catch (_) {}
  return `${JSON.stringify(stableNode())} ${JSON.stringify(script)} ${args}`;
}
function hookArgv(args) {
  let script = process.argv[1];
  try { script = fs.realpathSync(script); } catch (_) {}
  return [stableNode(), script, ...args];
}
function hookEntry() {
  return { hooks: [{ type: "command", command: hookCommand("memory sync"), timeout: 10 }] };
}
const isOurs = (h) => h && Array.isArray(h.hooks) && h.hooks.some((x) => typeof x.command === "string" && /spacesheep(\.js)?"? memory sync/.test(x.command));

function installClaude(bin, log, CLAUDE_SETTINGS = DEFAULT_CLAUDE_SETTINGS) {
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8")); } catch (_) {}
  settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  let changed = false;
  for (const ev of ["Stop", "SessionEnd"]) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    // Ours are replaced, not skipped: a re-install is how a hook written with an
    // old node or an old path gets fixed.
    const fresh = hookEntry();
    const mine = list.filter(isOurs);
    if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(fresh)) continue;
    settings.hooks[ev] = list.filter((h) => !isOurs(h)).concat([fresh]);
    changed = true;
  }
  if (changed) {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
    fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  }
  log(`  ${changed ? "✓" : "="} Claude Code: Stop + SessionEnd hooks in ${CLAUDE_SETTINGS}${changed ? "" : " (already there)"}`);
}

function uninstallClaude(log, CLAUDE_SETTINGS = DEFAULT_CLAUDE_SETTINGS) {
  let settings;
  try { settings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8")); } catch (_) { return; }
  if (!settings.hooks) return;
  let changed = false;
  for (const ev of ["Stop", "SessionEnd"]) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const kept = list.filter((h) => !isOurs(h));
    if (kept.length !== list.length) { changed = true; if (kept.length) settings.hooks[ev] = kept; else delete settings.hooks[ev]; }
  }
  if (changed) fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  log(`  ${changed ? "✓" : "="} Claude Code: hooks ${changed ? "removed" : "were not installed"}`);
}

const tilde = (p) => (p.startsWith(HOME + path.sep) ? "~" + p.slice(HOME.length) : p);
const chainPath = () => path.join(cfg.configDir(), "bin", "codex-notify");

// Codex takes exactly one `notify` command, so another tool's is never clobbered:
// install skips it and says so, and --codex-chain points it at a script that runs
// both. Ours is always written at the top level of config.toml, and a re-install
// rewrites it whenever the node or the script moved. Returns what it did, for the
// install summary: added | moved | refreshed | current | wrapper | chained | other.
function installCodex(bin, log, opts = {}) {
  const argv = hookArgv(["memory", "sync", "--source", "codex"]);
  const line = `notify = ${JSON.stringify(argv)}`;
  let text = "";
  try { text = fs.readFileSync(CODEX_CONFIG, "utf8"); } catch (_) {}
  const write = (next) => { fs.mkdirSync(path.dirname(CODEX_CONFIG), { recursive: true }); fs.writeFileSync(CODEX_CONFIG, next); };
  const st = codexWired();
  if (st.via === "direct") {
    if (JSON.stringify(st.argv) === JSON.stringify(argv)) { log(`  = Codex: notify already runs spacesheep`); return "current"; }
    write(codexCfg.withNotify(text, line));
    log(`  ✓ Codex: notify updated to run this copy (${tilde(argv[1])})`);
    return "refreshed";
  }
  if (st.via === "misplaced") {
    write(codexCfg.withNotify(text, line));
    log(`  ✓ Codex: notify moved to the top of ${tilde(CODEX_CONFIG)} — it sat inside a [table], where Codex never reads it`);
    return "moved";
  }
  if (st.via === "previous") {
    if (JSON.stringify(st.prev) === JSON.stringify(argv)) { log(`  = Codex: notify already runs spacesheep (after Codex Computer Use)`); return "current"; }
    write(codexCfg.replaceNotify(text, `notify = ${JSON.stringify(codexCfg.withPrevious(st.argv, argv))}`));
    log(`  ✓ Codex: Codex Computer Use now hands turns to this copy (${tilde(argv[1])})`);
    return "refreshed";
  }
  if (st.via === "previous-wrapper") {
    // A script that runs spacesheep and then the client again would run the client
    // twice a turn once the client itself chains to it; --codex-chain drops the script.
    if (opts.codexChain) {
      write(codexCfg.replaceNotify(text, `notify = ${JSON.stringify(codexCfg.withPrevious(st.argv, argv))}`));
      log(`  ✓ Codex: Codex Computer Use now runs spacesheep directly, instead of through ${tilde(st.wrapper)}`);
      return "chained";
    }
    log(`  = Codex: notify already runs spacesheep (Codex Computer Use runs ${tilde(st.wrapper)})`);
    return "wrapper";
  }
  if (st.via === "wrapper") {
    // Our own chain script is rewritten when the node or the script moved; a wrapper
    // the person wrote is theirs.
    if (st.chain && st.wrapper === chainPath()) {
      const script = codexCfg.chainScript(st.chain, argv);
      let had = "";
      try { had = fs.readFileSync(st.wrapper, "utf8"); } catch (_) {}
      if (had !== script) { fs.writeFileSync(st.wrapper, script, { mode: 0o755 }); log(`  ✓ Codex: ${tilde(st.wrapper)} updated to run this copy`); return "refreshed"; }
    }
    log(`  = Codex: notify already runs spacesheep (through ${tilde(st.wrapper)})`);
    return "wrapper";
  }
  if (st.via === "other") {
    const n = codexNotify();
    if (opts.codexChain && n && n.argv && n.length && codexCfg.isComputerUse(n.argv) && !codexCfg.previousNotify(n.argv)) {
      // Codex Computer Use runs its --previous-notify after itself: chain onto that.
      write(codexCfg.replaceNotify(text, `notify = ${JSON.stringify(codexCfg.withPrevious(n.argv, argv))}`));
      log(`  ✓ Codex: Codex Computer Use keeps notify and now hands each turn to spacesheep (--previous-notify)`);
      return "chained";
    }
    if (opts.codexChain) {
      if (process.platform === "win32") { log(`  ! Codex: --codex-chain writes a shell script, which Windows can't run; Codex was left alone`); return "other"; }
      if (!n || !n.argv || !n.length) { log(`  ! Codex: can't chain — its notify isn't a one-line list of strings (${st.notify}); Codex was left alone`); return "other"; }
      const wrapper = chainPath();
      fs.mkdirSync(path.dirname(wrapper), { recursive: true });
      fs.writeFileSync(wrapper, codexCfg.chainScript(n.argv, argv), { mode: 0o755 });
      fs.chmodSync(wrapper, 0o755);
      write(codexCfg.replaceNotify(text, `notify = ${JSON.stringify([wrapper])}`));
      log(`  ✓ Codex: notify now runs ${tilde(wrapper)}, which runs spacesheep's turn sync and then ${n.argv[0]}`);
      return "chained";
    }
    log(`  ! Codex: skipped — its notify already runs ${st.notify}`);
    log(`    Codex runs one notify command. Run the install again with --codex-chain to point it at a small script that runs both.`);
    return "other";
  }
  write(codexCfg.withNotify(text, line));
  log(`  ✓ Codex: notify set at the top of ${tilde(CODEX_CONFIG)}`);
  return "added";
}

function uninstallCodex(log) {
  let text;
  try { text = fs.readFileSync(CODEX_CONFIG, "utf8"); } catch (_) { return; }
  const st = codexWired();
  if (st.via === "direct" || st.via === "misplaced") {
    const n = codexNotify();
    fs.writeFileSync(CODEX_CONFIG, text.slice(0, n.index) + text.slice(n.index + n.length).replace(/^\r?\n/, ""));
    return log(`  ✓ Codex: notify removed`);
  }
  if (st.via === "previous") {
    fs.writeFileSync(CODEX_CONFIG, codexCfg.replaceNotify(text, `notify = ${JSON.stringify(codexCfg.withPrevious(st.argv, null))}`));
    return log(`  ✓ Codex: Codex Computer Use no longer hands turns to spacesheep`);
  }
  if (st.via === "previous-wrapper") return log(`  ! Codex: Codex Computer Use runs ${st.wrapper}, a script of yours — remove the spacesheep line from it yourself`);
  if (st.via === "wrapper" && st.chain && st.wrapper === chainPath()) {
    const next = codexCfg.replaceNotify(text, `notify = ${JSON.stringify(st.chain)}`);
    if (next) fs.writeFileSync(CODEX_CONFIG, next);
    try { fs.unlinkSync(st.wrapper); } catch (_) {}
    return log(`  ✓ Codex: notify runs ${st.chain[0]} again, and ${tilde(st.wrapper)} is gone`);
  }
  // A wrapper is the person's own file and may run other things; say where it is
  // rather than editing or deleting it.
  if (st.via === "wrapper") return log(`  ! Codex: notify runs ${st.wrapper}, your own wrapper — remove the spacesheep line from it yourself`);
  log(`  = Codex: notify was not ours`);
}

function install(opts, log) {
  if (!cfg.resolveKey()) throw Object.assign(new Error("not signed in — run `spacesheep login` first (the hook posts with that key)"), { code: "EAUTH" });
  const { path: bin, viaNpx } = binPath();
  if (viaNpx) throw new Error("run this from a global install (`npm i -g spacesheep`), not npx — a hook must start in milliseconds, and an npx cache path does not survive updates");
  const both = !opts.claude && !opts.codex;
  let codex = null;
  if (both || opts.claude) installClaude(bin, log);
  if (both || opts.codex) codex = installCodex(bin, log, opts);
  if (!opts.quiet) {
    for (const w of prefix.installWarnings()) log(`  ! ${w}`);
    log(`\n  Finish one turn in either tool, then look at https://spacesheep.dev/me/memory/browse — the turn is there with claude-code or codex as its source.`);
  }
  return { codex };
}

function uninstall(opts, log) {
  const both = !opts.claude && !opts.codex;
  if (both || opts.claude) uninstallClaude(log);
  if (both || opts.codex) uninstallCodex(log);
}

function status(opts, out) {
  const k = cfg.resolveKey();
  let claude = false;
  try { const s = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, "utf8")); claude = ["Stop", "SessionEnd"].every((ev) => (s.hooks && s.hooks[ev] || []).some(isOurs)); } catch (_) {}
  const cx = codexWired();
  const synced = {};
  for (const source of ["claude-code", "codex"]) {
    let files = [];
    try { files = fs.readdirSync(path.join(STATE, source)).filter((f) => f.endsWith(".cursor")); } catch (_) {}
    let turns = 0;
    let last = 0;
    for (const f of files) {
      try { const c = JSON.parse(fs.readFileSync(path.join(STATE, source, f), "utf8")); turns += (c.seq || 0) + 1; last = Math.max(last, c.at || 0); } catch (_) {}
    }
    synced[source] = { sessions: files.length, turns, last: last ? new Date(last).toISOString() : null };
  }
  // Codex has written a session since its config last changed, yet no Codex turn has
  // synced: the line exists and isn't firing (or Codex only imported sessions).
  let silent = false;
  if (cx.wired && !synced.codex.turns) {
    let cfgAt = 0;
    try { cfgAt = fs.statSync(CODEX_CONFIG).mtimeMs; } catch (_) {}
    silent = newestCodexRolloutMs() > cfgAt && cfgAt > 0;
  }
  const warnings = prefix.installWarnings();
  const report = { signed_in: !!k, claude_code: claude, codex: cx.wired, codex_via: cx.via, codex_wrapper: cx.wrapper || null, codex_notify: cx.notify, codex_silent: silent, synced, warnings, state_dir: STATE, app_origin: APP_ORIGIN };
  if (opts.json) return out(report);
  out(`  key:          ${k ? `yes (${k.source})` : "no — run `spacesheep login`"}`);
  out(`  Claude Code:  ${claude ? "hooks installed" : "not installed"}`);
  out(`  Codex:        ${codexStatusLine(cx)}`);
  for (const [s, v] of Object.entries(synced)) out(`  ${s.padEnd(13)} ${v.sessions} sessions, ${v.turns} turns${v.last ? `, last ${v.last}` : ""}`);
  if (silent) out(`  ! Codex has written sessions since its notify was set, and no Codex turn has synced. If you finished a Codex turn since then, the line isn't firing.`);
  for (const w of warnings) out(`  ! ${w}`);
}

function codexStatusLine(cx) {
  if (cx.via === "direct") return "notify installed";
  if (cx.via === "wrapper") return `notify installed (through ${tilde(cx.wrapper)})`;
  if (cx.via === "previous") return "notify installed (Codex Computer Use hands each turn on with --previous-notify)";
  if (cx.via === "previous-wrapper") return `notify installed (Codex Computer Use runs ${tilde(cx.wrapper)}, which runs spacesheep)`;
  if (cx.via === "misplaced") return "misplaced — the notify line sits inside a [table] in config.toml, where Codex never reads it; `spacesheep memory install` moves it";
  if (cx.via === "other") return `not installed — notify runs ${cx.notify}; \`spacesheep memory install --codex-chain\` runs both`;
  return "not installed";
}

/** When Codex last wrote a session file (its rollouts live by day under sessions/). */
function newestCodexRolloutMs() {
  const root = path.join(path.dirname(CODEX_CONFIG), "sessions");
  const last = (dir) => { try { return fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).sort().pop() || null; } catch (_) { return null; } };
  const y = last(root); if (!y) return 0;
  const m = last(path.join(root, y)); if (!m) return 0;
  const d = last(path.join(root, y, m)); if (!d) return 0;
  let best = 0;
  try {
    for (const f of fs.readdirSync(path.join(root, y, m, d))) {
      if (f.endsWith(".jsonl")) best = Math.max(best, fs.statSync(path.join(root, y, m, d, f)).mtimeMs);
    }
  } catch (_) {}
  return best;
}

module.exports = { sync, install, uninstall, status, binPath, installClaude, uninstallClaude, installCodex, uninstallCodex, codexWired, hookCommand, hookArgv, stableNode, isInjected, parseClaude, pairTurns };
