// Auto-update: the CLI checks npm for a newer version once a day and says so.
// Under npx there is nothing to install — `npx spacesheep@latest` already runs
// the newest — so the notice just names that. A global install gets the exact
// command. Silent in CI, in --json mode, or with SPACESHEEP_NO_UPDATE_CHECK=1.
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { configDir } = require("./config");
const pkg = require("../package.json");

const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const cachePath = () => path.join(configDir(), "update-check.json");

function newer(a, b) {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/** Fetch the latest version, at most once a day. Never throws, never blocks long. */
async function latestVersion() {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cachePath(), "utf-8")); } catch {}
  if (cache.checked && Date.now() - cache.checked < CHECK_EVERY_MS) return cache.latest || null;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, { signal: ctl.signal, headers: { Accept: "application/json" } });
    clearTimeout(t);
    const latest = r.ok ? (await r.json()).version : null;
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(cachePath(), JSON.stringify({ checked: Date.now(), latest }));
    return latest;
  } catch { return null; }
}

/** True when this process was started by npx / npm exec rather than a global install. */
function underNpx() {
  const p = process.argv[1] || "";
  return /[\\/]_npx[\\/]/.test(p) || !!process.env.npm_config_user_agent?.includes("exec");
}

async function updateNotice() {
  if (process.env.CI || process.env.SPACESHEEP_NO_UPDATE_CHECK) return null;
  const latest = await latestVersion();
  if (!latest || !newer(latest, pkg.version)) return null;
  const how = underNpx() ? `run \`npx ${pkg.name}@latest\`` : `run \`${pkg.name} update\``;
  return `  ↑ ${pkg.name} ${latest} is available (you have ${pkg.version}) — ${how}`;
}

/** `spacesheep update`: reinstall the newest version globally. */
async function selfUpdate(log) {
  // Never go backwards: while npm's "latest" trails a GitHub install, updating to it
  // was a downgrade that broke every hook (the old version has no `sessions`).
  try { fs.unlinkSync(cachePath()); } catch {}
  const latest = await latestVersion();
  if (latest && latest !== pkg.version && !newer(latest, pkg.version)) {
    log(`  npm has ${pkg.name} ${latest}, older than the ${pkg.version} you have — not downgrading.`);
    log(`  The newest build installs from GitHub: npm install -g github:micmmakarov/spacesheep-cli`);
    return;
  }
  if (latest === pkg.version) return log(`  ${pkg.name} ${pkg.version} is the newest.`);
  // Into this copy's own prefix: npm's default can be somewhere else (a versioned
  // Homebrew folder, 2026-09-26), and upgrading a copy nothing runs changes nothing.
  const prefix = require("./prefix").runningPrefix();
  log(`  Installing ${pkg.name}@latest globally${prefix ? ` into ${prefix}` : ""}…`);
  execSync(`npm install -g ${pkg.name}@latest${prefix ? ` --prefix ${JSON.stringify(prefix)}` : ""}`, { stdio: "inherit" });
}

module.exports = { updateNotice, selfUpdate, newer };
