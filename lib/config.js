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

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), "utf-8")); } catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

/** The key: env wins (that is how CI passes it), then the login file. */
function resolveKey() {
  if (process.env.SPACESHEEP_KEY) return { key: process.env.SPACESHEEP_KEY, source: "env" };
  const cfg = readConfig();
  if (cfg.key) return { key: cfg.key, source: "config" };
  return null;
}
const origin = () => process.env.SPACESHEEP_ORIGIN || readConfig().origin || DEFAULT_ORIGIN;

module.exports = { DEFAULT_ORIGIN, configDir, configPath, readConfig, writeConfig, resolveKey, origin };
