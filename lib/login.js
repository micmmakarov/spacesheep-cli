// Device-code login against the server's /cli/start + /cli/poll (the same flow
// `npx spacesheep-skill` uses). Approval happens in the browser on spacesheep.dev;
// the key is delivered once through KV and never typed.
"use strict";
const { spawn } = require("child_process");

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function deviceLogin(origin, log) {
  const resp = await fetch(`${origin}/cli/start`, { method: "POST" });
  if (!resp.ok) throw new Error(`could not start login (HTTP ${resp.status})`);
  const { user_code, device_code, authorize_url, interval, expires_in } = await resp.json();
  log(`\n  Verification code:  ${user_code}`);
  log(`  Opening your browser to approve…`);
  if (!openBrowser(authorize_url)) log(`  Couldn't open a browser.`);
  log(`  If it doesn't open, visit:\n    ${authorize_url}\n`);
  log(`  Waiting for approval…`);
  const deadline = Date.now() + (expires_in || 600) * 1000;
  const pollMs = Math.max(1, interval || 2) * 1000;
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let data;
    try {
      const r = await fetch(`${origin}/cli/poll?code=${encodeURIComponent(user_code)}&device=${encodeURIComponent(device_code)}`);
      data = await r.json();
      if (process.env.SPACESHEEP_DEBUG) log(`  poll: ${JSON.stringify(data)}`);
    } catch { continue; }
    if (data.status === "authorized") return { key: data.key, username: data.username || null };
    if (data.status === "expired") throw new Error("the login request expired before it was approved");
    if (data.status === "denied") throw new Error("the login request was denied");
    if (data.status === "failed") throw new Error(data.error || "approval failed");
  }
  throw new Error("timed out waiting for approval");
}


// `spacesheep connect <ss_key> [name]` — sign a machine in without a browser.
// The pasted key is used ONCE, to ask the app for a child key named after this
// machine; the child is what gets stored. The pasted key never lands on disk, so
// the person can revoke it after the rollout and every machine keeps working, and
// the Settings list shows one row per machine, revocable on its own.
async function connectWithKey(appOrigin, parentKey, name, log) {
  const resp = await fetch(`${appOrigin.replace(/\/$/, "")}/api/account/keys/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${parentKey}` },
    body: JSON.stringify({ name }),
  });
  let data = {};
  try { data = await resp.json(); } catch {}
  if (resp.status === 401 || resp.status === 403) {
    const e = new Error(data.error || "the server rejected that key — create one at https://spacesheep.dev/settings/api-keys#create");
    e.code = "EAUTH"; throw e;
  }
  if (!resp.ok || !data.key) throw new Error(data.error || `could not connect (HTTP ${resp.status})`);
  log(`  Key for ${name} created${data.username ? ` for @${data.username}` : ""}.`);
  return { key: data.key, username: data.username || null };
}

module.exports = { deviceLogin, connectWithKey };
