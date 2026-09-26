"use strict";
// `spacesheep sessions` — show every Claude Code / Codex / Antigravity session on spacesheep.dev/sessions.
//
//   spacesheep sessions install [--machine NAME] [--ssh HOST] [--claude] [--codex] [--antigravity]
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
//
// Antigravity (the app, the IDE and the `agy` CLI) reads ~/.gemini/config/hooks.json
// and hands every hook camelCase JSON on stdin with `conversationId` where Claude
// Code has `session_id`. Its hooks run as `sessions ping <event> --antigravity`:
//   PreInvocation → prompt (its first model call; later ones are heartbeats) ·
//   PostToolUse → tool · Stop → stop
// It also reads every hook's stdout as JSON, so the ping prints `{}` before it
// does anything else — an empty or garbled stdout can fail the agent's turn.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const cfg = require("./config");
const { redactDeep } = require("./redact");

const HOME = os.homedir();
const STATE = path.join(cfg.configDir(), "sessions");
// The child that posts is detached — nothing waits on it — so it can outwait a
// slow answer. The ping route has answered in ~5 s at times (2026-09-26), and a
// hook that gave up at 5 s dropped the publish ping that links a version to its
// session.
const TIMEOUT_MS = 15000;
const BEAT_MS = 60 * 1000;
const CLI_VERSION = require("../package.json").version;

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
const DESKTOP_ID_RE = /^local_[A-Za-z0-9-]{1,64}$/;

/** Sessions the Claude desktop app started: its own id (`local_…`) by the Claude
 *  Code session id, from the app's per-session files. Read for a backfill only — a
 *  live hook gets the id from its environment. */
function desktopIds(since) {
  const base = process.platform === "darwin" ? path.join(HOME, "Library", "Application Support", "Claude")
    : process.platform === "win32" ? path.join(process.env.APPDATA || path.join(HOME, "AppData", "Roaming"), "Claude")
    : path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, ".config"), "Claude");
  const map = new Map();
  for (const f of recentFiles(path.join(base, "claude-code-sessions"), 3, since, (n) => /^local_[A-Za-z0-9-]+\.json$/.test(n))) {
    try {
      const j = JSON.parse(fs.readFileSync(f, "utf8"));
      if (j && j.cliSessionId && DESKTOP_ID_RE.test(String(j.sessionId))) map.set(String(j.cliSessionId), String(j.sessionId));
    } catch (_) {}
  }
  return map;
}

const CODEX_SESSIONS = path.join(process.env.CODEX_HOME || path.join(HOME, ".codex"), "sessions");
const BACKFILL_DAYS = 30;

const HOOKS = { SessionStart: "start", UserPromptSubmit: "prompt", PostToolUse: "tool", Notification: "notify", Stop: "stop", SessionEnd: "end" };

// Antigravity: one hooks file for the app, the IDE and the CLI; each keeps its
// conversations under its own data dir, <data dir>/brain/<conversationId>/.
const GEMINI = path.join(HOME, ".gemini");
const AG_HOOKS_FILE = path.join(GEMINI, "config", "hooks.json");
const AG_DATA = ["antigravity", "antigravity-cli", "antigravity-ide"].map((d) => path.join(GEMINI, d));
const AG_HOOK_NAME = "spacesheep-sessions";
const AG_HOOKS = { PreInvocation: "prompt", PostToolUse: "tool", Stop: "stop" };

const safeId = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");
const appOrigin = () => cfg.appOrigin();

/** The machine's name on the board: what `connect` or `--machine` saved, else the hostname. */
function machineName() {
  const c = cfg.readConfig();
  if (c.machine) return String(c.machine);
  return os.hostname().replace(/\.(local|lan|home)$/i, "");
}

// --- ping: the hook entry point ----------------------------------------------------

const validToolName = (name) => typeof name === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(name);
/** A tool call that published to spacesheep: an MCP deploy or edit, under whatever
 *  name the harness gives the server (`mcp__spacesheep__deploy`, the plugin's
 *  `mcp__plugin_spacesheep_spacesheep__edit`). Its ping never waits on the heartbeat
 *  throttle — the server links the versions it wrote to this session from that
 *  ping, and a heartbeat dropped as "one a minute" would drop the link with it. */
const isPublishTool = (name) => validToolName(name) && /^mcp__[a-z0-9_.:-]*spacesheep[a-z0-9_.:-]*__(deploy|edit)$/i.test(name);

