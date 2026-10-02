#!/usr/bin/env node
"use strict";
// Before loading modules that need modern Node, so even an old npx gives a useful error.
if (process.argv[2] === "machine" && process.argv[3] === "on" && Number(process.versions.node.split(".")[0]) < 20) {
  console.error(`spacesheep machine on requires Node >= 20; running ${process.version} from ${process.execPath}.`);
  console.error("Put Node >= 20 first on PATH (Intel Homebrew: export PATH=\"/usr/local/opt/node/bin:$PATH\"), then rerun npx -y spacesheep@latest machine on.");
  process.exit(1);
}

// `memory sync` is a Claude Code / Codex hook: the tool waits for it to exit, so
// it runs before anything else is required and never touches the MCP client.
if (process.argv[2] === "memory" && process.argv[3] === "sync") {
  require("../lib/memory").sync(process.argv.slice(4));
  return;
}
if (process.argv[2] === "sessions" && process.argv[3] === "ping") {
  require("../lib/sessions").ping(process.argv.slice(4));
  return;
}
const fs = require("fs");
const path = require("path");
const pkg = require("../package.json");
const cfg = require("../lib/config");
const { McpClient } = require("../lib/mcp");
const os = require("os");
const { deviceLogin, connectWithKey } = require("../lib/login");
const { deploy } = require("../lib/deploy");
const { updateNotice, selfUpdate } = require("../lib/update");

const HELP = `
  spacesheep ${pkg.version} — publish web pages to spacesheep.dev from a terminal or CI

  Usage
    spacesheep login                       sign in through the browser (stores a key in ~/.config/spacesheep)
    spacesheep connect <ss_key> [name]     sign in with no browser: mints this machine its own key, named
                                           after its hostname (or <name>); the pasted key is never stored
    spacesheep logout                      forget the stored key
    spacesheep whoami                      who the stored key belongs to
    spacesheep deploy [dir|file] [opts]    publish a folder (needs index.html) or one .html file
    spacesheep list                        your spaces
    spacesheep read <space> [path] [-o dir]  print a space's files, or write them to a folder
    spacesheep versions <space>            version history
    spacesheep share <space> [--visibility v] [--email a@b.c ...]
    spacesheep feedback <message> --client-id <id> [--category bug] [--tag deploy ...] [--attach file]
                                           send feedback to the team; reuse the ID on retries.
                                           --attach sends a text file (a log, a transcript tail) beside it
    spacesheep talk status | on | off      "Talk to your sessions": message a session from its page (Pro/Team)
    spacesheep talk listen [--session ID] [--once]
                                           wait for those messages here, one JSON line each
                                           (--session defaults to $CLAUDE_CODE_SESSION_ID);
                                           sessionpipe replaces it — see machine on
    spacesheep talk reply <text> [--session ID]
                                           answer in the page's Session tab
    spacesheep machine on [--folder DIR]... [--mode safe|auto] [--name NAME]
                                           let spacesheep.dev reach this machine's Claude Code sessions
                                           (Pro/Team): runs sessionpipe's install and control pairing
                                           (sessionpipe.org), then turns off the old spacesheep listener
    spacesheep machine status | pair | off
                                           the old spacesheep listener: check it; add a passkey; stop it
    spacesheep sessions list [--state done] [--source codex] [--machine NAME]
                                           inspect tracked sessions (JSON); --since ms --offset N --limit N
    spacesheep sessions get <id> --source <source> [--limit N]
                                           recent retained history (JSON)
    spacesheep sessions export [-o DIR] [--since MS] [--zip FILE]
                                           every session, complete, into DIR/sessions (a backup);
                                           --since takes only those active since then
    spacesheep sessions install            moved to sessionpipe: runs \`sessionpipe install\` with
                                           spacesheep as its sink, then removes this CLI's own hooks
    spacesheep sessions status | uninstall | backfill | forget
                                           this CLI's old reporting hooks
    spacesheep stream <name> --run "cmd"   push every line a command prints to a live stream (JSON or text);
                                           pages that declare it (<meta name="ss-streams" content="<name>">) draw it live
    spacesheep stream <name> --every 1s -- cmd [args]
                                           run a command on an interval and push its output
    spacesheep stream <name> ... --on name=cmd [--on …] [--on-dir DIR]
                                           run a page's button presses here: only what is listed runs
    spacesheep streams [prefix]            your streams: rate, who is watching, whether a machine listens
    spacesheep keys create [--scope stream|sessions|full] [--name NAME]
                                           mint a key with the one this machine holds; prints only the key, so
                                           \`spacesheep keys create --scope stream --name lab-1 | ssh lab-1 spacesheep keys save\`
                                           sets up a lab box with no browser and no key on screen
    spacesheep keys save                   store a key read from stdin (checked against the server first)
    spacesheep connect <ss_key> [name] --scope stream
                                           on the box itself: mint its own streams-only key from a pasted one
    spacesheep login --scope stream [--name NAME]
                                           a key that can only push to your streams — for a lab box
    spacesheep update                      install the newest version globally
    spacesheep memory install              same as sessions install (sessionpipe sends the turns at tier 2)
    spacesheep memory status | uninstall   this CLI's old turn-sync hooks: what is wired; remove them

  deploy options
    --space <uuid|url>       update this space (else the .spacesheep.json in the folder, else create)
    --new                    publish as a new space, whatever the folder's .spacesheep.json names
                             (a pinned folder whose index.html has a different <title> refuses without one of these)
    --title, --slug, --emoji, --description   metadata for a new space (kept on update unless passed)
    --visibility <public|signed_in|members|private>   new spaces only; default private
    --org <slug>             publish under an org
    -m, --message <text>     version name shown in the space's history
    --json                   print the server's JSON result

  Auth
    SPACESHEEP_KEY           an API key (spacesheep.dev/settings/api-keys) — what CI uses instead of login
    SPACESHEEP_APP_ORIGIN    the app origin for account calls such as connect (default ${cfg.DEFAULT_APP_ORIGIN})
    SPACESHEEP_ORIGIN        MCP server origin (default ${cfg.DEFAULT_ORIGIN})

  In GitHub Actions:
    - uses: micmmakarov/spacesheep-cli@v1
      with: { dir: dist, key: \${{ secrets.SPACESHEEP_KEY }} }
`;

