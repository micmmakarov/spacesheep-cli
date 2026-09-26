// Which installed copy of this CLI is the one that runs, and where npm would put
// the next one.
//
// A machine can hold two copies: the one on PATH (which the hooks run) and one in
// npm's global prefix. On @yaroslavvb's Intel Mac (2026-09-26) npm's prefix was the
// versioned Homebrew folder /usr/local/Cellar/node/25.2.1 while PATH ran
// ~/.local/lib/node_modules/spacesheep, so `npm install -g` and `spacesheep update`
// upgraded a copy nothing ran, and a hook written from the Cellar copy would die
// with the next `brew upgrade node`. So updates install into the running copy's own
// prefix, and install and status say when the two disagree.

"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const real = (p) => { try { return fs.realpathSync(p); } catch (_) { return p; } };

/** The npm prefix a globally installed copy lives under — the part before
 *  lib/node_modules/spacesheep (node_modules/spacesheep on Windows) — or null for
 *  a checkout, a link to one, or an npx cache. */
function prefixOf(script) {
  const p = real(script || "");
  if (/[\\/]_npx[\\/]/.test(p)) return null;
  const re = process.platform === "win32"
    ? /^(.*?)[\\/]node_modules[\\/]spacesheep[\\/]/
    : /^(.*)\/lib\/node_modules\/spacesheep\//;
  const m = re.exec(p);
  return m ? m[1] : null;
}

/** This running copy's prefix. */
function runningPrefix() {
  return prefixOf(process.argv[1]);
}

/** The prefix of the `spacesheep` a shell would run, or null when none is on PATH. */
function pathPrefix() {
  if (process.platform === "win32") return null;
  try {
    const found = execFileSync("sh", ["-c", "command -v spacesheep"], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return found ? prefixOf(found) : null;
  } catch (_) {
    return null;
  }
}

function npmGlobalPrefix() {
  try {
    return execFileSync("npm", ["prefix", "-g"], { encoding: "utf8", timeout: 15000, stdio: ["ignore", "pipe", "ignore"], shell: process.platform === "win32" }).trim() || null;
  } catch (_) {
    return null;
  }
}

/** A path inside Homebrew's versioned node folder, which `brew upgrade node` and
 *  its cleanup delete. */
function inVersionedCellar(p) {
  return /\/Cellar\/node(?:@\d+)?\/[^/]+\//.test(real(p));
}

/** What install and status should warn about, as plain sentences. */
function installWarnings() {
  const out = [];
  const script = real(process.argv[1] || "");
  if (inVersionedCellar(script)) {
    out.push(`the hooks run ${script}, inside Homebrew's versioned node folder, which the next \`brew upgrade node\` deletes. Install into a stable prefix, e.g. \`npm install -g --prefix ~/.local spacesheep\` with ~/.local/bin on PATH, then run this install again from that copy.`);
  }
  const running = prefixOf(script);
  const npm = running ? npmGlobalPrefix() : null;
  if (running && npm && path.resolve(real(npm)) !== path.resolve(real(running))) {
    out.push(`npm installs global packages into ${npm}, but the copy that runs is in ${running}. \`spacesheep update\` upgrades the one that runs; a plain \`npm install -g spacesheep\` would upgrade the other.`);
  }
  return out;
}

module.exports = { prefixOf, runningPrefix, pathPrefix, npmGlobalPrefix, inVersionedCellar, installWarnings };
