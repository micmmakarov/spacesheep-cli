// A command that needs the key, on a machine with none, signs the machine in rather
// than failing with "run `spacesheep login`". On 2026-09-29 an agent read that line as
// a job for the person: it asked them to type `! npx spacesheep login`, then to say
// when they had approved. These run the CLI as an agent's shell does, with no terminal.
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");

const BIN = path.join(__dirname, "..", "bin", "spacesheep.js");
const LINK = "https://spacesheep.dev/cli?code=ABCD-EFGH";

function fakeServer() {
  const state = { starts: 0, approved: false, delivered: false, expireNext: false, key: `ss_${"a".repeat(64)}` };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (body, status = 200, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/cli/start" && req.method === "POST") {
      state.starts++;
      return json({ user_code: "ABCD-EFGH", device_code: "dev123", authorize_url: LINK, expires_in: 600, interval: 1 });
    }
    if (url.pathname === "/cli/poll") {
      if (url.searchParams.get("device") !== "dev123") return json({ status: "denied" }, 403);
      if (state.expireNext) { state.expireNext = false; return json({ status: "expired" }); }
      if (!state.approved) return json({ status: "pending" });
      if (state.delivered) return json({ status: "expired" }); // the key is handed out once
      state.delivered = true;
      return json({ status: "authorized", key: state.key, username: "ann" });
    }
    if (url.pathname === "/mcp" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (req.headers.authorization !== `Bearer ${state.key}`) {
          return json({ error: "unauthorized" }, 401, { "www-authenticate": 'Bearer resource_metadata="x"' });
        }
        const msg = JSON.parse(body);
        if (msg.id === undefined) { res.writeHead(202); return res.end(); }
        if (msg.method !== "tools/call") return json({ jsonrpc: "2.0", id: msg.id, result: {} });
        const spaces = [{ emoji: "🐑", title: "A page", visibility: "private", url: "https://spacesheep.dev/@ann/a-page" }];
        return json({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(spaces) }] } });
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, state, origin: `http://127.0.0.1:${srv.address().port}` })));
}

function envFor(origin, dir, extra = {}) {
  const env = { ...process.env, SPACESHEEP_ORIGIN: origin, SPACESHEEP_CONFIG_DIR: dir, SPACESHEEP_NO_BROWSER: "1", SPACESHEEP_NO_UPDATE_CHECK: "1", ...extra };
  for (const k of ["SPACESHEEP_KEY", "CI", "GITHUB_ACTIONS", "SPACESHEEP_QUIET"]) if (!(k in extra)) delete env[k];
  return env;
}

// execFile hands the child pipes, not a terminal: the path an agent's shell takes.
function run(args, env) {
  return new Promise((resolve) => {
    execFile(process.execPath, [BIN, ...args], { env, timeout: 60000 }, (err, stdout, stderr) =>
      resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

const config = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf-8"));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ss-login-"));

test("an agent's first run hands back the link, and the next run waits for the approval and carries on", async () => {
  const { srv, state, origin } = await fakeServer();
  const dir = tmp();
  try {
    const first = await run(["list"], envFor(origin, dir));
    assert.equal(first.code, 3);
    assert.match(first.stderr, /a sign-in has started/);
    assert.ok(first.stderr.includes(LINK), first.stderr);
    assert.match(first.stderr, /The page shows the code ABCD-EFGH/);
    assert.match(first.stderr, /run this same command again/);
    assert.match(first.stderr, /There is nothing for the person to run/);
    assert.equal(config(dir).pending_login.user_code, "ABCD-EFGH");

    const who = await run(["whoami"], envFor(origin, dir));
    assert.equal(who.code, 3);
    assert.ok(who.stderr.includes(`waiting for approval at ${LINK}`), who.stderr);

    setTimeout(() => { state.approved = true; }, 1500); // approved while the second run waits
    const second = await run(["list"], envFor(origin, dir));
    assert.equal(second.code, 0, second.stderr);
    assert.match(second.stdout, /A page/);
    assert.match(second.stderr, /Signed in as @ann/);
    assert.equal(config(dir).key, state.key);
    assert.equal(config(dir).pending_login, undefined);
    assert.equal(state.starts, 1, "the link handed out is the one that works");
  } finally { srv.close(); }
});

test("`login` finishes the sign-in a command handed out instead of starting another", async () => {
  const { srv, state, origin } = await fakeServer();
  const dir = tmp();
  try {
    assert.equal((await run(["deploy", dir], envFor(origin, dir))).code, 3);
    setTimeout(() => { state.approved = true; }, 1500);
    const login = await run(["login"], envFor(origin, dir));
    assert.equal(login.code, 0, login.stderr);
    assert.ok(login.stderr.includes(LINK), login.stderr);
    assert.match(login.stderr, /Nothing to type here/);
    assert.match(login.stderr, /Signed in as @ann/);
    assert.equal(state.starts, 1);
    assert.equal(config(dir).pending_login, undefined);
  } finally { srv.close(); }
});

test("a code that expired is replaced by a fresh link in the same run", async () => {
  const { srv, state, origin } = await fakeServer();
  const dir = tmp();
  try {
    assert.equal((await run(["list"], envFor(origin, dir))).code, 3);
    state.expireNext = true;
    const again = await run(["list"], envFor(origin, dir));
    assert.equal(again.code, 3);
    assert.match(again.stderr, /a sign-in has started/);
    assert.equal(state.starts, 2);
  } finally { srv.close(); }
});

test("CI has nobody to approve a link: it names SPACESHEEP_KEY and starts nothing", async () => {
  const { srv, state, origin } = await fakeServer();
  const dir = tmp();
  try {
    const r = await run(["deploy", dir], envFor(origin, dir, { CI: "true" }));
    assert.equal(r.code, 3);
    assert.match(r.stderr, /set SPACESHEEP_KEY/);
    assert.equal(state.starts, 0);
  } finally { srv.close(); }
});

test("a sign-in that can't start is still \"not signed in\" (exit 3), with the reason", async () => {
  const srv = http.createServer();
  const origin = await new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${srv.address().port}`)));
  await new Promise((resolve) => srv.close(resolve)); // nothing listens there now
  const r = await run(["list"], envFor(origin, tmp()));
  assert.equal(r.code, 3);
  assert.match(r.stderr, /a sign-in couldn't be started: could not reach/);
  assert.match(r.stderr, /set SPACESHEEP_KEY/);
});
