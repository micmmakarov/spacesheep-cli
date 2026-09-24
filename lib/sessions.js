"use strict";
// `spacesheep sessions` — show every Claude Code / Codex session on spacesheep.dev/sessions.
//
//   spacesheep sessions install [--machine NAME] [--ssh HOST] [--claude] [--codex]
//   spacesheep sessions uninstall
//   spacesheep sessions status
//   spacesheep sessions ping <event> [json]   the hook entry point (never call by hand)
//   spacesheep sessions backfill              post the sessions already on this machine
//
// A ping says which state a session moved to and where it runs — never what was
// said (the turns travel through `memory sync`, which install also wires). Same
// rules as the memory hook: the parent reads stdin, writes a job file, spawns this
// binary detached and exits 0 before the tool notices; the child posts. A failed
// post is simply lost — the next event says the same thing again.
//
// Claude Code events → ping events:
//   SessionStart → start · UserPromptSubmit → prompt · PostToolUse → tool (a
//   heartbeat, at most one a minute per session) · Notification → notify ·
//   Stop → stop · SessionEnd → end
// Codex has one `notify` per finished turn; `memory sync --source codex` forwards
// it here as `turn`.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const cfg = require("./config");

const HOME = os.homedir();
const STATE = path.join(cfg.configDir(), "sessions");
const TIMEOUT_MS = 5000;
const BEAT_MS = 60 * 1000;

/** Every Claude Code config dir on this machine. One per account: people who run
 *  two accounts point CLAUDE_CONFIG_DIR at a second dir (often ~/.claude-work), and
 *  each dir has its own settings.json — hooks written to ~/.claude never fire for
 *  the other account. So install, backfill, status and uninstall all walk this list.
 *  `--config-dir` adds one we couldn't guess. */
function claudeDirs(extra) {
  const out = [];
  const add = (d) => { if (!d) return; const r = path.resolve(d); if (!out.includes(r)) out.push(r); };
  add(path.join(HOME, ".claude"));
  add(process.env.CLAUDE_CONFIG_DIR);
  for (const d of [].concat(extra || [])) add(d);
  try {
    for (const e of fs.readdirSync(HOME, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^\.claude[-_.]/.test(e.name)) continue;
      const d = path.join(HOME, e.name);
      if (fs.existsSync(path.join(d, "projects")) || fs.existsSync(path.join(d, "settings.json"))) add(d);
    }
  } catch (_) {}
  return out.filter((d, i) => i === 0 || fs.existsSync(d));
}
const settingsIn = (dir) => path.join(dir, "settings.json");
const tilde = (p) => (p.startsWith(HOME) ? "~" + p.slice(HOME.length) : p);
const CODEX_SESSIONS = path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "sessions");
const BACKFILL_DAYS = 30;

const HOOKS = { SessionStart: "start", UserPromptSubmit: "prompt", PostToolUse: "tool", Notification: "notify", Stop: "stop", SessionEnd: "end" };

const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");
const appOrigin = () => cfg.appOrigin();

/** The machine's name on the board: what `connect` or `--machine` saved, else the hostname. */
function machineName() {
  const c = cfg.readConfig();
  if (c.machine) return String(c.machine);
  return os.hostname().replace(/\.(local|lan|home)$/i, "");
}

// --- ping: the hook entry point ----------------------------------------------------

function ping(argv) {
  if (argv[0] === "--child") return child(argv[1]);
  try {
    const event = argv[0];
    if (!Object.values(HOOKS).includes(event) && event !== "turn") return;
    let job;
    if (event === "turn") {
      // Forwarded by `memory sync --source codex` with Codex's own JSON argument.
      let ev = {};
      try { ev = JSON.parse(argv[1] || "{}"); } catch (_) {}
      const id = ev["thread-id"] || ev.thread_id || ev["session-id"] || ev.session_id;
      if (!id) return;
      job = { source: "codex", event, session_id: String(id), cwd: ev.cwd || process.cwd() };
    } else {
      let input = "";
      try { input = fs.readFileSync(0, "utf8"); } catch (_) {}
      let ev = {};
      try { ev = input ? JSON.parse(input) : {}; } catch (_) {}
      const id = ev.session_id || ev.sessionId;
      if (!id) return;
      job = {
        source: "claude-code", event, session_id: String(id),
        cwd: ev.cwd || process.cwd(), transcript: ev.transcript_path || null,
        notification: ev.notification_type || null, note: typeof ev.message === "string" ? ev.message : null,
      };
    }
    if (event === "tool" && !beatDue(job)) return;
    fs.mkdirSync(path.join(STATE, "jobs"), { recursive: true });
    const jobFile = path.join(STATE, "jobs", Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8) + ".json");
    fs.writeFileSync(jobFile, JSON.stringify(job));
    const p = spawn(process.execPath, [process.argv[1], "sessions", "ping", "--child", jobFile], { detached: true, stdio: "ignore", windowsHide: true });
    p.unref();
  } catch (_) {
    /* the hook must be invisible to the tool */
  }
}

