"use strict";
// Antigravity session hooks: the stdin it sends, the stdout it requires, the
// hooks.json shape it reads, and what its transcript says. Run: npm test
const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const ses = require("../lib/sessions");

const BIN = path.join(__dirname, "..", "bin", "spacesheep.js");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ss-ag-"));
// The hook hands its job file to a detached child that reads and deletes it; a test
// that reads the file raced that child and lost now and then. Preloaded into every
// node the hook starts, this ends the child before it touches the file.
const NO_CHILD = path.join(tmp(), "no-child.js");
fs.writeFileSync(NO_CHILD, 'if (process.argv.includes("--child")) process.exit(0);\n');
const ID = "5c5e41a5-7ce9-4789-b200-28567b586871";

function hook(event, stdin) {
  const home = tmp();
  const r = spawnSync(process.execPath, [BIN, "sessions", "ping", event, "--antigravity"], {
    input: typeof stdin === "string" ? stdin : JSON.stringify(stdin),
    env: { ...process.env, HOME: home, SPACESHEEP_CONFIG_DIR: path.join(home, "cfg"), SPACESHEEP_KEY: "", NODE_OPTIONS: `--require ${NO_CHILD}` },
    encoding: "utf8",
  });
  const dir = path.join(home, "cfg", "sessions", "jobs");
  const jobs = fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n), "utf8"))) : [];
  return { stdout: r.stdout, status: r.status, jobs };
}

describe("ping --antigravity", () => {
  it("always answers {} on stdout, even with no usable input", () => {
    for (const input of ["", "not json", {}, { conversationId: ID, workspacePaths: ["/w"] }]) {
      const r = hook("stop", input);
      assert.strictEqual(r.status, 0);
      assert.deepStrictEqual(JSON.parse(r.stdout), {});
    }
  });

  it("reads conversationId, the first workspace and the model", () => {
    const r = hook("stop", { conversationId: ID, workspacePaths: ["file:///Users/yv/git/my%20repo"], transcriptPath: "/t.jsonl", modelName: "gemini-3-pro" });
    assert.strictEqual(r.jobs.length, 1);
    const { at, ...job } = r.jobs[0];
    assert.ok(Number.isFinite(at) && Math.abs(Date.now() - at) < 10_000);
    assert.deepStrictEqual(job, { source: "antigravity", event: "stop", session_id: ID, cwd: "/Users/yv/git/my repo", transcript: "/t.jsonl", model: "gemini-3-pro", workspaces: ["/Users/yv/git/my repo"] });
  });

  it("only the first model call of an execution is the ask; the rest are heartbeats", () => {
    assert.strictEqual(hook("prompt", { conversationId: ID, invocationNum: 0 }).jobs[0].event, "prompt");
    assert.strictEqual(hook("prompt", { conversationId: ID, invocationNum: 3 }).jobs[0].event, "tool");
  });

  it("forwards only a valid tool name, never its arguments or output", () => {
    const r = hook("tool", { conversationId: ID, toolName: "mcp__repo.read", toolInput: { secret: "do-not-send" }, toolOutput: "private" });
    assert.strictEqual(r.jobs[0].tool_name, "mcp__repo.read");
    assert.ok(!JSON.stringify(r.jobs).includes("do-not-send"));
    assert.ok(!JSON.stringify(r.jobs).includes("private"));
    assert.strictEqual(hook("tool", { conversationId: ID, toolName: "Bash secret args" }).jobs[0].tool_name, undefined);
    assert.strictEqual(hook("stop", { conversationId: ID, toolName: "Bash" }).jobs[0].tool_name, undefined);
  });

  it("drops a ping with no id rather than inventing one", () => {
    assert.strictEqual(hook("prompt", { workspacePaths: ["/w"] }).jobs.length, 0);
  });
});

