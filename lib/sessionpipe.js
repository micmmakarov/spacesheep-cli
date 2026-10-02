// Session reporting and reaching sessions moved to sessionpipe (npm `sessionpipe`,
// sessionpipe.org): one open client per computer carries the hooks, the spacesheep
// sink and the control daemon that delivers a message into the session itself.
//
// `sessions install`, `memory install` and `machine on` stay so every old
// instruction still works: each says so in one line and runs sessionpipe for you,
// then takes this CLI's own hooks (or listener) off the machine so nothing reports
// twice. Nothing here re-implements sessionpipe: it is run, never copied.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const cfg = require("./config");

const MOVED = "Sessions moved to sessionpipe: one open client per computer for your session hooks and messages from spacesheep.dev (sessionpipe.org). Running it for you.";

/** sessionpipe's control file (its paths.ts): present once a receiver is paired. */
function controlFile(env = process.env) {
  const conf = env.SESSIONPIPE_CONFIG ? path.resolve(env.SESSIONPIPE_CONFIG)
    : process.platform === "win32" ? path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "sessionpipe", "config.json")
    : path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "sessionpipe", "config.json");
  return path.join(path.dirname(conf), "control.json");
}

/** This computer's sessionpipe daemon is paired with a receiver, so spacesheep.dev
 *  reaches its sessions without a listener per session. Local state only. */
function controlPaired(env = process.env) {
  try { const j = JSON.parse(fs.readFileSync(controlFile(env), "utf8")); return Array.isArray(j.receivers) && j.receivers.length > 0; } catch (_) { return false; }
}

/** The argv for each sessionpipe step, in order. Pure, so the test reads exactly
 *  what runs. */
function plan(kind, opts, key, origin) {
  const p = { sink: null, install: null, pair: null };
  // The sink first, so the install's own backfill already has somewhere to go.
  // tier 2 = state, tool names and the turns' words (secrets removed) — what
  // `sessions install` + `memory install` sent; --no-memory keeps the words home.
  if (key) p.sink = ["sink", "add", origin, "--name", "spacesheep", "--tier", opts.noMemory ? "1" : "2", "--token", key];
  const harness = [];
  if (opts.claude) harness.push("--claude-code");
  if (opts.codex) harness.push("--codex");
  if (opts.antigravity) harness.push("--antigravity");
  const machine = opts.machine || opts.name;
  p.install = ["install", ...harness, ...(machine ? ["--machine", String(machine)] : [])];
  if (kind === "machine") {
    p.pair = ["control", "pair", origin, "--mode", opts.mode === "safe" ? "safe" : "auto"];
    for (const f of opts.folder || []) p.pair.push("--folder", f);
    if (opts.name) p.pair.push("--name", String(opts.name));
    if (opts.noService) p.pair.push("--no-service");
  }
  return p;
}

/** What a step looks like on screen: the key never is. */
function shown(args) {
  return "sessionpipe " + args.map((a, i) => (args[i - 1] === "--token" ? "ss_…" : /\s/.test(a) ? JSON.stringify(a) : a)).join(" ");
}

function run(args, log, spawn = spawnSync) {
  log(`  → ${shown(args)}`);
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const r = spawn(npx, ["-y", "sessionpipe@latest", ...args], { stdio: "inherit" });
  if (r.error) throw new Error(`couldn't run sessionpipe (${r.error.message}). Node's npx is needed; or install it: npm i -g sessionpipe`);
  if (r.status !== 0) throw new Error(`\`${shown(args).split(" --token")[0]}\` stopped (exit ${r.status}); nothing of spacesheep's own was removed`);
}

async function signIn(log) {
  const { deviceLogin } = require("./login");
  const { key, username } = await deviceLogin(cfg.origin(), log);
  cfg.writeConfig({ ...cfg.readConfig(), key, username, origin: process.env.SPACESHEEP_ORIGIN || undefined });
  log(`  ✓ Signed in${username ? ` as @${username}` : ""}.`);
}

/** This CLI's session and turn-sync hooks, out of every config they were written to. */
function dropOwnHooks(opts, log) {
  try { require("./sessions").uninstall({ configDir: opts.configDir }, log); } catch (_) {}
  try { require("./memory").uninstall({}, log); } catch (_) {}
}

/** `sessions install` / `memory install` (kind "hooks") and `machine on` (kind "machine"). */
async function moveTo(kind, opts, log, deps = {}) {
  let k = cfg.resolveKey();
  // The sink needs the account's key: a person at a terminal signs in right here, as
  // `spacesheep login` would; a script without one is told to.
  const login = deps.login !== undefined ? deps.login : process.stdin.isTTY && process.stdout.isTTY ? signIn : null;
  if (kind === "hooks" && !k && login) { await login(log); k = cfg.resolveKey(); }
  if (kind === "hooks" && !k) throw Object.assign(new Error("not signed in — run `spacesheep login` first (the key is what your sessions report with)"), { code: "EAUTH" });
  const step = deps.run || run;
  const p = plan(kind, opts, k && k.key, cfg.appOrigin());
  log(`\n  ${MOVED}\n`);
  if (p.sink) step(p.sink, log);
  // This CLI's hooks come out BEFORE sessionpipe's go in: its install chains any
  // Codex notify it finds, and chaining ours would send every Codex turn twice.
  // A failed install leaves the machine unreported until it is run again, never
  // reporting twice.
  const quiet = () => {};
  (deps.dropOwnHooks || dropOwnHooks)(opts, quiet);
  try { step(p.install, log); } catch (e) { throw new Error(`${e.message}. spacesheep's own session hooks are already off: run \`npx -y sessionpipe@latest install\` again`); }
  log("  ✓ sessionpipe reports this computer's sessions now; spacesheep's own session hooks are off.");
  if (p.pair) {
    step(p.pair, log);
    const mc = deps.machine || require("./machine");
    if (mc.readMachine()) {
      await mc.off({}, quiet);
      log("  ✓ The old spacesheep listener on this computer is off; sessionpipe's daemon takes your messages now.");
    }
  }
  log("  `sessionpipe doctor` checks it; `sessionpipe status` shows what reports where.\n");
}

module.exports = { MOVED, controlFile, controlPaired, plan, shown, moveTo };