/** A tool-call heartbeat goes out at most once a minute per session: the stamp
 *  file's mtime is the clock, so this costs one stat. */
function beatDue(job) {
  const stamp = path.join(STATE, "beats", safeId(job.source + "-" + job.session_id));
  try {
    if (Date.now() - fs.statSync(stamp).mtimeMs < BEAT_MS) return false;
  } catch (_) {}
  try {
    fs.mkdirSync(path.dirname(stamp), { recursive: true });
    fs.writeFileSync(stamp, "");
  } catch (_) {}
  return true;
}

async function child(jobFile) {
  let job;
  try { job = JSON.parse(fs.readFileSync(jobFile, "utf8")); } catch (_) { return; }
  try { fs.unlinkSync(jobFile); } catch (_) {}
  const k = cfg.resolveKey();
  if (!k) return;
  const c = cfg.readConfig();
  const body = { source: job.source, session_id: job.session_id, event: job.event, machine: machineName(), cwd: job.cwd };
  if (c.ssh) body.ssh = c.ssh;
  if (job.notification) body.notification = job.notification;
  if (job.note) body.note = job.note.slice(0, 200);
  // The heartbeat only says "still working"; everything else refreshes where the
  // session is and what it is called.
  if (job.event !== "tool") {
    Object.assign(body, gitFacts(job.cwd));
    if (job.transcript) Object.assign(body, claudeFacts(job.transcript));
    else if (job.source === "codex") { const f = findCodexRollout(job.session_id); if (f) Object.assign(body, codexFacts(f)); }
  }
  const ok = await post(k.key, "/api/sessions/ping", body);
  try {
    fs.mkdirSync(STATE, { recursive: true });
    fs.writeFileSync(path.join(STATE, "last.json"), JSON.stringify({ at: Date.now(), ok, event: job.event, source: job.source }));
  } catch (_) {}
}

async function post(key, route, body) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(appOrigin() + route, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    return r.ok ? (await r.json().catch(() => ({ ok: true }))) : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// --- What a session is, read from where it already lives ----------------------------

const gitCache = new Map();
function gitFacts(cwd) {
  if (!cwd) return {};
  if (gitCache.has(cwd)) return gitCache.get(cwd);
  const run = (args) => { try { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch (_) { return ""; } };
  const out = {};
  const repo = run(["remote", "get-url", "origin"]);
  if (repo) out.repo = repo.replace(/\/\/[^/@]*@/, "//");
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch && branch !== "HEAD") out.branch = branch;
  gitCache.set(cwd, out);
  return out;
}

/** Read the first and last bytes of a file — a transcript can be tens of megabytes,
 *  and everything the board needs is at one end or the other. */
function ends(file, headBytes, tailBytes) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const read = (pos, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, pos); return b.subarray(0, n).toString("utf8"); };
    const head = read(0, Math.min(size, headBytes));
    const tail = size > headBytes ? read(Math.max(0, size - tailBytes), Math.min(size, tailBytes)) : head;
    return { head: head.split("\n").slice(0, -1), tail: tail.split("\n").slice(size > headBytes ? 1 : 0) };
  } catch (_) {
    return { head: [], tail: [] };
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
}

const parseLines = (lines) => lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);

/** Claude Code writes its own title for a session (`ai-title`) and the one the
 *  person gives it (`custom-title`); the person's wins. */
