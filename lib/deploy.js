// deploy: stage every file with PUT (bytes never travel through tool arguments),
// then call the `deploy` tool with staged_sha references — the same fast path
// the /sheep skill uses. The space id is remembered in .spacesheep.json next to
// the files, so the second run updates instead of creating.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { collectSession } = require("./session");

const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", ".claude"]);
// The file cap is the SERVER's, per plan, and stage_begin answers with the caps of
// the account that is deploying (`plan`, `limits.max_files`), so a tree over its cap
// is refused BEFORE eleven thousand uploads, with the plan named. A copy of the Pro
// cap lived here until 1.13.0 and went stale (7,000 against the server's 12,000): it
// turned away a site the plan allowed. The fallback is only for a server older than
// the field.
const FALLBACK_MAX_FILES = 12000;

// A big site asks the server first. stage_begin takes the file list (path, size,
// content address) and answers every reason the deploy would refuse — file count,
// sizes, the text budget, a root worker.js, the daily budget — plus which files are
// already staged, so a retry uploads only what is missing. An 11,206-file site used
// to find each of those walls only after its last upload (@yaroslavvb, 2026-09-29).
// A small deploy skips it: nothing to save, and it stays exactly as fast.
const PREFLIGHT_FILES = 200;
const PREFLIGHT_BYTES = 50 * 1024 * 1024;
const wantsPreflight = (files) =>
  files.length > PREFLIGHT_FILES || files.reduce((n, f) => n + f.size, 0) > PREFLIGHT_BYTES;

/** The server's staged address: sha256(path \0 bytes \0), first 12 hex. */
function stagedSha(relPath, bytes) {
  return crypto.createHash("sha256")
    .update(Buffer.from(relPath + "\0", "utf8")).update(bytes).update(Buffer.from([0]))
    .digest("hex").slice(0, 12);
}

/** stage_begin's `preflight` as the error that stops the deploy, or null. */
function preflightError(begin) {
  const pre = begin && begin.preflight;
  if (!pre || pre.ok !== false || !Array.isArray(pre.problems) || !pre.problems.length) return null;
  const lines = pre.problems.map((p) => {
    const paths = Array.isArray(p.paths) && p.paths.length ? ` (${p.paths.slice(0, 5).join(", ")}${p.paths.length > 5 ? ", …" : ""})` : "";
    return `  • ${p.error}: ${p.message}${paths}`;
  });
  return `this deploy would be refused — nothing was uploaded:\n${lines.join("\n")}`;
}

/** A tool result that is a refusal ({error, message}), as a thrown error. The
 *  publish guards answer in JSON rather than as an MCP error, and a CLI that read
 *  the refusal as a result printed "Created undefined". */
function refusalError(result, what) {
  if (result && typeof result === "object" && typeof result.error === "string") {
    const err = new Error(`${what} refused — ${result.error}: ${result.message || "no message"}${result.retry_after ? ` (retry in ${result.retry_after}s)` : ""}`);
    err.code = "EREFUSED";
    return err;
  }
  if (typeof result === "string") return Object.assign(new Error(`${what} failed: ${result.slice(0, 500)}`), { code: "EREFUSED" });
  return null;
}

/** The error for a tree the account's plan cannot hold, or null when it fits.
 *  `begin` is stage_begin's answer. */
function fileCapError(count, begin) {
  const limits = (begin && begin.limits) || {};
  const cap = Number(limits.max_files) > 0 ? Number(limits.max_files) : FALLBACK_MAX_FILES;
  if (count <= cap) return null;
  const plan = begin && typeof begin.plan === "string" ? begin.plan : null;
  const who = plan ? `the ${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan` : "this plan";
  const more = plan === "free" ? " (Pro holds 12,000 — spacesheep.dev/pricing)" : "";
  return `${count.toLocaleString("en-US")} files — ${who} holds at most ${cap.toLocaleString("en-US")} per space${more}; deploy the built output, not the source tree`;
}

function collect(root) {
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    // A single file deploys as the page itself.
    const name = path.basename(root);
    return { dir: path.dirname(root), files: [{ path: /\.html?$/i.test(name) ? "index.html" : name, abs: root }] };
  }
  const files = [];
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".") || SKIP_DIRS.has(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, r);
      else if (ent.isFile()) files.push({ path: r, abs });
    }
  };
  walk(root, "");
  return { dir: root, files };
}

