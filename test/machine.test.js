"use strict";
// `spacesheep machine` end to end: a fake spacesheep.dev (a local http server with
// hello / wait / jobs / pair) and a fake `claude` on PATH that records its argv and
// answers like `claude -p --output-format json`. Hermetic: temp HOME, config dir,
// no CLAUDE_CONFIG_DIR, no background service.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ss-machine-")));
process.env.HOME = home;
process.env.SPACESHEEP_CONFIG_DIR = path.join(home, "cfg");
process.env.SPACESHEEP_KEY = "ss_test_machine";
process.env.SPACESHEEP_MACHINE_NO_SERVICE = "1";
process.env.SPACESHEEP_NO_UPDATE_CHECK = "1";
process.env.CLAUDECODE = "1"; // as if started from inside a session: must not reach the job's claude
for (const k of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SESSION_ID", "XDG_CONFIG_HOME"]) delete process.env[k];

// --- a fake Claude Code ---------------------------------------------------------------
const BIN = path.join(home, "bin");
const CLAUDE_LOG = path.join(home, "claude-calls.jsonl");
const HELP = `Usage: claude [options] [command] [prompt]

Options:
  --fork-session                        When resuming, create a new session ID
                                        instead of reusing the original (use
                                        with --resume or --continue)
  --output-format <format>              Output format (only works with --print):
                                        "text" (default), "json" (single
                                        result), or "stream-json"
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --permission-prompts <target>         Who answers permission prompts with
                                        --print: "host" (the SDK host or
                                        --permission-prompt-tool) or "none"
                                        (choices: "host", "none", default:
                                        "host")
  -r, --resume [value]                  Resume a conversation by session ID, or
                                        open interactive picker
  --session-id <uuid>                   Use a specific session ID for the
                                        conversation (must be a valid UUID)
`;
fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(path.join(BIN, "claude"), `#!${process.execPath}
const fs = require("fs");
const args = process.argv.slice(2);
if (args.includes("--help")) { process.stdout.write(${JSON.stringify(HELP)}); process.exit(0); }
fs.appendFileSync(${JSON.stringify(CLAUDE_LOG)}, JSON.stringify({ args, cwd: process.cwd(), config: process.env.CLAUDE_CONFIG_DIR || null, claudecode: process.env.CLAUDECODE || null }) + "\\n");
const at = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const sid = args.includes("--fork-session") ? require("crypto").randomUUID() : at("--resume") || at("--session-id");
const text = args[args.length - 1];
const denied = text.includes("please deny") ? [{ tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "rm x" } }] : [];
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "reply to: " + text.split("\\n\\n").slice(1).join("\\n\\n"), session_id: sid, permission_denials: denied }));
`, { mode: 0o755 });
process.env.PATH = BIN + path.delimiter + process.env.PATH;

const machine = require("../lib/machine");
const v = require("../lib/machine-verify");
const { authenticator, browserKey, makeGrant, makeCmd, signedJob, confirmedJob } = require("./machine-helpers");

after(() => fs.rmSync(home, { recursive: true, force: true }));

// --- the machine's folders and sessions ----------------------------------------------
const proj = path.join(home, "proj");
const sub = path.join(proj, "sub");
const outside = path.join(home, "elsewhere");
for (const d of [sub, outside]) fs.mkdirSync(d, { recursive: true });
const projects = path.join(home, ".claude", "projects");
const projectName = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
function transcript(id, cwd, { old = true } = {}) {
  const dir = path.join(projects, projectName(cwd));
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, id + ".jsonl");
  fs.writeFileSync(f, [
    { type: "summary", summary: "old work" },
    { type: "user", cwd, sessionId: id, message: { content: "hello" }, timestamp: new Date().toISOString() },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  if (old) { const t = new Date(Date.now() - 3600e3); fs.utimesSync(f, t, t); }
  return f;
}
const S1 = crypto.randomUUID(), S2 = crypto.randomUUID(), S3 = crypto.randomUUID();
transcript(S1, proj);
transcript(S2, proj);
transcript(S3, outside);
// S2 is open in a terminal right now: Claude Code's registry names it, and the pid is alive.
fs.mkdirSync(path.join(home, ".claude", "sessions"), { recursive: true });
fs.writeFileSync(path.join(home, ".claude", "sessions", `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: S2, cwd: proj }));

const es = authenticator(-7);
const br = browserKey();
const MID = "m_testmachine00000000001";
function setUp(extra = {}) {
  machine.writeMachine({ id: MID, name: "test box", folders: [proj], mode: "safe", rp_id: "localhost", passkeys: [{ ...es.key, added_at: Date.now() }], created_at: Date.now(), ...extra });
}
const claudeCalls = () => { try { return fs.readFileSync(CLAUDE_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse); } catch (_) { return []; } };

// --- a fake spacesheep.dev -------------------------------------------------------------
function fakeServer(handlers = {}) {
  const st = { hellos: [], reports: [], waits: 0, pairStarts: [], polls: 0, offs: 0, jobs: [], expect: 0, served: false };
  const final = () => st.reports.filter((r) => r.status !== "running").length;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const url = new URL(req.url, "http://x");
    const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== "Bearer ss_test_machine") return send(401, { error: "bad key" });
    let m;
    if (req.method === "POST" && /^\/api\/machines\/[^/]+\/hello$/.test(url.pathname)) {
      st.hellos.push(JSON.parse(body));
      return handlers.hello ? handlers.hello(send) : send(200, { ok: true });
    }
    if (req.method === "GET" && /^\/api\/machines\/[^/]+\/wait$/.test(url.pathname)) {
      st.waits++;
      if (!st.served) { st.served = true; return send(200, { jobs: st.jobs }); }
      if (final() >= st.expect) return send(404, { error: "machine removed" });
      await new Promise((r) => setTimeout(r, 30));
      return send(200, { jobs: [] });
    }
    if (req.method === "POST" && (m = /^\/api\/machines\/[^/]+\/jobs\/(\d+)$/.exec(url.pathname))) {
      st.reports.push({ job: Number(m[1]), ...JSON.parse(body) });
      return send(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/api/machines/pair/start") {
      st.pairStarts.push(JSON.parse(body));
      return handlers.pairStart(send, JSON.parse(body));
    }
    if (req.method === "GET" && url.pathname === "/api/machines/pair/poll") {
      st.polls++;
      return handlers.poll(send, url.searchParams.get("code"), st.polls);
    }
    if (req.method === "POST" && /^\/api\/machines\/[^/]+\/off$/.test(url.pathname)) { st.offs++; return send(200, { ok: true }); }
    send(404, { error: "no route" });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    process.env.SPACESHEEP_APP_ORIGIN = `http://127.0.0.1:${server.address().port}`;
    resolve({ st, close: () => new Promise((r) => server.close(r)) });
  }));
}
const logs = [];
const runOnce = () => machine.run({}, { log: (s) => logs.push(s), signals: false, sleep: async () => {} });
const finalReport = (st, id) => st.reports.filter((r) => r.job === id && r.status !== "running").pop();