describe("antigravityEntry — the hooks.json shape agy reads", () => {
  const e = ses.antigravityEntry();
  it("tool events hold {matcher, hooks} groups; PreInvocation and Stop hold handlers", () => {
    assert.strictEqual(e.enabled, true);
    assert.strictEqual(e.PostToolUse[0].matcher, "*");
    assert.match(e.PostToolUse[0].hooks[0].command, /sessions ping tool --antigravity$/);
    assert.match(e.PreInvocation[0].command, /sessions ping prompt --antigravity$/);
    assert.match(e.Stop[0].command, /sessions ping stop --antigravity$/);
  });
  it("timeouts are seconds, not milliseconds", () => {
    for (const h of [e.PreInvocation[0], e.Stop[0], e.PostToolUse[0].hooks[0]]) assert.strictEqual(h.timeout, 5);
  });
});

describe("antigravityFacts — the transcript", () => {
  it("titles the session with the first ask and spans its steps", () => {
    const f = path.join(tmp(), "transcript.jsonl");
    fs.writeFileSync(f, [
      { step_index: 0, source: "SYSTEM", type: "SYSTEM_MESSAGE", created_at: "2026-09-24T21:40:00Z", content: "<user_information>…</user_information>" },
      { step_index: 1, source: "USER_EXPLICIT", type: "USER_INPUT", created_at: "2026-09-24T21:40:05Z", content: "<USER_REQUEST>\nnpm install -g github:micmmakarov/spacesheep-cli && spacesheep sessions install\n</USER_REQUEST>" },
      { step_index: 2, source: "MODEL", type: "PLANNER_RESPONSE", created_at: "2026-09-24T21:55:00Z", content: "Done." },
    ].map((j) => JSON.stringify(j)).join("\n") + "\n");
    const facts = ses.antigravityFacts(f);
    assert.strictEqual(facts.title, "npm install -g github:micmmakarov/spacesheep-cli && spacesheep sessions install");
    assert.strictEqual(facts.title_auto, true);
    assert.strictEqual(facts.started_at, Date.parse("2026-09-24T21:40:00Z"));
    assert.strictEqual(facts.last_at, Date.parse("2026-09-24T21:55:00Z"));
  });
  it("an empty or missing transcript gives nothing, not a crash", () => {
    // Only the remote link, which comes from this machine's Antigravity install
    // (when it has one), not from the transcript.
    const { url, ...facts } = ses.antigravityFacts("/nope/transcript.jsonl");
    assert.deepStrictEqual(facts, {});
  });
});

describe("agWorkspace", () => {
  it("takes paths and file:// URLs", () => {
    assert.strictEqual(ses.agWorkspace(["/a/b"]), "/a/b");
    assert.strictEqual(ses.agWorkspace(["file:///a/b%20c"]), "/a/b c");
    assert.strictEqual(ses.agWorkspace([]), null);
    assert.strictEqual(ses.agWorkspace(undefined), null);
  });
});

// --- The per-session Open link -------------------------------------------------------

const INSTALL = "afe9f7be-b9e9-4752-a604-7559963e8245";
const CONV = "cb5f4374-d94b-41d7-a591-6a7c85ed511a";
const PROJ = "fa883f7a-9e26-4d14-b745-aa469ac2fc4f";
const BARE = `https://antigravity.google.com/r/${INSTALL}-v2`;

/** A tmp HOME with ~/.gemini/config/projects/<id>.json per project, an Antigravity
 *  data dir holding the installation id, and one conversation's transcript. */