function parse(argv) {
  const opts = { _: [], emails: [], tags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === "--") { opts.cmd = argv.slice(i + 1); break; }
    if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-v" || a === "--version") opts.version = true;
    else if (a === "-o" || a === "--out") opts.out = take();
    else if (a === "-m" || a === "--message" || a === "--version-name") opts.versionName = take();
    else if (a === "--tag") opts.tags.push(take());
    else if (a === "--email") opts.emails.push(take());
    else if (a === "--config-dir") (opts.configDir = opts.configDir || []).push(take());
    else if (a === "--folder") (opts.folder = opts.folder || []).push(take());
    else if (a === "--on") (opts.on = opts.on || []).push(take());
    else if (a.startsWith("--") && a.includes("=")) { const [k, v] = a.slice(2).split(/=(.*)/); opts[camel(k)] = v; }
    else if (FLAGS.has(a)) opts[camel(a.slice(2))] = true;
    else if (a.startsWith("--")) opts[camel(a.slice(2))] = take();
    else opts._.push(a);
  }
  return opts;
}
const FLAGS = new Set(["--new", "--no-manifest", "--claude", "--codex", "--antigravity", "--no-memory", "--codex-chain", "--once", "--no-service"]);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
/** --scope as the server names it: stream(s) → "stream", session(s)/ingest → "ingest", full/none → undefined. */
function keyScope(v) {
  if (!v || v === "full") return undefined;
  if (v === "stream" || v === "streams") return "stream";
  if (v === "sessions" || v === "session" || v === "ingest") return "ingest";
  throw new Error(`--scope takes stream, sessions or full (got "${v}")`);
}
function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { if (buf.length < 4096) buf += d; });
    process.stdin.on("end", () => resolve(buf));
  });
}

const log = (...a) => { if (!process.env.SPACESHEEP_QUIET) console.error(...a); };
const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