// --- the listener -----------------------------------------------------------------------

test("machine run: signed jobs run in the session's own folder, everything else is refused without running claude", async () => {
  setUp();
  const srv = await fakeServer();
  const g = makeGrant(es, br);
  const NEW = crypto.randomUUID(), OUTSIDE_NEW = crypto.randomUUID();
  const c1 = makeCmd({ machine: MID, session: S1, text: "what's the status?" });
  const tampered = signedJob(2, makeCmd({ machine: MID, session: S1, text: "harmless" }), g, br);
  tampered.cmd = tampered.cmd.replace("harmless", "rm -rf ~");
  srv.st.jobs = [
    signedJob(1, c1, g, br),
    tampered,
    { id: 3, cmd: makeCmd({ machine: MID, session: S1 }), csig: null, grant: null, confirm: null, created_at: Date.now() },
    signedJob(4, makeCmd({ machine: MID, action: "start", session: OUTSIDE_NEW, cwd: outside, text: "start here" }), g, br),
    signedJob(5, makeCmd({ machine: MID, session: S2, text: "are you there?" }), g, br),
    signedJob(6, makeCmd({ machine: MID, action: "start", session: NEW, cwd: sub, text: "new work" }), g, br),
    signedJob(7, c1, g, br), // a replay of job 1
    confirmedJob(8, makeCmd({ machine: MID, session: S3, text: "outside" }), es),
    confirmedJob(9, makeCmd({ machine: MID, session: S1, text: "please deny this" }), es),
  ];
  srv.st.expect = 9;
  const code = await runOnce();
  await srv.close();
  assert.equal(code, 0);
  assert.equal(srv.st.hellos.length, 1);
  assert.deepEqual(srv.st.hellos[0], { name: "test box", folders: [proj], mode: "safe", agents: ["claude-code"], cli_version: require("../package.json").version });

  const calls = claudeCalls();
  assert.equal(calls.length, 4, JSON.stringify(calls.map((c) => c.args.slice(0, 7))));
  // Job 1: a true continuation of an idle session, in its folder, safe mode.
  const c1call = calls.find((c) => c.args.includes(S1) && c.args[c.args.length - 1].endsWith("what's the status?"));
  assert.deepEqual(c1call.args, ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--resume", S1, machine.WRAP + "what's the status?"]);
  assert.equal(c1call.cwd, proj);
  assert.equal(c1call.config, null);
  assert.equal(c1call.claudecode, null);
  const r1 = finalReport(srv.st, 1);
  assert.equal(r1.status, "done");
  assert.equal(r1.reply, "reply to: what's the status?");
  assert.equal(r1.session, S1);
  assert.equal(r1.copy_of, undefined);
  assert.ok(srv.st.reports.findIndex((r) => r.job === 1 && r.status === "running") < srv.st.reports.findIndex((r) => r.job === 1 && r.status === "done"));

  // Refused, and claude never ran for them.
  assert.equal(finalReport(srv.st, 2).status, "refused");
  assert.match(finalReport(srv.st, 2).note, /changed after it was signed/);
  assert.equal(finalReport(srv.st, 3).status, "refused");
  assert.match(finalReport(srv.st, 3).note, /isn't signed/);
  assert.equal(finalReport(srv.st, 4).status, "refused");
  assert.match(finalReport(srv.st, 4).note, /isn't inside a folder this machine allows/);
  assert.equal(finalReport(srv.st, 7).status, "refused");
  assert.match(finalReport(srv.st, 7).note, /already used/);
  assert.equal(finalReport(srv.st, 8).status, "refused");
  assert.match(finalReport(srv.st, 8).note, /isn't a folder this machine allows/);
  for (const id of [2, 3, 4, 7, 8]) assert.ok(!srv.st.reports.some((r) => r.job === id && r.status === "running"), `job ${id} said running`);
  assert.ok(!calls.some((c) => c.args.includes(OUTSIDE_NEW) || c.args.includes(S3) || c.args.some((a) => a.includes("rm -rf"))));

  // Job 5: S2 is open in a terminal, so its message goes to a copy.
  const c5 = calls.find((c) => c.args.includes(S2));
  assert.deepEqual(c5.args.slice(0, 8), ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--resume", S2, "--fork-session"]);
  const r5 = finalReport(srv.st, 5);
  assert.equal(r5.status, "done");
  assert.equal(r5.copy_of, S2);
  assert.ok(v.UUID_RE.test(r5.session) && r5.session !== S2);
  const state = JSON.parse(fs.readFileSync(path.join(home, "cfg", "machine-state.json"), "utf8"));
  assert.equal(state.copies[S2], r5.session);

  // Job 6: a new session, started in the (allowed) folder it names.
  const c6 = calls.find((c) => c.args.includes(NEW));
  assert.deepEqual(c6.args.slice(0, 7), ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--session-id", NEW]);
  assert.equal(c6.cwd, sub);
  assert.equal(finalReport(srv.st, 6).status, "done");
  assert.equal(finalReport(srv.st, 6).session, NEW);

  // Job 9: confirmed by a fresh tap; the tool it wasn't allowed is named in the reply.
  const r9 = finalReport(srv.st, 9);
  assert.equal(r9.status, "done");
  assert.match(r9.reply, /^reply to: please deny this/);
  assert.match(r9.reply, /Not allowed on this machine.*Bash/);
  // Job 9 is S1's second message: it ran after job 1, never beside it.
  const order = calls.filter((c) => c.args.includes(S1)).map((c) => c.args[c.args.length - 1]);
  assert.deepEqual(order.map((t) => t.split("\n\n")[1]), ["what's the status?", "please deny this"]);

  // The log names jobs and outcomes, never the owner's words.
  assert.ok(logs.some((l) => /job 1: done/.test(l)));
  assert.ok(!logs.some((l) => l.includes("what's the status?")));
});

test("machine run: later messages to a copied session follow the copy", async () => {
  const copy = JSON.parse(fs.readFileSync(path.join(home, "cfg", "machine-state.json"), "utf8")).copies[S2];
  transcript(copy, proj); // Claude Code wrote the copy's transcript; nobody has it open
  fs.writeFileSync(CLAUDE_LOG, "");
  const srv = await fakeServer();
  const g = makeGrant(es, br);
  srv.st.jobs = [signedJob(20, makeCmd({ machine: MID, session: S2, text: "and now?" }), g, br)];
  srv.st.expect = 1;
  assert.equal(await runOnce(), 0);
  await srv.close();
  const calls = claudeCalls();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(0, 7), ["-p", "--output-format", "json", "--permission-mode", "dontAsk", "--resume", copy]);
  assert.ok(!calls[0].args.includes("--fork-session"));
  const r = finalReport(srv.st, 20);
  assert.equal(r.status, "done");
  assert.equal(r.session, copy);
  assert.equal(r.copy_of, S2);
});

test("machine run: auto mode passes --permission-mode auto; never bypassPermissions", async () => {
  setUp({ mode: "auto" });
  fs.writeFileSync(CLAUDE_LOG, "");
  const srv = await fakeServer();
  srv.st.jobs = [confirmedJob(30, makeCmd({ machine: MID, session: S1, text: "go" }), es)];
  srv.st.expect = 1;
  assert.equal(await runOnce(), 0);
  await srv.close();
  const [call] = claudeCalls();
  assert.deepEqual(call.args.slice(3, 5), ["--permission-mode", "auto"]);
  assert.ok(!call.args.join(" ").includes("bypass"));
  setUp();
});

test("machine run: a site that forgot the machine (404) or Talk off (410) stops it cleanly with exit 0", async () => {
  for (const [code, re] of [[404, /removed on spacesheep\.dev/], [410, /Talk is off/]]) {
    logs.length = 0;
    const srv = await fakeServer({ hello: (send) => send(code, { error: "x" }) });
    assert.equal(await runOnce(), 0);
    await srv.close();
    assert.equal(srv.st.waits, 0);
    assert.ok(logs.some((l) => re.test(l)), logs.join("\n"));
  }
});

test("machine run: not set up, or no Claude Code installed", async () => {
  fs.rmSync(machine.files.machine(), { force: true });
  logs.length = 0;
  assert.equal(await runOnce(), 0);
  assert.ok(logs.some((l) => /isn't set up/.test(l)));

  setUp();
  const srv = await fakeServer();
  srv.st.jobs = [confirmedJob(40, makeCmd({ machine: MID, session: S1 }), es)];
  srv.st.expect = 1;
  const code = await machine.run({}, { log: (s) => logs.push(s), signals: false, sleep: async () => {}, findClaude: () => null });
  await srv.close();
  assert.equal(code, 0);
  const r = finalReport(srv.st, 40);
  assert.equal(r.status, "failed");
  assert.equal(r.note, "Claude Code isn't installed on test box");
});

// --- pairing -----------------------------------------------------------------------------

const pairProof = (auth, id, code) => auth.assert(v.sha256(Buffer.from(`ss-machine-pair:${id}:${code}`)));

test("machine on: pairs at this terminal, verifies the proof, and writes machine.json (0600)", async () => {
  fs.rmSync(machine.files.machine(), { force: true });
  const phone = authenticator(-7);
  const PAIR_ID = "m_pairedmachine000000001";
  const srv = await fakeServer({
    pairStart: (send) => send(200, { machine_id: PAIR_ID, code: "PAIRCODE123", pair_url: "http://localhost:8791/machines/pair/PAIRCODE123", check: "482913", expires_at: Date.now() + 60000, rp_id: "localhost" }),
    poll: (send, code, n) => n < 2 ? send(200, { status: "pending" }) : send(200, { status: "paired", machine_id: PAIR_ID, passkey: phone.key, proof: pairProof(phone, PAIR_ID, code) }),
  });
  const out = [], opened = [];
  const m = await machine.on({ folder: [proj, sub], mode: "safe", name: "Laptop" }, (s) => out.push(s), { openBrowser: (u) => opened.push(u), pollMs: 5 });
  await srv.close();
  assert.equal(m.id, PAIR_ID);
  assert.deepEqual(opened, ["http://localhost:8791/machines/pair/PAIRCODE123"]);
  assert.ok(out.join("\n").includes("482 913"));
  const b = srv.st.pairStarts[0];
  assert.deepEqual({ ...b, cli_version: 0 }, { name: "Laptop", folders: [proj, sub], mode: "safe", agents: ["claude-code"], cli_version: 0, platform: process.platform });
  const saved = JSON.parse(fs.readFileSync(machine.files.machine(), "utf8"));
  assert.equal(saved.id, PAIR_ID);
  assert.equal(saved.rp_id, "localhost");
  assert.deepEqual(saved.passkeys.map((k) => ({ id: k.id, alg: k.alg, spki: k.spki })), [phone.key]);
  assert.deepEqual(saved.folders, [proj, sub]);
  if (process.platform !== "win32") assert.equal(fs.statSync(machine.files.machine()).mode & 0o777, 0o600);
  assert.ok(out.some((l) => /machine run/.test(l))); // no service here: says how to run it
});

test("machine on again: adds folders and changes the mode without pairing; says hello", async () => {
  const srv = await fakeServer({ pairStart: () => assert.fail("must not pair again"), poll: () => assert.fail("no") });
  const m = await machine.on({ folder: [outside], mode: "auto" }, () => {}, { pollMs: 5 });
  await srv.close();
  assert.deepEqual(m.folders, [proj, sub, outside]);
  assert.equal(m.mode, "auto");
  assert.equal(srv.st.pairStarts.length, 0);
  assert.deepEqual(srv.st.hellos[0].folders, [proj, sub, outside]);
  assert.equal(srv.st.hellos[0].mode, "auto");
});

test("machine pair: adds a second passkey to the same machine", async () => {
  const laptop = authenticator(-257);
  const id = machine.readMachine().id;
  const srv = await fakeServer({
    pairStart: (send, body) => send(200, { machine_id: body.machine_id, code: "SECONDCODE", pair_url: "http://localhost:8791/p", check: "000111", expires_at: Date.now() + 60000, rp_id: "localhost" }),
    poll: (send, code) => send(200, { status: "paired", passkey: laptop.key, proof: pairProof(laptop, id, code) }),
  });
  const m = await machine.pair({}, () => {}, { openBrowser: () => {}, pollMs: 5 });
  await srv.close();
  assert.equal(srv.st.pairStarts[0].machine_id, id);
  assert.equal(m.passkeys.length, 2);
  assert.equal(machine.readMachine().passkeys[1].alg, -257);
});

test("pairing: a proof that doesn't verify, or for another rp id, trusts nothing", async () => {
  const before = fs.readFileSync(machine.files.machine(), "utf8");
  const phone = authenticator(-7), thief = authenticator(-7);
  const id = machine.readMachine().id;
  let srv = await fakeServer({
    pairStart: (send) => send(200, { machine_id: id, code: "C0DE", pair_url: "http://localhost:8791/p", check: "123456", expires_at: Date.now() + 60000, rp_id: "localhost" }),
    // the server claims the phone's key, but the proof was signed by another key
    poll: (send, code) => send(200, { status: "paired", passkey: phone.key, proof: thief.assert(v.sha256(Buffer.from(`ss-machine-pair:${id}:${code}`)), { cred: phone.key.id }) }),
  });
  await assert.rejects(machine.pair({}, () => {}, { openBrowser: () => {}, pollMs: 5 }), /didn't verify.*nothing was trusted/);
  await srv.close();
  assert.equal(fs.readFileSync(machine.files.machine(), "utf8"), before);

  srv = await fakeServer({
    pairStart: (send) => send(200, { machine_id: id, code: "C0DE", pair_url: "https://evil.example/p", check: "123456", expires_at: Date.now() + 60000, rp_id: "evil.example" }),
    poll: () => assert.fail("must not poll"),
  });
  await assert.rejects(machine.pair({}, () => {}, { openBrowser: () => assert.fail("must not open"), pollMs: 5 }), /evil\.example.*nothing was paired/);
  await srv.close();

  srv = await fakeServer({
    pairStart: (send) => send(200, { machine_id: id, code: "C0DE", pair_url: "http://localhost:8791/p", check: "123456", expires_at: Date.now() + 60000, rp_id: "localhost" }),
    poll: (send) => send(410, { error: "expired" }),
  });
  await assert.rejects(machine.pair({}, () => {}, { openBrowser: () => {}, pollMs: 5 }), /expired/);
  await srv.close();
  assert.equal(fs.readFileSync(machine.files.machine(), "utf8"), before);
});

test("machine status and off: off forgets everything that could run a command", async () => {
  const lines = [];
  machine.status({}, (s) => lines.push(s));
  assert.ok(lines.some((l) => /passkeys:\s+2/.test(l)));
  const srv = await fakeServer();
  await machine.off({}, () => {});
  await srv.close();
  assert.equal(srv.st.offs, 1);
  assert.ok(!fs.existsSync(machine.files.machine()));
  assert.ok(!fs.existsSync(machine.files.nonces()));
  assert.ok(!fs.existsSync(machine.files.state()));
});

// --- pieces ------------------------------------------------------------------------------

test("permission flags from --help: dontAsk, else default/manual + prompts to nobody; auto or a refusal", () => {
  const caps = machine.parseCaps(HELP);
  assert.deepEqual(caps, { hasMode: true, modes: ["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"], promptsNone: true, fork: true });
  assert.deepEqual(machine.modeFlags("safe", caps).args, ["--permission-mode", "dontAsk"]);
  assert.deepEqual(machine.modeFlags("auto", caps).args, ["--permission-mode", "auto"]);
  const old = { hasMode: true, modes: ["acceptEdits", "bypassPermissions", "default", "plan"], promptsNone: false, fork: true };
  assert.deepEqual(machine.modeFlags("safe", old).args, ["--permission-mode", "default"]);
  assert.match(machine.modeFlags("auto", old).error, /no auto permission mode/);
  assert.deepEqual(machine.modeFlags("safe", { hasMode: true, modes: ["manual", "plan"], promptsNone: true, fork: true }).args, ["--permission-mode", "manual", "--permission-prompts", "none"]);
  assert.deepEqual(machine.modeFlags("safe", machine.parseCaps("")).args, []);
  for (const c of [caps, old]) for (const mode of ["safe", "auto"]) assert.ok(!JSON.stringify(machine.modeFlags(mode, c)).includes("bypass"));
});

test("the launchd agent and systemd unit stay down after a clean exit", () => {
  const spec = { argv: ["/opt/node/bin/node", "/lib/spacesheep/bin/spacesheep.js", "machine", "run"], env: { PATH: "/opt/node/bin:/usr/bin", SPACESHEEP_APP_ORIGIN: "http://localhost:8791" }, log: "/Users/me/.config/spacesheep/machine.log" };
  const plist = machine.launchdPlist(spec);
  assert.match(plist, /<key>Label<\/key><string>dev\.spacesheep\.machine<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/lib\/spacesheep\/bin\/spacesheep\.js<\/string>\s*<string>machine<\/string>\s*<string>run<\/string>/);
  assert.match(plist, /<key>StandardOutPath<\/key><string>\/Users\/me\/\.config\/spacesheep\/machine\.log<\/string>/);
  assert.match(plist, /<key>SPACESHEEP_APP_ORIGIN<\/key><string>http:\/\/localhost:8791<\/string>/);
  const unit = machine.systemdUnit(spec);
  assert.match(unit, /^ExecStart="\/opt\/node\/bin\/node" "\/lib\/spacesheep\/bin\/spacesheep\.js" "machine" "run"$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^StandardOutput=append:\/Users\/me\/\.config\/spacesheep\/machine\.log$/m);
  const spec2 = machine.serviceSpec();
  assert.deepEqual(spec2.argv.slice(-2), ["machine", "run"]);
  assert.ok(spec2.env.PATH.split(path.delimiter).includes(path.dirname(process.execPath)));
  assert.ok(spec2.env.PATH.split(path.delimiter).includes(BIN)); // where claude is
  assert.equal(spec2.env.SPACESHEEP_CONFIG_DIR, process.env.SPACESHEEP_CONFIG_DIR);
});

test("nonces are remembered across restarts for 25 hours, then forgotten", () => {
  const file = path.join(home, "nonces-test.json");
  let now = 1_000_000_000_000;
  const a = machine.nonceStore(file, () => now);
  assert.equal(a.seen("nonce-one-aaaaaaaaaaaaa"), false);
  assert.equal(a.seen("nonce-one-aaaaaaaaaaaaa"), true);
  const b = machine.nonceStore(file, () => now); // a restart
  assert.equal(b.seen("nonce-one-aaaaaaaaaaaaa"), true);
  now += 24 * 3600e3;
  assert.equal(machine.nonceStore(file, () => now).seen("nonce-one-aaaaaaaaaaaaa"), true);
  now += 1 * 3600e3 + 1;
  assert.equal(machine.nonceStore(file, () => now).seen("nonce-one-aaaaaaaaaaaaa"), false);
});

test("the session folder comes from the transcript, past a huge first line", () => {
  const dir = path.join(projects, projectName(proj));
  const f = path.join(dir, "big.jsonl");
  const big = JSON.stringify({ type: "user", message: { content: "x".repeat(3 * 1024 * 1024) } });
  fs.writeFileSync(f, big + "\n" + JSON.stringify({ type: "user", cwd: "/somewhere/else" }) + "\n" + JSON.stringify({ type: "user", cwd: proj }) + "\n");
  assert.equal(machine.sessionFolder({ file: f, project: projectName(proj) }), proj);
  assert.equal(machine.sessionFolder({ file: f, project: "-no-match" }), "/somewhere/else");
  fs.rmSync(f);
});

test("folders: real paths of folders that exist; never the whole disk; inside-checks follow symlinks", () => {
  assert.deepEqual(machine.resolveFolders([proj, proj + "/", sub]), [proj, sub]);
  assert.throws(() => machine.resolveFolders(["/"]), /whole disk/);
  assert.throws(() => machine.resolveFolders([path.join(home, "nope")]), /no such folder/);
  const link = path.join(outside, "link-to-proj");
  fs.symlinkSync(proj, link);
  assert.equal(machine.allowedFolder(link, [proj]), proj);
  assert.equal(machine.allowedFolder(path.join(proj, "..", "elsewhere"), [proj]), null);
  assert.equal(machine.allowedFolder(proj + "-sibling", [proj]), null);
  fs.mkdirSync(proj + "-sibling");
  assert.equal(machine.allowedFolder(proj + "-sibling", [proj]), null);
});

test("machine.log is cut to its newest half in place", () => {
  const f = path.join(home, "cut.log");
  fs.writeFileSync(f, Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n") + "\n");
  const ino = fs.statSync(f).ino;
  assert.equal(machine.trimLog(f, 10000), true);
  const text = fs.readFileSync(f, "utf8");
  assert.ok(text.length <= 5000 && text.startsWith("line ") && text.endsWith("line 2999\n"));
  assert.equal(fs.statSync(f).ino, ino);
});

test("parseResult and replyFrom: the result text, capped, secrets redacted, denials named", () => {
  assert.equal(machine.parseResult('{"type":"result","result":"hi","session_id":"x"}').result, "hi");
  assert.equal(machine.parseResult('[{"type":"system"},{"type":"result","result":"arr"}]').result, "arr");
  assert.equal(machine.parseResult("noise\n{\"type\":\"result\",\"result\":\"last\"}").result, "last");
  assert.equal(machine.parseResult(""), null);
  const r = machine.replyFrom({ result: "x".repeat(30000), permission_denials: [{ tool_name: "Edit" }, { tool_name: "Edit" }] });
  assert.ok(r.length <= 20000 && /Edit\.\)$/.test(r));
  assert.match(machine.replyFrom({ result: "the key is ghp_" + "a".repeat(36) }), /\[redacted\]/);
});
