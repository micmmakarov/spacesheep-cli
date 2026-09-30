"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

const DEFAULT_ORIGIN = "https://mcp.spacesheep.dev";

function configDir() {
  if (process.env.SPACESHEEP_CONFIG_DIR) return process.env.SPACESHEEP_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "spacesheep");
}
const configPath = () => path.join(configDir(), "config.json");
// The machine listener's state (`spacesheep machine on`, lib/machine.js). Its mere
// presence tells the session hooks that one listener serves the whole machine.
const machinePath = () => path.join(configDir(), "machine.json");

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), "utf-8")); } catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/** A key as it arrives from an env var or a pasted line: surrounding whitespace,
 *  invisible characters and one pair of wrapping quotes are not part of any key
 *  (ours are ss_ + hex), so they go — `SPACESHEEP_KEY="ss_…"` kept literally by a
 *  .env loader used to be sent quotes and all and "rejected". */
function cleanKey(raw) {
  let k = String(raw || "").replace(/[\u200B-\u200D\u2060\uFEFF\u00A0]/g, "").trim();
  const q = /^(["'`])(.*)\1$/.exec(k);
  if (q) k = q[2].trim();
  return k;
}

/** The key: env wins (that is how CI passes it), then the login file. */
function resolveKey() {
  const env = cleanKey(process.env.SPACESHEEP_KEY);
  if (env) return { key: env, source: "env" };
  const cfg = readConfig();
  if (cfg.key) return { key: cfg.key, source: "config" };
  return null;
}
const origin = () => process.env.SPACESHEEP_ORIGIN || readConfig().origin || DEFAULT_ORIGIN;
// The app (spacesheep.dev), for the few calls that are not MCP tools: account
// routes like `connect`, and the memory hook. Same override memory.js honours.
const DEFAULT_APP_ORIGIN = "https://spacesheep.dev";
const appOrigin = () => (process.env.SPACESHEEP_APP_ORIGIN || readConfig().appOrigin || DEFAULT_APP_ORIGIN).replace(/\/$/, "");

module.exports = { cleanKey, DEFAULT_ORIGIN, DEFAULT_APP_ORIGIN, configDir, configPath, machinePath, readConfig, writeConfig, resolveKey, origin, appOrigin };