function claudeFacts(file) {
  const { head, tail } = ends(file, 64 * 1024, 256 * 1024);
  const H = parseLines(head), T = parseLines(tail);
  const out = {};
  let custom = null, ai = null;
  for (const j of H.concat(T)) {
    if (j.type === "custom-title" && j.customTitle) custom = j.customTitle;
    if (j.type === "ai-title" && j.aiTitle) ai = j.aiTitle;
  }
  if (custom || ai) out.title = String(custom || ai).slice(0, 120);
  for (let i = T.length - 1; i >= 0; i--) {
    const m = T[i].message && T[i].message.model;
    if (T[i].type === "assistant" && m && m !== "<synthetic>") { out.model = m; break; }
  }
  const meta = H.find((j) => j.version || j.entrypoint) || T.find((j) => j.version || j.entrypoint);
  if (meta && meta.version) out.agent_version = String(meta.version);
  if (meta && meta.entrypoint) out.entrypoint = String(meta.entrypoint);
  const times = H.concat(T).map((j) => Date.parse(j.timestamp || "")).filter((n) => n > 0);
  if (times.length) { out.started_at = Math.min(...times); out.last_at = Math.max(...times); }
  const withCwd = H.find((j) => j.cwd);
  if (withCwd) { out.cwd = withCwd.cwd; if (withCwd.gitBranch && withCwd.gitBranch !== "HEAD") out.branch = withCwd.gitBranch; }
  return out;
}

/** Codex keeps no title; its first real ask stands in, as it does for any session
 *  the harness never named. */
function codexFacts(file) {
  const { head, tail } = ends(file, 128 * 1024, 64 * 1024);
  const H = parseLines(head), T = parseLines(tail);
  const out = {};
  const meta = H.find((j) => j.type === "session_meta" && j.payload);
  if (meta) {
    const p = meta.payload;
    if (p.cwd) out.cwd = p.cwd;
    if (p.cli_version) out.agent_version = String(p.cli_version);
    if (p.git && p.git.branch) out.branch = p.git.branch;
    if (p.git && p.git.repository_url) out.repo = String(p.git.repository_url).replace(/\/\/[^/@]*@/, "//");
  }
  const ctx = H.concat(T).reverse().find((j) => j.type === "turn_context" && j.payload && j.payload.model);
  if (ctx) out.model = ctx.payload.model;
  for (const j of H) {
    if (j.type !== "response_item" || !j.payload || j.payload.type !== "message" || j.payload.role !== "user") continue;
    const text = (j.payload.content || []).filter((b) => b && b.type === "input_text").map((b) => b.text).join("\n").trim();
    if (!text || /^<[a-z_-]+>/i.test(text)) continue;
    const line = text.split("\n").find((l) => l.trim()) || "";
    out.title = line.length > 80 ? line.slice(0, 80).replace(/\s+\S*$/, "") + "…" : line;
    break;
  }
  const times = H.concat(T).map((j) => Date.parse(j.timestamp || "")).filter((n) => n > 0);
  if (times.length) { out.started_at = Math.min(...times); out.last_at = Math.max(...times); }
  return out;
}

function findCodexRollout(threadId) {
  let best = null;
  const walk = (dir, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const n of names.sort().reverse()) {
      const p = path.join(dir, n);
      if (n.endsWith(".jsonl") && n.includes(threadId)) { best = p; return; }
      if (depth < 3) { walk(p, depth + 1); if (best) return; }
    }
  };
  walk(CODEX_SESSIONS, 0);
  return best;
}

// --- backfill: the sessions already on this machine -----------------------------------

function recentFiles(root, depth, since, match) {
  const out = [];
  const walk = (dir, d) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of names) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (d < depth) walk(p, d + 1); continue; }
      if (!match(e.name)) continue;
      try { if (fs.statSync(p).mtimeMs >= since) out.push(p); } catch (_) {}
    }
  };
  walk(root, 0);
  return out;
}

