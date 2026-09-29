// Device-code login against the server's /cli/start + /cli/poll (the same flow
// `npx spacesheep-skill` uses). Approval happens in the browser on spacesheep.dev;
// the key is delivered once through KV and never typed.
"use strict";
const { spawn } = require("child_process");

function openBrowser(url) {
  if (process.env.SPACESHEEP_NO_BROWSER) return false;
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

// A code that can no longer be approved (expired, denied, failed): the caller drops
// the saved one rather than handing out its link again.
const gone = (message) => Object.assign(new Error(message), { code: "ELOGIN" });

/** Ask the server for a code. What comes back is everything a later run needs to
 *  finish the same sign-in, so it is saved as `pending_login` beside the key. */
async function startLogin(origin) {
  let resp;
  try {
    resp = await fetch(`${origin}/cli/start`, { method: "POST", signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new Error(`could not reach ${origin} to start a sign-in (${e.name === "TimeoutError" ? "no answer in 15s" : e.message})`);
  }
  if (!resp.ok) throw new Error(`could not start login (HTTP ${resp.status})`);
  const { user_code, device_code, authorize_url, interval, expires_in } = await resp.json();
  return {
    origin, user_code, device_code, authorize_url,
    interval: Math.max(1, interval || 2),
    expires_at: Date.now() + (expires_in || 600) * 1000,
  };
}

/** The saved sign-in, if it is for this server and can still be approved. */
function livePending(p, origin) {
  return p && p.origin === origin && p.user_code && p.device_code && p.expires_at > Date.now() + 5000 ? p : null;
}

/** Poll until the code is approved (→ { key, username }) or `until` (epoch ms)
 *  passes (→ null). Polls at once, so a code approved while nothing was running is
 *  picked up by the next run without a wait. */
async function waitForLogin(p, until, log = () => {}) {
  const deadline = Math.min(until, p.expires_at);
  for (;;) {
    let data = null;
    try {
      const r = await fetch(`${p.origin}/cli/poll?code=${encodeURIComponent(p.user_code)}&device=${encodeURIComponent(p.device_code)}`);
      data = await r.json();
      if (process.env.SPACESHEEP_DEBUG) log(`  poll: ${JSON.stringify(data)}`);
    } catch {}
    if (data && data.status === "authorized") return { key: data.key, username: data.username || null };
    if (data && data.status === "expired") throw gone("the login request expired before it was approved");
    if (data && data.status === "denied") throw gone("the login request was denied");
    if (data && data.status === "failed") throw gone(data.error || "approval failed");
    if (Date.now() + p.interval * 1000 > deadline) break;
    await sleep(p.interval * 1000);
  }
  if (Date.now() >= p.expires_at - 1000) throw gone("the login request expired before it was approved");
  return null;
}

/** Print the code and the link. The last line is for whoever reads this log, an
 *  agent included: the terminal asks nothing, and the command ends by itself. */
function announce(p, log, open) {
  log(`\n  Verification code:  ${p.user_code}`);
  if (open) {
    log(`  Opening your browser to approve…`);
    if (!openBrowser(p.authorize_url)) log(`  Couldn't open a browser here.`);
  }
  log(`  Approve at this link, on any device (a phone works):\n    ${p.authorize_url}\n`);
  log(`  Waiting for approval. Nothing to type here: this carries on by itself once it's approved.`);
}

/** The whole sign-in, waiting for the approval. `pending` resumes a code an earlier
 *  run already handed out, so the link someone was given stays the one that works. */
async function deviceLogin(origin, log, pending = null, open = !pending) {
  const p = pending || await startLogin(origin);
  announce(p, log, open);
  const got = await waitForLogin(p, p.expires_at, log);
  if (!got) throw gone("timed out waiting for approval");
  return got;
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
    // Only spacesheep's own JSON (it carries a `code`) is a verdict on the key; a
    // bare 401/403 is a proxy or a network allowlist in the way.
    if (!data.code) {
      const e = new Error(`got HTTP ${resp.status} from ${appOrigin}, but not from spacesheep — something between this machine and the server (a proxy or a network allowlist) refused the request; allow spacesheep.dev and mcp.spacesheep.dev, then try again`);
      e.code = "ENET"; throw e;
    }
    const e = new Error(data.error || "the server rejected that key — create one at https://spacesheep.dev/settings/api-keys#create");
    e.code = "EAUTH"; throw e;
  }
  if (!resp.ok || !data.key) throw new Error(data.error || `could not connect (HTTP ${resp.status})`);
  log(`  Key for ${name} created${data.username ? ` for @${data.username}` : ""}.`);
  return { key: data.key, username: data.username || null };
}

module.exports = { deviceLogin, startLogin, livePending, waitForLogin, openBrowser, connectWithKey };