// The page's own <title>, as a reader sees it: what a folder's pin is checked
// against, so a different document can't go out over the space the pin names.
function pageTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || "");
  if (!m) return null;
  const t = m[1].replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
  return t || null;
}
const sameTitle = (a, b) => a.toLowerCase().replace(/\s+/g, " ").trim() === b.toLowerCase().replace(/\s+/g, " ").trim();

/** The pin names a space whose page had another title: the error that stops the
 *  publish, or null. A stale .spacesheep.json once put a new report over an
 *  unrelated brief with no question asked (2026-09-22); a page under another
 *  title is another document until the caller says otherwise. A pin written
 *  before the title was recorded can't be checked, and passes. */
function pinMismatch(manifest, title) {
  if (!manifest || !manifest.space || !manifest.page_title || !title) return null;
  if (sameTitle(manifest.page_title, title)) return null;
  const where = manifest.url || manifest.space;
  return `this folder is pinned to ${where} ("${manifest.page_title}"), but index.html is now "${title}" — publishing would replace that page. To update it anyway: --space ${where}. To publish this as a new space: --new.`;
}

const manifestPath = (dir) => path.join(dir, ".spacesheep.json");
function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(manifestPath(dir), "utf-8")); } catch { return {}; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_RATE_WAITS = 6;

/** Upload every file not already staged. A 429 pauses every uploader for the
 *  server's retry_after and carries on where it stopped; an expired link (a big
 *  site can outlast its hour) is renewed with one stage_begin. */
async function stageAll(client, files, log, begin, opts = {}) {
  if (!begin) begin = await client.call("stage_begin");
  let uploadUrl = begin.upload_url;
  if (!uploadUrl) throw new Error("stage_begin returned no upload_url");
  const skip = new Set(opts.alreadyStaged || []);
  const out = [];
  const queue = [];
  for (const f of files) {
    if (f.sha && skip.has(f.sha)) out.push({ path: f.path, staged_sha: f.sha });
    else queue.push(f);
  }
  if (out.length) log(`  = ${out.length} file(s) already staged — not uploading them again`);
  let pausedUntil = 0;
  let waits = 0;
  let renewing = null;
  const renew = () => (renewing ||= client.call("stage_begin").then((b) => {
    if (!b || !b.upload_url) throw new Error("stage_begin returned no upload_url");
    uploadUrl = b.upload_url;
  }).finally(() => { renewing = null; }));
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      const bytes = fs.readFileSync(f.abs);
      for (let attempt = 0; ; attempt++) {
        const wait = pausedUntil - Date.now();
        if (wait > 0) await sleep(wait);
        const url = uploadUrl;
        const r = await fetch(`${url}?path=${encodeURIComponent(f.path)}`, {
          method: "PUT", body: bytes, headers: { "Content-Type": "application/octet-stream" },
        });
        const body = await r.json().catch(() => ({}));
        if (r.ok) {
          out.push({ path: f.path, staged_sha: body.sha });
          log(`  ↑ ${f.path} (${bytes.length} bytes)`);
          break;
        }
        if (r.status === 429 && waits < MAX_RATE_WAITS) {
          const secs = Number(body.retry_after) || Number(r.headers.get("retry-after")) || 60;
          const until = Date.now() + secs * 1000;
          if (until > pausedUntil) {
            pausedUntil = until;
            waits++;
            const done = out.length;
            log(`  … upload rate limit (${body.message || "rate_limited"}). ${done.toLocaleString("en-US")} of ${files.length.toLocaleString("en-US")} staged; resuming in ${Math.ceil(secs / 60)} min — leave this running.`);
          }
          continue;
        }
        if (r.status === 401 && attempt < 2) {
          if (url === uploadUrl) await renew();
          continue;
        }
        const reason = body.error || r.status;
        throw new Error(`upload of ${f.path} failed: ${reason}${body.retry_after ? ` (retry in ${body.retry_after}s)` : ""}. ${out.length.toLocaleString("en-US")} file(s) are staged and stay valid for 24h — running the same command again uploads only the rest.`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  return out;
}

async function deploy(client, target, opts, log) {
  const { dir, files } = collect(path.resolve(target || "."));
  if (!files.length) throw new Error(`nothing to deploy in ${dir}`);
  if (!files.some((f) => f.path === "index.html")) {
    throw new Error(`no index.html in ${dir} — point spacesheep deploy at the folder (or file) that has the page`);
  }
  const manifest = readManifest(dir);
  const index = files.find((f) => f.path === "index.html");
  const title = index ? pageTitle(fs.readFileSync(index.abs, "utf-8")) : null;
  // Not in GitHub Actions: there the pin is committed with the site on purpose, and a
  // site that retitles itself in a commit is still the same site.
  if (!opts.space && !opts.new && !process.env.GITHUB_ACTIONS) {
    const pinned = pinMismatch(manifest, title);
    if (pinned) throw new Error(pinned);
  }
  // --new: the page is its own document — no pin, and none of the pinned space's
  // metadata carried over to it.
  const pin = opts.new ? {} : manifest;
  const uuid = opts.space || pin.space || undefined;

  // Started before the uploads and awaited after them, so it costs no wall time.
  const sessionP = collectSession(dir).catch(() => null);
  // One stage_begin: it opens the upload window AND says what this account may
  // publish, so a tree over the plan's cap is refused before a single upload. For a
  // big site it also carries the file list: every refusal up front, and what is
  // already staged from an earlier attempt.
  for (const f of files) f.size = fs.statSync(f.abs).size;
  const beginArgs = { title: opts.title || title || pin.title || path.basename(dir) };
  if (uuid) beginArgs.space = uuid;
  if (wantsPreflight(files)) {
    log(`  checking ${files.length.toLocaleString("en-US")} files with the server before uploading…`);
    for (const f of files) f.sha = stagedSha(f.path, fs.readFileSync(f.abs));
    beginArgs.files = files.map((f) => ({ path: f.path, size: f.size, sha: f.sha }));
  }
  const begin = await client.call("stage_begin", beginArgs);
  // The preflight's list names every wall at once; the plain cap check is for a
  // small deploy, or a server older than the preflight.
  const preError = preflightError(begin);
  if (preError) throw new Error(preError);
  const capError = fileCapError(files.length, begin);
  if (capError) throw new Error(capError);
  const staged = await stageAll(client, files, log, begin, { alreadyStaged: begin && begin.already_staged });
  const args = { files: staged };
  if (uuid) args.uuid = uuid;
  if (opts.title) args.title = opts.title;
  else if (!uuid) args.title = pin.title || (opts.new && title) || path.basename(dir);
  if (opts.slug) args.slug = opts.slug;
  if (opts.emoji) args.emoji = opts.emoji;
  else if (!uuid && pin.emoji) args.emoji = pin.emoji;
  if (opts.description) args.description = opts.description;
  else if (!uuid && pin.description) args.description = pin.description;
  if (opts.org !== undefined) args.org = opts.org;
  args.version_name = opts.versionName || opts.message || (uuid ? `Deploy from ${opts.via || "CLI"}` : "First deploy");
  if (!uuid && opts.visibility) args.access = { visibility: opts.visibility };
  // What pushed this version — shown in the space's version history. A failure
  // here is swallowed, never a failed deploy.
  const session = await sessionP;
  if (session) args.session = session;

  const result = await client.call("deploy", args);
  const refused = refusalError(result, "deploy");
  if (refused) throw refused;
  const id = result.uuid || result.id || result.space_id;
  if (!id || !result.url) {
    throw new Error(`deploy answered without a space link, so it is unclear whether anything was published — run \`spacesheep list\` to check. Server said: ${JSON.stringify(result).slice(0, 400)}`);
  }
  if (id && !opts.noManifest) {
    const next = { ...pin, space: id };
    if (result.url) next.url = result.url;
    // What this folder last published, so the next run can tell a different page.
    if (title) next.page_title = title; else delete next.page_title;
    fs.writeFileSync(manifestPath(dir), JSON.stringify(next, null, 2) + "\n");
  }
  return result;
}

module.exports = { deploy, collect, fileCapError, FALLBACK_MAX_FILES, pageTitle, pinMismatch, stagedSha, preflightError, refusalError, stageAll, wantsPreflight };