function ping(argv) {
  if (argv[0] === "--child") return child(argv[1]);
  if (argv.includes("--antigravity")) {
    // Antigravity parses stdout as the hook's answer; `{}` is "carry on" for every event.
    try { fs.writeSync(1, "{}\n"); } catch (_) {}
  }
  try {
    let event = argv[0];
    if (!Object.values(HOOKS).includes(event) && event !== "turn") return;
    let job;
    if (argv.includes("--antigravity")) {
      let input = "";
      try { input = fs.readFileSync(0, "utf8"); } catch (_) {}
      let ev = {};
      try { ev = input ? JSON.parse(input) : {}; } catch (_) {}
      const id = ev.conversationId || ev.session_id || ev.sessionId;
      if (!id) return;
      // PreInvocation fires before every model call of an execution; only the first
      // is the person's ask, the rest say "still working".
      if (event === "prompt" && Number(ev.invocationNum) > 0) event = "tool";
      job = {
        source: "antigravity", event, session_id: String(id),
        cwd: agWorkspace(ev.workspacePaths) || process.cwd(), transcript: ev.transcriptPath || null,
        model: typeof ev.modelName === "string" && ev.modelName !== "auto" ? ev.modelName : null,
      };
      if (event === "tool" && validToolName(ev.toolName || ev.tool_name)) job.tool_name = ev.toolName || ev.tool_name;
    } else if (event === "turn") {
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
      if (event === "tool" && validToolName(ev.tool_name)) job.tool_name = ev.tool_name;
      // Found here, while the process tree is still standing: the detached child's
      // parent is gone by the time it runs. Heartbeats read no facts, so skip them.
      if (event !== "tool") job.claude_pid = claudePid();
      // The Claude desktop app hands its own id for the session to every hook; it is
      // what the app's claude://code/continue link takes, so the board can open it there.
      const host = process.env.CLAUDE_CODE_HOST_SESSION_ID;
      if (host && DESKTOP_ID_RE.test(host)) job.desktop_id = host;
    }
    if (event === "tool" && !isPublishTool(job.tool_name) && !beatDue(job)) return;
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
  const body = { source: job.source, session_id: job.session_id, event: job.event, machine: machineName(), cli_version: CLI_VERSION };
  if (job.event === "tool" && validToolName(job.tool_name)) body.tool_name = job.tool_name;
  if (c.ssh) body.ssh = c.ssh;
  if (job.notification) body.notification = job.notification;
  if (job.note) body.note = job.note.slice(0, 200);
  if (job.desktop_id) body.desktop_id = job.desktop_id;
  // The heartbeat only says "still working", and sends no folder: a hook's cwd
  // follows the agent's `cd`, so the row's folder would flip with every command.
  // Everything else refreshes where the session is and what it is called; the
  // folder is the one the session was started in, as its transcript records it.
  if (job.event !== "tool") {
    let facts = {};
    if (job.source === "antigravity") { if (job.transcript) facts = antigravityFacts(job.transcript); if (job.model) facts.model = job.model; }
    else if (job.transcript) facts = claudeFacts(job.transcript, job.session_id, job.claude_pid);
    else if (job.source === "codex") { const file = findCodexRollout(job.session_id); if (file) facts = codexFacts(file); }
    const { started_at, last_at, ...f } = facts;
    const cwd = f.cwd || job.cwd;
    Object.assign(body, f, { cwd }, gitFacts(cwd));
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
      // Titles (Codex's is its first ask), notifications and remotes can carry a
      // password or a key; nothing leaves this machine unredacted.
      body: JSON.stringify(redactDeep(body)),
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
/** The config dir a transcript belongs to: <dir>/projects/<folder>/<id>.jsonl. */
const configDirOf = (transcript) => path.dirname(path.dirname(path.dirname(transcript)));

/** The Claude account a config dir is signed in as (its `.claude.json`; the default
 *  dir keeps it at ~/.claude.json). Two accounts on one machine are otherwise two
 *  identical rows on the board. */
const accountCache = new Map();
function claudeAccount(dir) {
  if (accountCache.has(dir)) return accountCache.get(dir);
  const files = [path.join(dir, ".claude.json")];
  if (path.resolve(dir) === path.join(HOME, ".claude")) files.unshift(path.join(HOME, ".claude.json"));
  let acct = null;
  for (const f of files) {
    try { const a = JSON.parse(fs.readFileSync(f, "utf8")).oauthAccount; if (a && (a.emailAddress || a.accountUuid)) { acct = String(a.emailAddress || a.accountUuid); break; } } catch (_) {}
  }
  accountCache.set(dir, acct);
  return acct;
}

/** Claude Code's registry entry for a running session, <config>/sessions/<pid>.json:
 *  its name and its Remote Control link. The file goes when the process exits.
 *
 *  The name is only a title when Claude Code or the person chose it. `nameSource`
 *  "derived" is a handle made from the folder (sutro-problems-6a, claude-1a) — on a
 *  Remote Control box that is nearly every live session — so it never titles a row.
 *  "user" is a /rename; auto, hook and peer are Claude Code's own titler, which since
 *  2.1.277 writes a Remote Control session's title here and no longer as `ai-title`. */
const NAME_RANK = { user: "custom", auto: "harness", hook: "harness", peer: "harness" };
function registryEntry(j) {
  if (!j || typeof j !== "object") return null;
  const source = NAME_RANK[j.nameSource];
  return {
    sessionId: j.sessionId ? String(j.sessionId) : null,
    name: source && typeof j.name === "string" && j.name.trim() ? j.name.trim() : null,
    name_source: source || null,
    bridge: typeof j.bridgeSessionId === "string" ? j.bridgeSessionId : null,
  };
}
const liveCache = new Map();
function claudeLive(dir) {
  if (liveCache.has(dir)) return liveCache.get(dir);
  const map = new Map();
  let names = [];
  try { names = fs.readdirSync(path.join(dir, "sessions")).filter((n) => n.endsWith(".json")); } catch (_) {}
  for (const n of names) {
    try {
      const e = registryEntry(JSON.parse(fs.readFileSync(path.join(dir, "sessions", n), "utf8")));
      if (e && e.sessionId) map.set(e.sessionId, e);
    } catch (_) {}
  }
  liveCache.set(dir, map);
  return map;
}
/** The registry entry of one process. A session resumed with `claude --continue
 *  --remote-control` files its entry under a different sessionId from the one its
 *  hooks and transcript use (aifoundry2, 24 Sep: registry e442f603…, hooks ed6d06d5…),
 *  so the hook finds it by process instead. */
function claudeLiveByPid(dir, pid) {
  if (!pid) return null;
  try { return registryEntry(JSON.parse(fs.readFileSync(path.join(dir, "sessions", pid + ".json"), "utf8"))); } catch (_) { return null; }
}

/** The Claude Code process that ran this hook: the nearest ancestor with a registry
 *  file. Hooks run under a shell, so it is usually the parent's parent. One stat per
 *  hop; the process table is read once, and only when the parent isn't it. */
function claudePid() {
  try {
    const dirs = claudeDirs();
    const has = (pid) => dirs.some((d) => fs.existsSync(path.join(d, "sessions", pid + ".json")));
    let pid = process.ppid;
    if (has(pid)) return pid;
    const parent = parentOf();
    for (let hop = 0; hop < 6 && pid > 1; hop++) {
      pid = parent(pid);
      if (pid > 1 && has(pid)) return pid;
    }
  } catch (_) {}
  return null;
}
function parentOf() {
  if (process.platform === "linux") {
    return (pid) => {
      try { const st = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return Number(st.slice(st.lastIndexOf(")") + 2).split(" ")[1]) || 0; } catch (_) { return 0; }
    };
  }
  const table = new Map();
  try {
    const out = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 2000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    for (const l of out.split("\n")) { const m = /^\s*(\d+)\s+(\d+)/.exec(l); if (m) table.set(Number(m[1]), Number(m[2])); }
  } catch (_) {}
  return (pid) => table.get(pid) || 0;
}

/** The Remote Control link as the transcript records it, for when no registry file
 *  gives it (the session ended, or its entry is filed under another id). A
 *  `system`/`bridge_status` record carries the url itself; `bridge-session` records,
 *  written every turn so one is always in the tail, carry `cse_<id>`, whose claude.ai
 *  form is `session_<id>`. Sessions a Remote Control server spawned write neither. */
const LINK_RE = /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+$/;
function transcriptLink(records) {
  for (let i = records.length - 1; i >= 0; i--) {
    const j = records[i];
    if (j.type === "system" && j.subtype === "bridge_status" && typeof j.url === "string" && LINK_RE.test(j.url)) return j.url;
    if (j.type === "bridge-session" && typeof j.bridgeSessionId === "string") {
      const m = /^(?:cse|session)_([A-Za-z0-9]+)$/.exec(j.bridgeSessionId);
      if (m) return `https://claude.ai/code/session_${m[1]}`;
    }
  }
  return null;
}

/** What this machine has learned about a session and must not forget when the
 *  evidence goes: the link and the name live in a registry file that is deleted
 *  when the process exits, the first ask can sit megabytes into the transcript, and
 *  the title scan of a long transcript should only ever read the new bytes. One
 *  small file per session; a lost write costs one re-read. */
const FACTS_DIR = path.join(STATE, "facts");
function memo(source, id) {
  const file = path.join(FACTS_DIR, safeId(source + "-" + id) + ".json");
  let v = {};
  try { v = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch (_) {}
  return {
    v,
    save(patch) {
      const next = { ...v, ...patch };
      if (JSON.stringify(next) === JSON.stringify(v)) return;
      v = next;
      try { fs.mkdirSync(FACTS_DIR, { recursive: true }); fs.writeFileSync(file, JSON.stringify(v)); } catch (_) {}
    },
  };
}

/** A first ask as the Claude Code app titles an untitled session: the prompt with
 *  its whitespace collapsed, whole up to 50 characters, else its first 50 and "...".
 *  Checked against seven of the app's own titles; cutting it the same way is what
 *  lets someone find a row by the name the app shows. */
function appTitle(text) {
  const t = String(text).replace(/\s+/g, " ").trim();
  return t.length > 50 ? t.slice(0, 50) + "..." : t;
}

/** The person's first real ask: a user record that is not the harness's own
 *  (isMeta: skill bodies, caveats) and not a peer or sub-agent hand-back. */
function askText(j) {
  if (!j || j.type !== "user" || j.isMeta || j.isSidechain) return null;
  if (j.origin && j.origin.kind && j.origin.kind !== "human") return null;
  const c = j.message && j.message.content;
  const text = (typeof c === "string" ? c : Array.isArray(c) ? c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n") : "").trim();
  if (!text || require("./memory").isInjected(text)) return null;
  return text;
}
function firstAsk(records) {
  for (const j of records) { const t = askText(j); if (t) return appTitle(t); }
  return null;
}
/** The first ask when the head can't hold it: a prompt with pasted screenshots is one
 *  JSON line, often far past the 64 KB head (476 KB on the Intel). Read line by line
 *  up to the first ask, never more than `cap` bytes. */
function firstAskStreamed(file, cap = 16 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(1024 * 1024);
    let pos = 0, rest = Buffer.alloc(0);
    while (pos < cap) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      let chunk = Buffer.concat([rest, buf.subarray(0, n)]);
      let nl;
      while ((nl = chunk.indexOf(10)) >= 0) {
        const line = chunk.subarray(0, nl).toString("utf8");
        chunk = chunk.subarray(nl + 1);
        let j = null;
        try { j = JSON.parse(line); } catch (_) {}
        const t = askText(j);
        if (t) return appTitle(t);
      }
      rest = chunk;
    }
  } catch (_) {
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
  return null;
}

/** Title records between the two ends of a long transcript, reading only the bytes
 *  added since the last look (a 74 MB Remote Control transcript used to be read
 *  whole on every prompt, stop and notification). Returns the newest of each kind. */
function scanTitles(file, from, found) {
  const out = { custom: found.custom || null, ai: found.ai || null, upto: from };
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    if (size < from) { out.upto = 0; out.custom = out.ai = null; from = 0; }
    const buf = Buffer.alloc(1024 * 1024);
    let pos = from, rest = "";
    while (pos < size) {
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      const lines = (rest + buf.subarray(0, n).toString("latin1")).split("\n");
      rest = lines.pop();
      for (const l of lines) {
        if (l.indexOf('-title"') < 0) continue;
        try {
          const j = JSON.parse(Buffer.from(l, "latin1").toString("utf8"));
          if (j.type === "custom-title" && j.customTitle) out.custom = j.customTitle;
          if (j.type === "ai-title" && j.aiTitle) out.ai = j.aiTitle;
        } catch (_) {}
      }
    }
    out.upto = pos - Buffer.byteLength(rest, "latin1");
  } catch (_) {
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch (_) {}
  }
  return out;
}

/** A session's title and where it came from, best first: a name the person gave it
 *  in Claude Code (/rename: the registry's "user" name or a `custom-title` record),
 *  then Claude Code's own title (the registry's "auto" name, or an `ai-title` record),
 *  then the first ask, marked auto so a real title later replaces it. `title_source`
 *  says which, so the board never swaps a better title for a worse one. A registry
 *  name outlives its process through the memo. */
function claudeFacts(file, sessionId, claudePidHint) {
  const { head, tail } = ends(file, 64 * 1024, 256 * 1024);
  const H = parseLines(head), T = parseLines(tail);
  const out = {};
  const id = sessionId || path.basename(file, ".jsonl");
  const m = memo("claude-code", id);
  let custom = null, ai = null;
  for (const j of H.concat(T)) {
    if (j.type === "custom-title" && j.customTitle) custom = j.customTitle;
    if (j.type === "ai-title" && j.aiTitle) ai = j.aiTitle;
  }
  // A long transcript can bury its title between the two ends.
  let size = 0;
  try { size = fs.statSync(file).size; } catch (_) {}
  if (!custom && !ai && size > 64 * 1024 + 256 * 1024) {
    const s = scanTitles(file, m.v.scan_upto || 0, { custom: m.v.scan_custom, ai: m.v.scan_ai });
    custom = s.custom; ai = s.ai;
    m.save({ scan_upto: s.upto, scan_custom: s.custom, scan_ai: s.ai });
  }
  const dir = configDirOf(file);
  const live = claudeLive(dir).get(id) || claudeLiveByPid(dir, claudePidHint);
  if (live && live.name) m.save({ name: live.name, name_source: live.name_source });
  const bridge = live && live.bridge && /^session_[A-Za-z0-9]+$/.test(live.bridge) ? `https://claude.ai/code/${live.bridge}` : null;
  const url = bridge || transcriptLink(T) || transcriptLink(H) || m.v.url || null;
  if (url) { out.url = url; m.save({ url }); }
  const name = live && live.name ? { title: live.name, source: live.name_source } : m.v.name ? { title: m.v.name, source: m.v.name_source } : null;
  const pick = (name && name.source === "custom" && name)
    || (custom && { title: custom, source: "custom" })
    || (name && name)
    || (ai && { title: ai, source: "harness" });
  let ask = m.v.first_ask || firstAsk(H);
  if (!ask && size > 64 * 1024 && !m.v.first_ask_none) {
    ask = firstAskStreamed(file);
    if (!ask && size > 16 * 1024 * 1024) m.save({ first_ask_none: true });
  }
  if (ask) { out.first_ask = ask; if (!m.v.first_ask) m.save({ first_ask: ask }); }
  if (pick) { out.title = String(pick.title).slice(0, 120); out.title_source = pick.source; }
  else if (ask) { out.title = ask; out.title_auto = true; out.title_source = "first-ask"; }
  const acct = claudeAccount(dir);
  if (acct) out.account = acct;
  for (let i = T.length - 1; i >= 0; i--) {
    const mdl = T[i].message && T[i].message.model;
    if (T[i].type === "assistant" && mdl && mdl !== "<synthetic>") { out.model = mdl; break; }
  }
  // The running Claude Code is the newest record's; a resumed session's first
  // records carry the version it started on days ago.
  const meta = [...T].reverse().find((j) => j.version || j.entrypoint) || H.find((j) => j.version || j.entrypoint);
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
    out.title_auto = true;
    out.title_source = "first-ask";
    break;
  }
  const times = H.concat(T).map((j) => Date.parse(j.timestamp || "")).filter((n) => n > 0);
  if (times.length) { out.started_at = Math.min(...times); out.last_at = Math.max(...times); }
  return out;
}

/** The workspace Antigravity names first — an absolute path, or a file:// URL. */
function agWorkspace(paths) {
  const p = Array.isArray(paths) ? paths.find((x) => typeof x === "string" && x) : null;
  if (!p) return null;
  if (!p.startsWith("file://")) return p;
  try { return decodeURIComponent(new URL(p).pathname); } catch (_) { return null; }
}

/** Antigravity's web remote, https://antigravity.google.com/r/<installation uuid>-v2,
 *  opens this machine's Antigravity from any browser — the one link a session there
 *  can carry, since the app routes no per-conversation URL yet (2026-09-25,
 *  @yaroslavvb's report). The id sits in <data dir>/antigravity_state.pbtxt; the
 *  transcript's own data dir is tried first, then every known one. */
function antigravityRemoteUrl(transcript) {
  const i = transcript ? transcript.indexOf(path.sep + "brain" + path.sep) : -1;
  const dirs = (i > 0 ? [transcript.slice(0, i)] : []).concat(AG_DATA);
  for (const d of dirs) {
    try {
      const m = /installation_uuid:\s*"([0-9a-f-]{36})"/i.exec(fs.readFileSync(path.join(d, "antigravity_state.pbtxt"), "utf8"));
      if (m) return `https://antigravity.google.com/r/${m[1]}-v2`;
    } catch (_) {}
  }
  return null;
}

/** Antigravity's transcript (<data dir>/brain/<id>/.system_generated/logs/transcript.jsonl)
 *  is one step per line: `type` USER_INPUT / PLANNER_RESPONSE, `created_at`, and
 *  `content`, with the person's words wrapped in <USER_REQUEST>. It names no
 *  session and no workspace, so the title is the first ask. */
function antigravityFacts(file) {
  const { head, tail } = ends(file, 128 * 1024, 64 * 1024);
  const H = parseLines(head), T = parseLines(tail);
  const out = {};
  const url = antigravityRemoteUrl(file);
  if (url) out.url = url;
  for (const j of H) {
    if (j.type !== "USER_INPUT" || typeof j.content !== "string") continue;
    const m = /<USER_REQUEST>([\s\S]*?)(?:<\/USER_REQUEST>|$)/.exec(j.content);
    const text = (m ? m[1] : j.content).trim();
    const line = (text.split("\n").find((l) => l.trim()) || "").trim();
    if (!line || /^<[a-z_-]+>/i.test(line)) continue;
    out.title = line.length > 80 ? line.slice(0, 80).replace(/\s+\S*$/, "") + "…" : line;
    out.title_auto = true;
    out.title_source = "first-ask";
    break;
  }
  const times = H.concat(T).map((j) => Date.parse(j.created_at || j.timestamp || "")).filter((n) => n > 0);
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

function collectBackfill(dirs, which = { claude: true, codex: true, antigravity: true }) {
  const since = Date.now() - BACKFILL_DAYS * 86400 * 1000;
  const machine = cfg.readConfig().machine || machineName();
  const ssh = cfg.readConfig().ssh;
  const rows = [];
  // Claude Code: ~/.claude/projects/<folder>/<session>.jsonl (subagent files live one level deeper).
  const files = [];
  if (which.claude) for (const d of dirs || claudeDirs()) files.push(...recentFiles(path.join(d, "projects"), 1, since, (n) => /^[0-9a-f-]{36}\.jsonl$/.test(n)));
  const desktop = files.length ? desktopIds(since) : new Map();
  for (const f of files) {
    const facts = claudeFacts(f, path.basename(f, ".jsonl"));
    if (!facts.started_at) continue;
    const row = { source: "claude-code", session_id: path.basename(f, ".jsonl"), machine, cli_version: CLI_VERSION, ...facts };
    if (desktop.has(row.session_id)) row.desktop_id = desktop.get(row.session_id);
    if (row.cwd) Object.assign(row, { ...gitFacts(row.cwd), ...(facts.branch ? { branch: facts.branch } : {}) });
    if (ssh) row.ssh = ssh;
    rows.push(row);
  }
  // Codex: ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl
  if (which.codex) for (const f of recentFiles(CODEX_SESSIONS, 3, since, (n) => /^rollout-.*\.jsonl$/.test(n))) {
    const m = /([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i.exec(path.basename(f));
    if (!m) continue;
    const facts = codexFacts(f);
    if (!facts.started_at) continue;
    const row = { source: "codex", session_id: m[1], machine, cli_version: CLI_VERSION, ...facts };
    if (ssh) row.ssh = ssh;
    rows.push(row);
  }
  // Antigravity: <data dir>/brain/<conversationId>/.system_generated/logs/transcript.jsonl
  if (which.antigravity) for (const data of AG_DATA) {
    let ids = [];
    try { ids = fs.readdirSync(path.join(data, "brain")).filter((n) => /^[0-9a-f-]{36}$/i.test(n)); } catch (_) {}
    for (const id of ids) {
      const f = path.join(data, "brain", id, ".system_generated", "logs", "transcript.jsonl");
      try { if (fs.statSync(f).mtimeMs < since) continue; } catch (_) { continue; }
      const facts = antigravityFacts(f);
      if (!facts.started_at) continue;
      const row = { source: "antigravity", session_id: id, machine, cli_version: CLI_VERSION, ...facts };
      if (ssh) row.ssh = ssh;
      rows.push(row);
    }
  }
  return rows;
}

async function backfill(log, dirs, which) {
  const k = cfg.resolveKey();
  if (!k) throw Object.assign(new Error("not signed in — run `spacesheep login` first"), { code: "EAUTH" });
  const rows = collectBackfill(dirs, which);
  let added = 0, updated = 0, failed = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const r = await post(k.key, "/api/sessions/backfill", { sessions: rows.slice(i, i + 200) });
    if (r) { added += r.added || 0; updated += r.updated || 0; } else failed += Math.min(200, rows.length - i);
  }
  log(`  ${failed ? "!" : "✓"} Backfill: ${rows.length} session${rows.length === 1 ? "" : "s"} from the last ${BACKFILL_DAYS} days on this machine (${added} new, ${updated} already there${failed ? `, ${failed} not sent — run \`spacesheep sessions backfill\` again` : ""})`);
}

// --- install / uninstall / status -------------------------------------------------------

const isOurs = (h) => h && Array.isArray(h.hooks) && h.hooks.some((x) => typeof x.command === "string" && /spacesheep(\.js)?"? sessions ping/.test(x.command));

function readSettings(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) { return {}; }
}

function installClaude(bin, log, CLAUDE_SETTINGS) {
  const settings = readSettings(CLAUDE_SETTINGS);
  settings.hooks = settings.hooks && typeof settings.hooks === "object" ? settings.hooks : {};
  const added = [];
  const mem = require("./memory");
  for (const [ev, name] of Object.entries(HOOKS)) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const entry = { hooks: [{ type: "command", command: mem.hookCommand(`sessions ping ${name}`), timeout: 5 }] };
    // PostToolUse matches tool names; an empty matcher is every tool.
    if (ev === "PostToolUse") entry.matcher = "";
    // Replace ours rather than skip it: re-running install is how a hook written
    // with an old node or path (or `#!/usr/bin/env node`) gets fixed.
    const mine = list.filter(isOurs);
    if (mine.length === 1 && JSON.stringify(mine[0]) === JSON.stringify(entry)) continue;
    settings.hooks[ev] = list.filter((h) => !isOurs(h)).concat([entry]);
    added.push(ev);
  }
  if (added.length) {
    fs.mkdirSync(path.dirname(CLAUDE_SETTINGS), { recursive: true });
    fs.writeFileSync(CLAUDE_SETTINGS, JSON.stringify(settings, null, 2) + "\n");
  }
  log(`  ${added.length ? "✓" : "="} Claude Code (${tilde(path.dirname(CLAUDE_SETTINGS))}): session hooks ${added.length ? "written" : "already current"}`);
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

/** Antigravity is on this machine when its config dir or any of its data dirs is. */
const hasAntigravity = () => fs.existsSync(path.join(GEMINI, "config")) || AG_DATA.some((d) => fs.existsSync(d));

/** Antigravity's hooks.json: top-level keys are hook names, each holding its
 *  events. Tool events take {matcher, hooks} groups; PreInvocation and Stop take
 *  handlers directly. Timeouts are seconds. Ours lives under one name, so install
 *  replaces it whole and uninstall deletes that one key. */
function antigravityEntry() {
  const mem = require("./memory");
  const handler = (name) => ({ type: "command", command: mem.hookCommand(`sessions ping ${name} --antigravity`), timeout: 5 });
  const entry = { enabled: true };
  for (const [ev, name] of Object.entries(AG_HOOKS)) {
    entry[ev] = ev === "PostToolUse" ? [{ matcher: "*", hooks: [handler(name)] }] : [handler(name)];
  }
  return entry;
}

function installAntigravity(log) {
  const hooks = readSettings(AG_HOOKS_FILE);
  const entry = antigravityEntry();
  if (JSON.stringify(hooks[AG_HOOK_NAME]) === JSON.stringify(entry)) return log(`  = Antigravity (${tilde(AG_HOOKS_FILE)}): session hooks already current`);
  hooks[AG_HOOK_NAME] = entry;
  fs.mkdirSync(path.dirname(AG_HOOKS_FILE), { recursive: true });
  fs.writeFileSync(AG_HOOKS_FILE, JSON.stringify(hooks, null, 2) + "\n");
  log(`  ✓ Antigravity (${tilde(AG_HOOKS_FILE)}): session hooks written`);
}

function uninstallAntigravity(log) {
  const hooks = readSettings(AG_HOOKS_FILE);
  if (!hooks[AG_HOOK_NAME]) return;
  delete hooks[AG_HOOK_NAME];
  fs.writeFileSync(AG_HOOKS_FILE, JSON.stringify(hooks, null, 2) + "\n");
  log(`  ✓ Antigravity (${tilde(AG_HOOKS_FILE)}): session hooks removed`);
}

/** Claude Code sessions running right now. They read their hooks when they
 *  started, so none of them reports until it restarts — the install says how many,
 *  rather than a vague "restart". Best effort: no `ps`, no count. */
function runningClaude() {
  try {
    const ps = (col) => execFileSync("ps", ["-axo", `pid=,${col}=`], { encoding: "utf8", timeout: 6000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    const rows = (text) => new Map(text.split("\n").map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
    // Judge the executable, which `comm` names on its own: an argument ending in
    // /claude (tmux started with -c ~/claude) is not a Claude Code, and the desktop
    // app's copy lives under "Application Support", so the command can't be split.
    const comm = rows(ps("comm")), args = rows(ps("command"));
    let n = 0;
    for (const [pid, exe] of comm) {
      const cmd = args.get(pid) || "";
      if (/spacesheep|Claude Helper|Claude\.app\/Contents\/Frameworks/.test(cmd)) continue;
      if (isClaudeCode(exe, cmd)) n++;
    }
    return n;
  } catch (_) {
    return null;
  }
}
/** A Claude Code process, from its executable (`ps` comm: a full path on macOS, the
 *  file name on Linux) and its command line. The native install runs as
 *  …/claude/versions/<version>; an npm install runs node with the package's cli.js. */
function isClaudeCode(exe, cmd) {
  const base = path.basename(exe);
  if (base === "claude") return true;
  if (/^\d+\.\d+\.\d+$/.test(base) && /\/claude\/versions\/\d+\.\d+\.\d+(\s|$)/.test(cmd)) return true;
  return /^node(js)?$/.test(base) && /@anthropic-ai\/claude-code\//.test(cmd);
}

/** Hooks must run an installed binary: npx takes hundreds of milliseconds and needs
 *  the network, and its cache path does not survive an update. So when this was
 *  started through npx, install globally first and hand over to that copy. */
function ensureGlobal(argv, log) {
  const mem = require("./memory");
  const { viaNpx } = mem.binPath();
  if (!viaNpx) return false;
  const pkg = require("../package.json");
  // Upgrade the copy a shell runs, not whatever npm's default prefix holds: the two can
  // differ, and then every later `spacesheep` ran the old one (prefix.js).
  const target = require("./prefix").pathPrefix();
  log(`  Installing ${pkg.name}@${pkg.version} globally${target ? ` into ${target}` : ""}, so the hooks start in milliseconds…`);
  try {
    execFileSync("npm", ["install", "-g", `${pkg.name}@${pkg.version}`, ...(target ? ["--prefix", target] : [])], { stdio: ["ignore", "ignore", "inherit"] });
  } catch (_) {
    throw new Error("couldn't install globally (`npm install -g spacesheep` failed). Run it yourself — with sudo if your npm needs it — then `spacesheep sessions install`.");
  }
  let bin = target || "";
  if (!bin) try { bin = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim(); } catch (_) {}
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
  const both = !opts.claude && !opts.codex && !opts.antigravity;
  const dirs = claudeDirs(opts.configDir);
  log(`  Machine: ${machineName()}${c.ssh ? ` (ssh ${c.ssh})` : ""}${dirs.length > 1 ? ` · ${dirs.length} Claude Code accounts` : ""}`);
  if (both || opts.claude) {
    for (const d of dirs) {
      installClaude(bin, log, settingsIn(d));
      // Turn sync (memory) goes into the same settings file, so every account's turns
      // land too — unless --no-memory: then only state and metadata leave the machine.
      if (!opts.noMemory) mem.installClaude(bin, () => {}, settingsIn(d));
    }
  }
  // Codex's single notify is the memory hook's; it forwards Codex turns here.
  const codexMem = (both || opts.codex) && !opts.noMemory ? mem.install({ codex: true, quiet: true, codexChain: opts.codexChain }, log).codex : null;
  // Antigravity reports state only: its turns are not synced to memory (yet).
  const antigravity = opts.antigravity || (both && hasAntigravity());
  if (antigravity) installAntigravity(log);
  await backfill(log, dirs, { claude: both || !!opts.claude, codex: both || !!opts.codex, antigravity });
  log("");
  log(`  ✓ This machine reports to ${appOrigin()}/sessions as "${machineName()}".`);
  if (both || opts.claude) {
    log(`  Sessions already running pick the hooks up on their next event (Claude Code 2.1.280+). On an older`);
    log(`  Claude Code, restart them: /exit, then \`claude --resume\` continues the same session.`);
  }
  if (antigravity) log(`  Antigravity reads hooks.json when a conversation starts: new conversations report; open ones after a restart.`);
  if (both || opts.claude || opts.codex) {
    // Say what really happened to Codex: an agent-run install reports this line, and
    // "Claude Code / Codex" over a skipped Codex was the line that got reported
    // (2026-09-26, a Mac whose notify belongs to Codex Computer Use).
    const codexOff = codexMem === "other";
    const codexOn = codexMem && !codexOff;
    const tools = (both || opts.claude) && codexOn ? "Claude Code and Codex" : codexOn ? "Codex" : "Claude Code";
    if (opts.noMemory) log(`  --no-memory: only session state and metadata are sent, never what was said.`);
    else if (!((both || opts.claude) || codexOn)) log(`  Codex turn sync is off: its notify belongs to another tool. Run the install again with --codex-chain to run both.`);
    else log(`  Turn sync is on for ${tools}: each finished turn's text goes to your spacesheep memory. --no-memory turns it off.`);
    if (!opts.noMemory && codexOff && (both || opts.claude)) log(`  Codex turn sync is off: its notify belongs to another tool. Run the install again with --codex-chain to run both.`);
  }
  for (const w of require("./prefix").installWarnings()) log(`  ! ${w}`);
  if (antigravity) log(`  Antigravity sends session state and its first ask as the title, never the conversation.`);
  if ((both || opts.claude) && dirs.length === 1) log(`  Another Claude Code account on this machine (CLAUDE_CONFIG_DIR)? Re-run with --config-dir <that dir>.`);
  log(`  Next machine: run the same install there, with its own --machine name. \`spacesheep sessions status\` checks any machine.`);
}

/** Remove this account's session rows for one source (e.g. Codex rows a
 *  backfill sent that you don't want on the board). Turns in memory stay. */
async function forget(opts, log) {
  const k = cfg.resolveKey();
  if (!k) throw Object.assign(new Error("not signed in — run `spacesheep login` first"), { code: "EAUTH" });
  const source = String(opts.source || "");
  if (!/^[a-z][a-z-]{1,22}$/.test(source)) throw new Error("usage: spacesheep sessions forget --source codex|claude-code [--machine NAME]");
  const r = await post(k.key, "/api/sessions/forget", { source, ...(opts.machine ? { machine: String(opts.machine) } : {}) });
  if (!r) throw new Error("couldn't reach spacesheep — nothing was removed");
  log(`  ✓ Removed ${r.removed} ${source} session${r.removed === 1 ? "" : "s"}${opts.machine ? ` on ${opts.machine}` : ""} from the board.`);
}

function uninstall(opts, log) {
  for (const d of claudeDirs(opts.configDir)) uninstallClaude(log, settingsIn(d));
  uninstallAntigravity(log);
  log("  (Turn sync is separate — `spacesheep memory uninstall` removes it.)");
}

/** What the board holds for this machine, so a machine can tell whether its rows
 *  got their links and accounts without anyone opening the page. Best effort: a
 *  failed read says so and the local report stands. */
async function boardView(call) {
  if (!call) return null;
  try {
    const r = await call("list_sessions", { machine: machineName(), limit: 100, since: Date.now() - 7 * 86400 * 1000 });
    const rows = (r && Array.isArray(r.sessions) ? r.sessions : []).filter((s) => s.source === "claude-code");
    const older = rows.filter((s) => s.cli_version && s.cli_version !== CLI_VERSION).length;
    return {
      claude_sessions_7d: rows.length,
      with_link: rows.filter((s) => s.url).length,
      with_account: rows.filter((s) => s.account).length,
      titled_by: rows.reduce((m, s) => { const k = s.title_source || (s.title_auto ? "first-ask" : s.title ? "harness" : "none"); m[k] = (m[k] || 0) + 1; return m; }, {}),
      from_older_cli: older,
    };
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 200) };
  }
}

async function status(opts, out, call) {
  const accounts = claudeDirs(opts.configDir).map((d) => {
    const s = readSettings(settingsIn(d));
    return { dir: tilde(d), hooks: Object.keys(HOOKS).filter((ev) => (s.hooks && s.hooks[ev] || []).some(isOurs)) };
  });
  let last = null;
  try { last = JSON.parse(fs.readFileSync(path.join(STATE, "last.json"), "utf8")); } catch (_) {}
  const running = runningClaude();
  const ag = readSettings(AG_HOOKS_FILE)[AG_HOOK_NAME];
  const antigravity = ag ? "installed" : hasAntigravity() ? "not installed" : null;
  const board_view = await boardView(call);
  const report = { machine: machineName(), cli_version: CLI_VERSION, ssh: cfg.readConfig().ssh || null, accounts, antigravity, running_sessions: running, last_ping: last, board: appOrigin() + "/sessions", board_view };
  if (opts.json) return out(report);
  out(`  machine:      ${report.machine}${report.ssh ? ` (ssh ${report.ssh})` : ""}`);
  for (const a of accounts) {
    const all = a.hooks.length === Object.keys(HOOKS).length;
    out(`  Claude Code:  ${a.dir} — ${all ? "session hooks installed" : a.hooks.length ? `partly installed (${a.hooks.join(", ")})` : "not installed — run \`spacesheep sessions install\`"}`);
  }
  if (antigravity) out(`  Antigravity:  ${tilde(AG_HOOKS_FILE)} — ${antigravity === "installed" ? "session hooks installed" : "not installed — run \`spacesheep sessions install --antigravity\`"}`);
  if (running != null) out(`  running:      ${running} Claude Code session${running === 1 ? "" : "s"}`);
  out(`  last ping:    ${last ? `${new Date(last.at).toISOString()} ${last.event} (${last.source}) ${last.ok ? "delivered" : "FAILED"}` : "none yet"}`);
  out(`  board:        ${report.board}`);
  if (board_view && board_view.error) out(`  on the board: couldn't read it (${board_view.error})`);
  else if (board_view) {
    const b = board_view;
    out(`  on the board: ${b.claude_sessions_7d} Claude Code session${b.claude_sessions_7d === 1 ? "" : "s"} from this machine in 7 days · ${b.with_link} with a claude.ai link · ${b.with_account} with an account`);
    if (b.from_older_cli) out(`                ${b.from_older_cli} last reported by an older CLI than this one (${CLI_VERSION})`);
    if (b.claude_sessions_7d && b.with_link < b.claude_sessions_7d) out(`                (a session started without Remote Control has no link — that's expected)`);
  }
}

module.exports = { ping, install, uninstall, status, backfill, forget, collectBackfill, claudeFacts, codexFacts, antigravityFacts, antigravityRemoteUrl, isPublishTool, antigravityEntry, agWorkspace, firstAsk, appTitle, transcriptLink, registryEntry, runningClaude, isClaudeCode, claudePid,
  // Each hook runs in a fresh process; a test that edits the registry mid-run clears the cache.
  _resetCaches: () => { liveCache.clear(); accountCache.clear(); gitCache.clear(); } };