function collectBackfill(dirs) {
  const since = Date.now() - BACKFILL_DAYS * 86400 * 1000;
  const machine = cfg.readConfig().machine || machineName();
  const ssh = cfg.readConfig().ssh;
  const rows = [];
  // Claude Code: ~/.claude/projects/<folder>/<session>.jsonl (subagent files live one level deeper).
  const files = [];
  for (const d of dirs || claudeDirs()) files.push(...recentFiles(path.join(d, "projects"), 1, since, (n) => /^[0-9a-f-]{36}\.jsonl$/.test(n)));
  for (const f of files) {
    const facts = claudeFacts(f);
    if (!facts.started_at) continue;
    const row = { source: "claude-code", session_id: path.basename(f, ".jsonl"), machine, ...facts };
    if (row.cwd) Object.assign(row, { ...gitFacts(row.cwd), ...(facts.branch ? { branch: facts.branch } : {}) });
    if (ssh) row.ssh = ssh;
    rows.push(row);
  }
  // Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl
  for (const f of recentFiles(CODEX_SESSIONS, 3, since, (n) => /^rollout-.*\.jsonl$/.test(n))) {
    const m = /([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i.exec(path.basename(f));
    if (!m) continue;
    const facts = codexFacts(f);
    if (!facts.started_at) continue;
    const row = { source: "codex", session_id: m[1], machine, ...facts };
    if (ssh) row.ssh = ssh;
    rows.push(row);
  }
  return rows;
}

async function backfill(log, dirs) {
  const k = cfg.resolveKey();
  if (!k) throw Object.assign(new Error("not signed in — run `spacesheep login` first"), { code: "EAUTH" });
  const rows = collectBackfill(dirs);
  let added = 0, updated = 0, failed = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const r = await post(k.key, "/api/sessions/backfill", { sessions: rows.slice(i, i + 200) });
    if (r) { added += r.added || 0; updated += r.updated || 0; } else failed += Math.min(200, rows.length - i);
  }
  log(`  ${failed ? "!" : "✓"} Backfill: ${rows.length} session${rows.length === 1 ? "" : "s"} from the last ${BACKFILL_DAYS} days on this machine (${added} new, ${updated} already there${failed ? `, ${failed} not sent — run \`spacesheep sessions backfill\` again` : ""})`);
}

// --- install / uninstall / status -------------------------------------------------------

const isOurs = (h) => h && Array.isArray(h.hooks) && h.hooks.some((x) => typeof x.command === "string" && /spacesheep(\.js)? sessions ping/.test(x.command));

function readSettings(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return {}; }
}

function installClaude(bin, log, CLAUDE_SETTINGS) {
  const settings = readSettings(CLAUDE_SETTINGS);
  settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const added = [];
  for (const [ev, name] of Object.entries(HOOKS)) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    if (list.some(isOurs)) continue;
    const entry = { hooks: [{ type: "command", command: `${bin} sessions ping ${name}`, timeout: 5 }] };
    // PostToolUse matches tool names; an empty matcher is every tool.
    if (ev === "PostToolUse") entry.matcher = "";
    list.push(entry);
    settings.hooks[ev] = list;
    added.push(ev);
  }
  if (added.length) {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
    fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  }
  log(`  ${added.length ? "✓" : "="} Claude Code (${tilde(path.dirname(CLAUDE_SETTINGS))}): session hooks ${added.length ? "added" : "already there"}`);
}

function uninstallClaude(log, CLAUDE_SETTINGS) {
  const settings = readSettings(CLAUDE_SETTINGS);
  if (!settings.hooks) return log(`  = Claude Code (${tilde(path.dirname(CLAUDE_SETTINGS))}): session hooks were not installed`);
  let changed = false;
  for (const ev of Object.keys(HOOKS)) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const kept = list.filter((h) => !isOurs(h));
    if (kept.length !== list.length) { changed = true; if (kept.length) settings.hooks[ev] = kept; else delete settings.hooks[ev]; }
  }
  if (changed) fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  log(`  ${changed ? "✓" : "="} Claude Code (${tilde(path.dirname(CLAUDE_SETTINGS))}): session hooks ${changed ? "removed" : "were not installed"}`);
}

/** Claude Code sessions running right now. They read their hooks when they
 *  started, so none of them reports until it restarts — the install says how many,
 *  rather than a vague "restart". Best effort: no `ps`, no count. */
function runningClaude() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n").filter((l) => {
      const cmd = l.trim().replace(/^\d+\s+/, "");
      if (!cmd || /spacesheep|ps -axo|disclaimer|Claude Helper|\.app\/Contents\/MacOS\/Claude$|Claude\.app\/Contents\/Frameworks/.test(cmd)) return false;
      return /(^|\/)claude(\s|$)/.test(cmd) || /@anthropic-ai\/claude-code/.test(cmd);
    }).length;
  } catch (_) {
    return null;
  }
}

/** Hooks must run an installed binary: npx takes hundreds of milliseconds and needs
 *  the network, and its cache path does not survive an update. So when this was
 *  started through npx, install globally first and hand over to that copy. */
function ensureGlobal(argv, log) {
  const mem = require("./memory");
  const { viaNpx } = mem.binPath();
  if (!viaNpx) return false;
  const pkg = require("../package.json");
  log(`  Installing ${pkg.name}@${pkg.version} globally, so the hooks start in milliseconds…`);
  try {
    execFileSync("npm", ["install", "-g", `${pkg.name}@${pkg.version}`], { stdio: ["ignore", "ignore", "inherit"] });
  } catch (_) {
    throw new Error("couldn't install globally (`npm install -g spacesheep` failed). Run it yourself — with sudo if your npm needs it — then `spacesheep sessions install`.");
  }
  let bin = "";
  try { bin = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim(); } catch (_) {}
  const global = process.platform === "win32" ? path.join(bin, "spacesheep.cmd") : path.join(bin, "bin", "spacesheep");
  execFileSync(global, ["sessions", ...argv], { stdio: "inherit" });
  return true;
}

async function install(opts, log, argv) {
  if (!cfg.resolveKey()) throw Object.assign(new Error("not signed in — run `spacesheep login` first (the link opens on any device, your phone included), or `spacesheep connect ss_…` with a key"), { code: "EAUTH" });
  if (ensureGlobal(argv, log)) return;
  const c = cfg.readConfig();
  if (opts.machine) c.machine = String(opts.machine).slice(0, 80);
  if (opts.ssh) {
    if (!/^[A-Za-z0-9._@-]+$/.test(opts.ssh)) throw new Error("--ssh takes a host or user@host");
    c.ssh = opts.ssh;
  }
  if (opts.machine || opts.ssh) cfg.writeConfig(c);
  const mem = require("./memory");
  const bin = mem.binPath().path;
  const both = !opts.claude && !opts.codex;
  const dirs = claudeDirs(opts.configDir);
  log(`  Machine: ${machineName()}${c.ssh ? ` (ssh ${c.ssh})` : ""}${dirs.length > 1 ? ` · ${dirs.length} Claude Code accounts` : ""}`);
  if (both || opts.claude) {
    for (const d of dirs) {
      installClaude(bin, log, settingsIn(d));
      // Turn sync (memory) goes into the same settings file, so every account's turns land too.
      mem.installClaude(bin, () => {}, settingsIn(d));
    }
  }
  // Codex's single notify is the memory hook's; it forwards Codex turns here.
  if (both || opts.codex) mem.install({ codex: true, quiet: true }, log);
  await backfill(log, dirs);
  const running = runningClaude();
  log("");
  log(`  ✓ This machine reports to ${appOrigin()}/sessions as "${machineName()}".`);
  if (running) {
    log(`  ! ${running} Claude Code session${running === 1 ? " is" : "s are"} running here and started before the hooks, so ${running === 1 ? "it doesn't" : "they don't"} report yet.`);
    log(`    Claude Code reads hooks when a session starts. In each one: /exit, then \`claude --resume\` (same session, same history).`);
    log(`    In the desktop app, quit and reopen it. Their past turns are already on the board from the backfill.`);
  } else {
    log(`  New sessions report from their first prompt.`);
  }
  if (dirs.length === 1) log(`  Another Claude Code account on this machine (CLAUDE_CONFIG_DIR)? Re-run with --config-dir <that dir>.`);
  log(`  Next machine: run the same install there, with its own --machine name. \`spacesheep sessions status\` checks any machine.`);
}

