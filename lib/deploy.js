// deploy: stage every file with PUT (bytes never travel through tool arguments),
// then call the `deploy` tool with staged_sha references — the same fast path
// the /sheep skill uses. The space id is remembered in .spacesheep.json next to
// the files, so the second run updates instead of creating.
"use strict";
const fs = require("fs");
const path = require("path");

const SKIP_DIRS = new Set(["node_modules", ".git", ".wrangler", ".claude"]);
// The file cap is the SERVER's, per plan (Free 200, Pro 7,000 — see
// spacesheep.dev/@misha/free-vs-pro), and its refusal names the plan. The client
// only stops what no plan allows, so a Pro account is never told "you can't" here.
const MAX_FILES = 7000;

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

const manifestPath = (dir) => path.join(dir, ".spacesheep.json");
function readManifest(dir) {
  try { return JSON.parse(fs.readFileSync(manifestPath(dir), "utf-8")); } catch { return {}; }
}

async function stageAll(client, files, log) {
  const begin = await client.call("stage_begin");
  const uploadUrl = begin.upload_url;
  if (!uploadUrl) throw new Error("stage_begin returned no upload_url");
  const out = [];
  let queue = files.slice();
  const worker = async () => {
    while (queue.length) {
      const f = queue.shift();
      const bytes = fs.readFileSync(f.abs);
      const r = await fetch(`${uploadUrl}?path=${encodeURIComponent(f.path)}`, {
        method: "PUT", body: bytes, headers: { "Content-Type": "application/octet-stream" },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`upload of ${f.path} failed: ${body.error || r.status}`);
      out.push({ path: f.path, staged_sha: body.sha });
      log(`  ↑ ${f.path} (${bytes.length} bytes)`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker));
  return out;
}

async function deploy(client, target, opts, log) {
  const { dir, files } = collect(path.resolve(target || "."));
  if (!files.length) throw new Error(`nothing to deploy in ${dir}`);
  if (files.length > MAX_FILES) throw new Error(`${files.length} files — a space holds at most ${MAX_FILES} even on Pro; deploy the built output, not the source tree`);
  if (files.length > 200) log(`${files.length} files — over the Free plan's 200; the server will say so unless this account is Pro (spacesheep.dev/@misha/free-vs-pro)`);
  if (!files.some((f) => f.path === "index.html")) {
    throw new Error(`no index.html in ${dir} — point spacesheep deploy at the folder (or file) that has the page`);
  }
  const manifest = readManifest(dir);
  const uuid = opts.space || manifest.space || undefined;

  const staged = await stageAll(client, files, log);
  const args = { files: staged };
  if (uuid) args.uuid = uuid;
  if (opts.title) args.title = opts.title;
  else if (!uuid) args.title = manifest.title || path.basename(dir);
  if (opts.slug) args.slug = opts.slug;
  if (opts.emoji) args.emoji = opts.emoji;
  else if (!uuid && manifest.emoji) args.emoji = manifest.emoji;
  if (opts.description) args.description = opts.description;
  else if (!uuid && manifest.description) args.description = manifest.description;
  if (opts.org !== undefined) args.org = opts.org;
  args.version_name = opts.versionName || opts.message || (uuid ? `Deploy from ${opts.via || "CLI"}` : "First deploy");
  if (!uuid && opts.visibility) args.access = { visibility: opts.visibility };

  const result = await client.call("deploy", args);
  const id = result.uuid || result.id || result.space_id;
  if (id && !opts.noManifest) {
    const next = { ...manifest, space: id };
    if (result.url) next.url = result.url;
    fs.writeFileSync(manifestPath(dir), JSON.stringify(next, null, 2) + "\n");
  }
  return result;
}

module.exports = { deploy, collect };