function client() {
  const k = cfg.resolveKey();
  if (!k) { const e = new Error("not signed in — run `spacesheep login` (or set SPACESHEEP_KEY)"); e.code = "EAUTH"; throw e; }
  return new McpClient(cfg.origin(), k.key);
}

const commands = {
  async login(opts) {
    // `--scope stream`: a key that can only push to your streams — the kind to leave on a lab box.
    const scope = opts.scope === "stream" || opts.scope === "streams" ? "stream" : undefined;
    if (opts.scope && !scope) throw new Error(`--scope takes "stream" (a streams-only key); without it the key is a full one`);
    const { key, username } = await deviceLogin(cfg.origin(), log, scope ? { scope, name: (opts.name || os.hostname().split(".")[0] || "machine").slice(0, 60) } : undefined);
    cfg.writeConfig({ ...cfg.readConfig(), key, username, origin: process.env.SPACESHEEP_ORIGIN || undefined });
    log(`\n  ✓ Signed in${username ? ` as @${username}` : ""}. Key saved to ${cfg.configPath()}\n`);
  },
  async connect(opts) {
    const parent = cfg.cleanKey(opts._[0]);
    const given = opts._[1];
    if (!parent || !parent.startsWith("ss_")) throw new Error("usage: spacesheep connect <ss_key> [name] — create the key at https://spacesheep.dev/settings/api-keys#create (or skip connect and set SPACESHEEP_KEY=ss_… in the environment)");
    const name = (given || os.hostname().split(".")[0] || "machine").slice(0, 60);
    const scope = keyScope(opts.scope);
    const { key, username } = await connectWithKey(cfg.appOrigin(), parent, name, log, scope);
    cfg.writeConfig({
      ...cfg.readConfig(), key, username, machine: name,
      origin: process.env.SPACESHEEP_ORIGIN || undefined,
      appOrigin: process.env.SPACESHEEP_APP_ORIGIN || undefined,
    });
    // Prove the stored key works before saying so: a streams-only key against the
    // stream routes (MCP refuses it by design), anything else against the MCP server.
    if (scope === "stream") await require("../lib/stream").checkKey(cfg, key);
    else await client().call("list_spaces").catch((e) => { if (e.code === "EAUTH" || e.code === "ENET") throw e; });
    log(`\n  ✓ Connected${username ? ` as @${username}` : ""} on "${name}"${scope === "stream" ? " with a streams-only key" : ""}. Key saved to ${cfg.configPath()}\n`);
  },
  async logout() {
    const c = cfg.readConfig(); delete c.key; delete c.username; delete c.machine; cfg.writeConfig(c);
    log(`  ✓ Signed out.`);
  },
  async whoami(opts) {
    const k = cfg.resolveKey();
    if (!k) throw Object.assign(new Error("not signed in"), { code: "EAUTH" });
    const c = cfg.readConfig();
    if (opts.json) return out({ username: c.username || null, key_prefix: k.key.slice(0, 8), source: k.source, machine: c.machine || null });
    out(k.source === "env" ? `key from SPACESHEEP_KEY (${k.key.slice(0, 8)}…)` : `@${c.username || "?"}${c.machine ? ` on "${c.machine}"` : ""} (${k.key.slice(0, 8)}…, ${cfg.configPath()})`);
  },
  async deploy(opts) {
    const r = await deploy(client(), opts._[0], { ...opts, via: process.env.GITHUB_ACTIONS ? "GitHub Actions" : "CLI" }, log);
    if (opts.json) return out(r);
    log(`\n  ✓ ${r.is_update ? "Updated" : "Created"} ${r.url}`);
    for (const w of r.warnings || []) log(`  ! ${w}`);
    if (r.metadata_warning) log(`  ! ${r.metadata_warning.split(".")[0]}. Pass --emoji and --description.`);
    const nudge = require("../lib/talk").deployNudge(r);
    if (nudge) log("\n" + nudge);
    out(r.url);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `url=${r.url}\nuuid=${r.uuid}\nsha=${r.sha}\n`);
  },
  async list(opts) {
    const r = await client().call("list_spaces");
    const rows = Array.isArray(r) ? r : r.spaces || [];
    if (opts.json) return out(rows);
    for (const s of rows) out(`${(s.emoji || "·").padEnd(2)} ${(s.title || "(untitled)").slice(0, 40).padEnd(42)} ${(s.visibility || "").padEnd(10)} ${s.url || s.id}`);
  },
  async read(opts) {
    const [space, file] = opts._;
    if (!space) throw new Error("usage: spacesheep read <space> [path] [-o dir]");
    const r = await client().call("read_space", file ? { uuid: space, path: file } : { uuid: space });
    const text = typeof r === "string" ? r : JSON.stringify(r, null, 2);
    // The tool answers "--- path (N bytes) ---\n<content>" per file.
    const parts = text.split(/^--- (.+?)(?: \(\d+ bytes\))? ---\n/m);
    const files = [];
    for (let i = 1; i + 1 < parts.length; i += 2) files.push({ path: parts[i], content: parts[i + 1].replace(/\n$/, "") });
    if (opts.json) return out(files.length ? files : text);
    if (!opts.out) return process.stdout.write(text.endsWith("\n") ? text : text + "\n");
    if (!files.length) throw new Error(text);
    for (const f of files) {
      const p = path.join(opts.out, f.path);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, f.content);
      log(`  ↓ ${f.path}`);
    }
  },
  async versions(opts) {
    if (!opts._[0]) throw new Error("usage: spacesheep versions <space>");
    const r = await client().call("list_versions", { uuid: opts._[0] });
    if (opts.json) return out(r);
    const rows = Array.isArray(r) ? r : r.versions || [];
    for (const v of rows) out(`${(v.sha || "").slice(0, 12).padEnd(13)} ${(v.created_at || "").slice(0, 16).padEnd(17)} ${v.version_name || v.name || ""}`);
  },
  async share(opts) {
    if (!opts._[0]) throw new Error("usage: spacesheep share <space> [--visibility v] [--email a@b.c ...]");
    const args = { uuid: opts._[0], emails: opts.emails };
    if (opts.visibility) args.visibility = opts.visibility;
    const r = await client().call("share_space", args);
    out(r);
  },
  async feedback(opts) {
    const args = require("../lib/inspection").feedbackArgs(opts);
    out(await client().call("submit_feedback", args));
  },
  async talk(opts) {
    return require("../lib/talk").run(opts, (name, args) => client().call(name, args), out, log);
  },
  async machine(opts) {
    const mc = require("../lib/machine");
    const sub = opts._[0];
    // The listener runs until it is told to stop, then exits 0 so its service stays down.
    if (sub === "run") process.exit(await mc.run(opts));
    // Moved to sessionpipe (lib/sessionpipe.js): its install, its control pairing, then the old listener off.
    if (sub === "on") return require("../lib/sessionpipe").moveTo("machine", opts, log);
    if (sub === "pair") return mc.pair(opts, log);
    if (sub === "off") return mc.off(opts, log);
    if (sub === "status" || !sub) return mc.status(opts, out);
    throw new Error("usage: spacesheep machine on [--folder DIR]... [--mode safe|auto] [--name NAME] [--no-service] | status | pair | off | run");
  },
  // `keys create`: mint a key with the one this machine holds — no browser. Only the key
  // goes to stdout, so it pipes straight into another machine's `keys save`:
  //   spacesheep keys create --scope stream --name lab-1 | ssh lab-1 spacesheep keys save
  async keys(opts) {
    const sub = opts._[0];
    if (sub === "create") {
      const scope = keyScope(opts.scope);
      const k = cfg.resolveKey();
      if (!k) throw Object.assign(new Error("not signed in — `spacesheep login` first (keys create mints from the key this machine holds)"), { code: "EAUTH" });
      const name = String(opts.name || `${scope === "stream" ? "streams" : "key"} · ${os.hostname().split(".")[0]}`).slice(0, 60);
      const { key } = await connectWithKey(cfg.appOrigin(), k.key, name, () => {}, scope);
      if (opts.json) return out({ key, name, scope: scope || "full" });
      process.stdout.write(key + "\n");
      log(`  ✓ Created ${scope === "stream" ? "a streams-only" : scope === "ingest" ? "a sessions-only" : "a full"} key "${name}" (revoke it in Settings → API keys or with the MCP api_keys tool)`);
      return;
    }
    if (sub === "save") {
      const raw = cfg.cleanKey(opts._[1] || (await readStdin()));
      if (!raw.startsWith("ss_")) throw new Error("usage: … | spacesheep keys save   (reads an ss_ key from stdin)");
      await require("../lib/stream").checkKey(cfg, raw);
      cfg.writeConfig({ ...cfg.readConfig(), key: raw, machine: opts.name || os.hostname().split(".")[0], origin: process.env.SPACESHEEP_ORIGIN || undefined, appOrigin: process.env.SPACESHEEP_APP_ORIGIN || undefined });
      log(`  ✓ Key saved to ${cfg.configPath()}`);
      return;
    }
    throw new Error("usage: spacesheep keys create [--scope stream|sessions|full] [--name NAME] [--json] | keys save   (reads a key from stdin)");
  },
  async stream(opts) { return require("../lib/stream").run(opts, cfg, log); },
  async streams(opts) { return require("../lib/stream").list(opts, cfg, out); },
  async update() { return selfUpdate(log); },
  async memory(opts) {
    const mem = require("../lib/memory");
    const sub = opts._[0];
    if (sub === "install") return require("../lib/sessionpipe").moveTo("hooks", opts, log);
    if (sub === "uninstall") return mem.uninstall(opts, log);
    if (sub === "status") return mem.status(opts, out);
    throw new Error("usage: spacesheep memory install [--claude] [--codex] [--codex-chain] | uninstall | status");
  },
  async sessions(opts) {
    const subcommand = opts._[0];
    if (subcommand === "export") return require("../lib/session-export").run(opts, (name, args) => client().call(name, args), log, out);
    if (subcommand === "list" || subcommand === "get") {
      const args = require("../lib/inspection").sessionArgs(opts);
      return out(await client().call(subcommand === "list" ? "list_sessions" : "get_session", args));
    }
    const ses = require("../lib/sessions");
    const sub = opts._[0];
    if (sub === "install") return require("../lib/sessionpipe").moveTo("hooks", opts, log);
    if (sub === "uninstall") return ses.uninstall(opts, log);
    if (sub === "status") return ses.status(opts, out, cfg.resolveKey() ? (name, args) => client().call(name, args) : null);
    if (sub === "backfill") { const all = !opts.claude && !opts.codex && !opts.antigravity; return ses.backfill(log, undefined, { claude: all || !!opts.claude, codex: all || !!opts.codex, antigravity: all || !!opts.antigravity }); }
    if (sub === "forget") return ses.forget(opts, log);
    if (sub === "help") return log(`  spacesheep sessions list [--source SOURCE] [--state STATE] [--machine NAME] [--since MS] [--offset N] [--limit N]\n  spacesheep sessions get <id> --source SOURCE [--limit N]\n  spacesheep sessions export [-o DIR] [--since MS] [--zip FILE] [--json]\n  spacesheep sessions install [--machine NAME] [--ssh HOST] [--config-dir DIR ...] [--claude] [--codex] [--antigravity] [--codex-chain]\n  spacesheep sessions status | uninstall | backfill [--claude|--codex|--antigravity] | forget --source codex [--machine NAME]`);
    throw new Error("usage: spacesheep sessions list | get <id> --source SOURCE | export [-o DIR] | install [--machine NAME] [--ssh HOST] [--no-memory] | status | uninstall | backfill | forget --source codex");
  },
};

(async () => {
  let opts;
  try { opts = parse(process.argv.slice(2)); } catch (e) { console.error(`\n  ✗ ${e.message}\n`); process.exit(2); }
  const cmd = opts._.shift();
  if (opts.version) return out(pkg.version);
  if (!cmd || opts.help || !commands[cmd]) {
    process.stdout.write(HELP);
    process.exit(cmd && !commands[cmd] ? 1 : 0);
  }
  try {
    await commands[cmd](opts);
    if (!opts.json && cmd !== "update") { const n = await updateNotice(); if (n) log(`\n${n}`); }
  } catch (e) {
    console.error(`\n  ✗ ${e.message}\n`);
    process.exit(e.code === "EAUTH" ? 3 : 1);
  }
})();