function agHome(projects) {
  const home = fs.realpathSync(tmp());
  const pdir = path.join(home, ".gemini", "config", "projects");
  fs.mkdirSync(pdir, { recursive: true });
  for (const [id, folders] of Object.entries(projects)) {
    fs.writeFileSync(path.join(pdir, id + ".json"), JSON.stringify({ projectResources: { resources: folders.map((f) => ({ folderUri: f })) } }));
  }
  const data = path.join(home, ".gemini", "antigravity");
  fs.writeFileSync(path.join(fs.mkdirSync(data, { recursive: true }) || data, "antigravity_state.pbtxt"), `installation_uuid: "${INSTALL}"\n`);
  const logs = path.join(data, "brain", CONV, ".system_generated", "logs");
  fs.mkdirSync(logs, { recursive: true });
  const transcript = path.join(logs, "transcript.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ step_index: 0, type: "USER_INPUT", created_at: "2026-09-26T18:00:00Z", content: "<USER_REQUEST>\nhi\n</USER_REQUEST>" }) + "\n");
  return { home, pdir, transcript };
}
const opts = (h, extra) => ({ projectsDir: h.pdir, cacheFile: path.join(h.home, "cache.json"), ...extra });
const uri = (p) => "file://" + p.split("/").map(encodeURIComponent).join("/");

describe("antigravityRemoteUrl — the link that opens one conversation", () => {
  it("builds ?p=c/<conversation>?section=<project> exactly as Antigravity routes it", () => {
    const h = agHome({ [PROJ]: ["file:///Users/yv/git/app"] });
    const url = ses.antigravityRemoteUrl(h.transcript, opts(h, { conversation: CONV, workspaces: ["/Users/yv/git/app"] }));
    assert.strictEqual(url, `${BARE}?p=c%2F${CONV}%3Fsection%3D${PROJ}`);
    assert.strictEqual(url, `${BARE}?p=${encodeURIComponent(`c/${CONV}?section=${PROJ}`)}`);
  });

  it("matches encoded file:// URIs, trailing slashes and subfolders of the project", () => {
    const h = agHome({ [PROJ]: ["file:///Users/yv/git/my%20repo/"] });
    for (const w of ["/Users/yv/git/my repo", "/Users/yv/git/my repo/", "/Users/yv/git/my repo/packages/app", "file:///Users/yv/git/my%20repo"]) {
      assert.strictEqual(ses.agProjectId([w], opts(h)), PROJ, w);
    }
    // A sibling that merely shares the prefix is not inside the project.
    assert.strictEqual(ses.agProjectId(["/Users/yv/git/my repo-2"], opts(h)), null);
  });

  it("the deepest matching folder wins when projects nest", () => {
    const outer = "11111111-1111-1111-1111-111111111111";
    const h = agHome({ [outer]: ["file:///work"], [PROJ]: ["file:///work/app", "file:///elsewhere"] });
    assert.strictEqual(ses.agProjectId(["/work/app/src"], opts(h)), PROJ);
    assert.strictEqual(ses.agProjectId(["/work/lib"], opts(h)), outer);
  });

  it("any folder of a multi-root workspace can place it", () => {
    const h = agHome({ [PROJ]: ["file:///b"] });
    assert.strictEqual(ses.agProjectId(["/a", "/b/c"], opts(h)), PROJ);
  });

  it("follows symlinks on either side", () => {
    const h = agHome({});
    const real = path.join(h.home, "real", "proj");
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(h.home, "link");
    fs.symlinkSync(path.join(h.home, "real"), link);
    // Project names the real folder, the workspace arrives through the link …
    fs.writeFileSync(path.join(h.pdir, PROJ + ".json"), JSON.stringify({ projectResources: { resources: [{ folderUri: uri(real) }] } }));
    assert.strictEqual(ses.agProjectId([path.join(link, "proj")], opts(h)), PROJ);
    // … and the other way round.
    fs.writeFileSync(path.join(h.pdir, PROJ + ".json"), JSON.stringify({ projectResources: { resources: [{ folderUri: uri(path.join(link, "proj")) }] } }));
    assert.strictEqual(ses.agProjectId([real], opts(h)), PROJ);
  });

  it("no matching project, no conversation or no workspace → the bare remote, never a guess", () => {
    const h = agHome({ [PROJ]: ["file:///Users/yv/git/app"] });
    assert.strictEqual(ses.antigravityRemoteUrl(h.transcript, opts(h, { conversation: CONV, workspaces: ["/tmp/other"] })), BARE);
    assert.strictEqual(ses.antigravityRemoteUrl(h.transcript, opts(h, { workspaces: ["/Users/yv/git/app"] })), BARE);
    assert.strictEqual(ses.antigravityRemoteUrl(h.transcript, opts(h, { conversation: CONV })), BARE);
    assert.strictEqual(ses.antigravityRemoteUrl(h.transcript, opts(h, { conversation: "x/../y", workspaces: ["/Users/yv/git/app"] })), BARE);
    assert.strictEqual(ses.antigravityRemoteUrl(h.transcript), BARE);
  });

  it("skips unreadable project files, non-file URIs and ids that are not ids", () => {
    const h = agHome({ [PROJ]: ["vscode-remote://ssh-remote+box/Users/yv/git/app", "relative/path"] });
    fs.writeFileSync(path.join(h.pdir, "broken.json"), "{not json");
    fs.writeFileSync(path.join(h.pdir, "bad id!.json"), JSON.stringify({ projectResources: { resources: [{ folderUri: "file:///Users/yv/git/app" }] } }));
    assert.strictEqual(ses.agProjectId(["/Users/yv/git/app"], opts(h)), null);
    assert.strictEqual(ses.agProjectId(["/Users/yv/git/app"], { projectsDir: path.join(h.home, "missing"), cacheFile: null }), null);
  });

  it("caches per workspace, and a changed project file invalidates the cache", () => {
    const h = agHome({ [PROJ]: ["file:///Users/yv/git/app"] });
    const o = opts(h);
    assert.strictEqual(ses.agProjectId(["/Users/yv/git/app"], o), PROJ);
    const cache = JSON.parse(fs.readFileSync(o.cacheFile, "utf8"));
    assert.strictEqual(cache.hits["/Users/yv/git/app"], PROJ);
    // A cached answer is served without reading the project file again: poison the
    // cache and see it come back (same files, same stat signature). The trailing
    // slash is the same workspace.
    cache.hits["/Users/yv/git/app"] = "from-cache";
    fs.writeFileSync(o.cacheFile, JSON.stringify(cache));
    assert.strictEqual(ses.agProjectId(["/Users/yv/git/app/"], o), "from-cache");
    // Rewriting the project changes its size/mtime, so the cache is rebuilt.
    fs.writeFileSync(path.join(h.pdir, PROJ + ".json"), JSON.stringify({ projectResources: { resources: [{ folderUri: "file:///Users/yv/git/other" }] } }));
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(h.pdir, PROJ + ".json"), later, later);
    assert.strictEqual(ses.agProjectId(["/Users/yv/git/app"], o), null);
    assert.strictEqual(ses.agProjectId(["/Users/yv/git/other"], o), PROJ);
  });

  it("the default paths: ~/.gemini/config/projects under a tmp HOME, end to end through antigravityFacts", () => {
    const h = agHome({ [PROJ]: ["file:///Users/yv/git/app"] });
    const code = `const s = require(${JSON.stringify(path.join(__dirname, "..", "lib", "sessions"))});
      process.stdout.write(JSON.stringify(s.antigravityFacts(${JSON.stringify(h.transcript)}, { conversation: ${JSON.stringify(CONV)}, workspaces: ["/Users/yv/git/app/web"] })));`;
    const r = spawnSync(process.execPath, ["-e", code], { env: { ...process.env, HOME: h.home, USERPROFILE: h.home, SPACESHEEP_CONFIG_DIR: path.join(h.home, "cfg") }, encoding: "utf8" });
    assert.strictEqual(r.status, 0, r.stderr);
    const facts = JSON.parse(r.stdout);
    assert.strictEqual(facts.url, `${BARE}?p=c%2F${CONV}%3Fsection%3D${PROJ}`);
    assert.strictEqual(facts.title, "hi");
    assert.ok(fs.existsSync(path.join(h.home, "cfg", "sessions", "ag-projects.json")), "the lookup is cached under the config dir");
  });
});

describe("agWorkspaces", () => {
  it("decodes every folder, drops non-local ones and duplicates", () => {
    assert.deepStrictEqual(ses.agWorkspaces(["file:///a/b%20c/", "/a/b c", "vscode-remote://x/y", "rel", "/d"]), ["/a/b c", "/d"]);
    assert.deepStrictEqual(ses.agWorkspaces(undefined), []);
  });
});