function uninstall(opts, log) {
  for (const d of claudeDirs(opts.configDir)) uninstallClaude(log, settingsIn(d));
  log("  (Turn sync is separate — `spacesheep memory uninstall` removes it.)");
}

function status(opts, out) {
  const accounts = claudeDirs(opts.configDir).map((d) => {
    const s = readSettings(settingsIn(d));
    return { dir: tilde(d), hooks: Object.keys(HOOKS).filter((ev) => (s.hooks && s.hooks[ev] || []).some(isOurs)) };
  });
  let last = null;
  try { last = JSON.parse(fs.readFileSync(path.join(STATE, "last.json"), "utf8")); } catch (_) {}
  const running = runningClaude();
  const report = { machine: machineName(), ssh: cfg.readConfig().ssh || null, accounts, running_sessions: running, last_ping: last, board: appOrigin() + "/sessions" };
  if (opts.json) return out(report);
  out(`  machine:      ${report.machine}${report.ssh ? ` (ssh ${report.ssh})` : ""}`);
  for (const a of accounts) {
    const all = a.hooks.length === Object.keys(HOOKS).length;
    out(`  Claude Code:  ${a.dir} — ${all ? "session hooks installed" : a.hooks.length ? `partly installed (${a.hooks.join(", ")})` : "not installed — run \`spacesheep sessions install\`"}`);
  }
  if (running != null) out(`  running:      ${running} Claude Code session${running === 1 ? "" : "s"} (only ones started after the install report)`);
  out(`  last ping:    ${last ? `${new Date(last.at).toISOString()} ${last.event} (${last.source}) ${last.ok ? "delivered" : "FAILED"}` : "none yet"}`);
  out(`  board:        ${report.board}`);
}

module.exports = { ping, install, uninstall, status, backfill, collectBackfill, claudeFacts, codexFacts };
