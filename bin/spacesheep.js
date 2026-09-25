#!/usr/bin/env node
"use strict";
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
    spacesheep feedback <message> --client-id <id> [--category bug] [--tag deploy ...]
                                           send feedback to the team; reuse the ID on retries
    spacesheep sessions list [--state done] [--source codex] [--machine NAME]
                                           inspect tracked sessions (JSON); --since ms --offset N --limit N
    spacesheep sessions get <id> --source <source> [--limit N]
                                           recent retained history (JSON)
    spacesheep sessions install | status | uninstall | backfill | forget
                                           manage local reporting hooks
    spacesheep update                      install the newest version globally
    spacesheep memory install [--claude] [--codex]   remember every Claude Code / Codex session in spacesheep
    spacesheep memory status | uninstall   what is wired and synced; remove the hooks

  deploy options
    --space <uuid|url>       update this space (else the .spacesheep.json in the folder, else create)
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
    if (a === "--json") opts.json = true;
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-v" || a === "--version") opts.version = true;
    else if (a === "-o" || a === "--out") opts.out = take();
    else if (a === "-m" || a === "--message" || a === "--version-name") opts.versionName = take();
    else if (a === "--tag") opts.tags.push(take());
    else if (a === "--email") opts.emails.push(take());
    else if (a === "--config-dir") (opts.configDir = opts.configDir || []).push(take());
    else if (a.startsWith("--") && a.includes("=")) { const [k, v] = a.slice(2).split(/=(.*)/); opts[camel(k)] = v; }
    else if (FLAGS.has(a)) opts[camel(a.slice(2))] = true;
    else if (a.startsWith("--")) opts[camel(a.slice(2))] = take();
    else opts._.push(a);
  }
  return opts;
}
const FLAGS = new Set(["--no-manifest", "--claude", "--codex", "--antigravity", "--no-memory"]);
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

const log = (...a) => { if (!process.env.SPACESHEEP_QUIET) console.error(...a); };
const out = (v) => console.log(typeof v === "string" ? v : JSON.stringify(v, null, 2));

function client() {
  const k = cfg.resolveKey();
  if (!k) { const e = new Error("not signed in — run `spacesheep login` (or set SPACESHEEP_KEY)"); e.code = "EAUTH"; throw e; }
  return new McpClient(cfg.origin(), k.key);
}

const commands = {
  async login() {
    const { key, username } = await deviceLogin(cfg.origin(), log);
    cfg.writeConfig({ ...cfg.readConfig(), key, username, origin: process.env.SPACESHEEP_ORIGIN || undefined });
    log(`\n  ✓ Signed in${username ? ` as @${username}` : ""}. Key saved to ${cfg.configPath()}\n`);
  },
  async connect(opts) {
    const [parent, given] = opts._;
    if (!parent || !parent.startsWith("ss_")) throw new Error("usage: spacesheep connect <ss_key> [name] — create the key at https://spacesheep.dev/settings/api-keys#create");
    const name = (given || os.hostname().split(".")[0] || "machine").slice(0, 60);
    const { key, username } = await connectWithKey(cfg.appOrigin(), parent, name, log);
    cfg.writeConfig({
      ...cfg.readConfig(), key, username, machine: name,
      origin: process.env.SPACESHEEP_ORIGIN || undefined,
      appOrigin: process.env.SPACESHEEP_APP_ORIGIN || undefined,
    });
    // Prove the stored key works against the MCP server before saying so.
    await client().call("list_spaces").catch((e) => { if (e.code === "EAUTH") throw e; });
    log(`\n  ✓ Connected${username ? ` as @${username}` : ""} on "${name}". Key saved to ${cfg.configPath()}\n`);
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
  async update() { return selfUpdate(log); },
  async memory(opts) {
    const mem = require("../lib/memory");
    const sub = opts._[0];
    if (sub === "install") return mem.install(opts, log);
    if (sub === "uninstall") return mem.uninstall(opts, log);
    if (sub === "status") return mem.status(opts, out);
    throw new Error("usage: spacesheep memory install [--claude] [--codex] | uninstall | status");
  },
  async sessions(opts) {
    const subcommand = opts._[0];
    if (subcommand === "list" || subcommand === "get") {
      const args = require("../lib/inspection").sessionArgs(opts);
      return out(await client().call(subcommand === "list" ? "list_sessions" : "get_session", args));
    }
    const ses = require("../lib/sessions");
    const sub = opts._[0];
    if (sub === "install") return ses.install(opts, log, process.argv.slice(3));
    if (sub === "uninstall") return ses.uninstall(opts, log);
    if (sub === "status") return ses.status(opts, out, cfg.resolveKey() ? (name, args) => client().call(name, args) : null);
    if (sub === "backfill") { const all = !opts.claude && !opts.codex && !opts.antigravity; return ses.backfill(log, undefined, { claude: all || !!opts.claude, codex: all || !!opts.codex, antigravity: all || !!opts.antigravity }); }
    if (sub === "forget") return ses.forget(opts, log);
    if (sub === "help") return log(`  spacesheep sessions list [--source SOURCE] [--state STATE] [--machine NAME] [--since MS] [--offset N] [--limit N]\n  spacesheep sessions get <id> --source SOURCE [--limit N]\n  spacesheep sessions install [--machine NAME] [--ssh HOST] [--config-dir DIR ...] [--claude] [--codex] [--antigravity]\n  spacesheep sessions status | uninstall | backfill [--claude|--codex|--antigravity] | forget --source codex [--machine NAME]`);
    throw new Error("usage: spacesheep sessions list | get <id> --source SOURCE | install [--machine NAME] [--ssh HOST] [--no-memory] | status | uninstall | backfill | forget --source codex");
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
