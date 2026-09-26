// Codex turn sync's one config line (lib/codex-config.js, lib/memory.js installCodex).
// @yaroslavvb's report, 2026-09-26: the installer appended notify to the end of
// ~/.codex/config.toml, which ends in a [projects."…"] table, so Codex never read it,
// and status called it installed for 41 hours with 0 turns synced.
"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), "ss-codex-"));
process.env.HOME = HOME;
process.env.CODEX_HOME = path.join(HOME, ".codex");
process.env.SPACESHEEP_CONFIG_DIR = path.join(HOME, "cfg");
const cc = require("../lib/codex-config");
const mem = require("../lib/memory");
const prefix = require("../lib/prefix");

const CONFIG = path.join(HOME, ".codex", "config.toml");
fs.mkdirSync(path.dirname(CONFIG), { recursive: true });
// The hooks run bin/spacesheep.js; under the test runner argv[1] is this file, so
// stand one in where a global install would put it.
const SCRIPT = path.join(HOME, "prefix", "lib", "node_modules", "spacesheep", "bin", "spacesheep.js");
fs.mkdirSync(path.dirname(SCRIPT), { recursive: true });
fs.writeFileSync(SCRIPT, "");
process.argv[1] = SCRIPT;

// The shape of a real config: top-level keys, then tables Codex added itself.
const INTEL = `model = "gpt-5-codex"
approval_policy = "on-request"

[marketplaces.openai-bundled]
source = "bundled"

[projects."/Users/yaroslavvb/git/sutro"]
trust_level = "trusted"
`;
const OLD_OURS = `notify = ["/usr/local/Cellar/node/25.2.1/bin/node","/x/lib/node_modules/spacesheep/bin/spacesheep.js","memory","sync","--source","codex"]`;
const SKY = `notify = ["/Applications/Codex.app/Contents/Resources/SkyComputerUseClient","turn-ended"]`;
const OTHER = `notify = ["/opt/tools/notifier","done"]`;
const silent = () => {};

describe("firstTableAt", () => {
  it("finds the first [table] or [[array of tables]]", () => {
    assert.strictEqual(cc.firstTableAt(INTEL), INTEL.indexOf("[marketplaces"));
    assert.strictEqual(cc.firstTableAt(`a = 1\n[[bin]]\nname = "x"\n`), 6);
    assert.strictEqual(cc.firstTableAt(`a = 1\nb = "x"\n`), -1);
    assert.strictEqual(cc.firstTableAt(`[only]\na = 1\n`), 0);
  });
  it("is not fooled by a multi-line array or string whose lines start with [", () => {
    const arr = `matrix = [\n  [1, 2],\n  [3, 4],\n]\n[tbl]\nx = 1\n`;
    assert.strictEqual(cc.firstTableAt(arr), arr.indexOf("[tbl]"));
    const str = `note = """\n[not a table]\n"""\n[real]\n`;
    assert.strictEqual(cc.firstTableAt(str), str.indexOf("[real]"));
    const lit = `q = "]"\nr = '['\n[t]\n`;
    assert.strictEqual(cc.firstTableAt(lit), lit.indexOf("[t]"));
  });
});

describe("readNotify and withNotify", () => {
  const LINE = `notify = ["/n","/s/spacesheep.js","memory","sync","--source","codex"]`;
  it("calls a line of ours inside a table misplaced, and moves it to the top level", () => {
    const text = INTEL + OLD_OURS + "\n";
    assert.strictEqual(cc.readNotify(text).misplaced, true);
    const fixed = cc.withNotify(text, LINE);
    assert.ok(fixed.indexOf(LINE) < fixed.indexOf("[marketplaces"), fixed);
    assert.ok(!fixed.includes("Cellar"), "the stranded line is gone");
    const n = cc.readNotify(fixed);
    assert.strictEqual(n.misplaced, false);
    assert.strictEqual(n.other, false);
    assert.ok(fixed.endsWith('trust_level = "trusted"\n'), "the tables are untouched");
  });
  it("ignores another tool's line inside a table, and names another tool's top-level one", () => {
    assert.strictEqual(cc.readNotify(INTEL + SKY + "\n"), null);
    assert.strictEqual(cc.readNotify(SKY + "\n" + INTEL).other, true);
    const multi = `notify = [\n  "/opt/x",\n  "done",\n]\n` + INTEL;
    const n = cc.readNotify(multi);
    assert.strictEqual(n.other, true);
    assert.strictEqual(n.argv, null);
  });
  it("adds at the top level, or at the end of a file with no tables, and rewrites ours in place", () => {
    assert.ok(cc.withNotify(INTEL, LINE).startsWith(`model = "gpt-5-codex"\napproval_policy = "on-request"\n${LINE}\n\n[marketplaces`));
    assert.strictEqual(cc.withNotify(`a = 1\n`, LINE), `a = 1\n${LINE}\n`);
    assert.strictEqual(cc.withNotify("", LINE), `${LINE}\n`);
    assert.strictEqual(cc.withNotify(`[t]\nx = 1\n`, LINE), `${LINE}\n\n[t]\nx = 1\n`);
    const top = `a = 1\n${OLD_OURS}\nb = 2\n[t]\n`;
    assert.strictEqual(cc.withNotify(top, LINE), `a = 1\n${LINE}\nb = 2\n[t]\n`);
  });
});

describe("installCodex on a real config.toml", () => {
  const read = () => fs.readFileSync(CONFIG, "utf8");
  const ours = () => `notify = ${JSON.stringify(mem.hookArgv(["memory", "sync", "--source", "codex"]))}`;

  it("adds the line above the first table, and a second run changes nothing", () => {
    fs.writeFileSync(CONFIG, INTEL);
    assert.strictEqual(mem.installCodex("spacesheep", silent), "added");
    assert.ok(read().indexOf(ours()) < read().indexOf("[marketplaces"));
    assert.strictEqual(mem.codexWired().via, "direct");
    assert.strictEqual(mem.installCodex("spacesheep", silent), "current");
  });
  it("moves a line stranded inside a table, the 1.9.1 install", () => {
    fs.writeFileSync(CONFIG, INTEL + OLD_OURS + "\n");
    assert.strictEqual(mem.codexWired().via, "misplaced");
    assert.strictEqual(mem.installCodex("spacesheep", silent), "moved");
    assert.strictEqual(mem.codexWired().via, "direct");
    assert.ok(!read().includes("Cellar"));
  });
  it("rewrites a top-level line of ours that runs an old node or script", () => {
    fs.writeFileSync(CONFIG, OLD_OURS + "\n" + INTEL);
    assert.strictEqual(mem.installCodex("spacesheep", silent), "refreshed");
    assert.ok(read().startsWith(ours() + "\n"));
  });
  it("leaves another tool's notify alone and says Codex was skipped", () => {
    fs.writeFileSync(CONFIG, SKY + "\n" + INTEL);
    const lines = [];
    assert.strictEqual(mem.installCodex("spacesheep", (l) => lines.push(l)), "other");
    assert.strictEqual(read(), SKY + "\n" + INTEL);
    assert.ok(lines.some((l) => /skipped/.test(l) && /--codex-chain/.test(lines.join("\n"))));
    assert.strictEqual(mem.codexWired().via, "other");
  });
  it("with --codex-chain, runs both through a script, and uninstall puts the original back", () => {
    fs.writeFileSync(CONFIG, OTHER + "\n" + INTEL);
    assert.strictEqual(mem.installCodex("spacesheep", silent, { codexChain: true }), "chained");
    const wrapper = path.join(HOME, "cfg", "bin", "codex-notify");
    assert.ok(read().startsWith(`notify = ${JSON.stringify([wrapper])}\n`));
    assert.ok((fs.statSync(wrapper).mode & 0o111) !== 0, "the script is executable");
    const st = mem.codexWired();
    assert.strictEqual(st.via, "wrapper");
    assert.deepStrictEqual(st.chain, ["/opt/tools/notifier", "done"]);
    assert.strictEqual(mem.installCodex("spacesheep", silent, { codexChain: true }), "wrapper");
    mem.uninstallCodex(silent);
    assert.strictEqual(read(), OTHER + "\n" + INTEL);
    assert.ok(!fs.existsSync(wrapper));
  });
  it("chains onto Codex Computer Use with its own --previous-notify, no script", () => {
    fs.writeFileSync(CONFIG, SKY + "\n" + INTEL);
    assert.strictEqual(mem.installCodex("spacesheep", silent, { codexChain: true }), "chained");
    const st = mem.codexWired();
    assert.strictEqual(st.via, "previous");
    assert.deepStrictEqual(st.prev, mem.hookArgv(["memory", "sync", "--source", "codex"]));
    assert.ok(!fs.existsSync(path.join(HOME, "cfg", "bin", "codex-notify")), "no wrapper for a client that chains itself");
    assert.strictEqual(mem.installCodex("spacesheep", silent), "current");
    mem.uninstallCodex(silent);
    assert.strictEqual(read(), SKY + "\n" + INTEL);
  });
  it("reads a Computer Use chain to a script that runs us as installed, and --codex-chain drops the script", () => {
    const dir = fs.mkdtempSync(path.join(HOME, "old-"));
    const old = path.join(dir, "codex-notify");
    fs.writeFileSync(old, `#!/bin/sh\n/usr/bin/spacesheep memory sync --source codex "$@"\nexec /x/SkyComputerUseClient turn-ended "$@"\n`, { mode: 0o755 });
    const sky = ["/Applications/Codex.app/Contents/Resources/SkyComputerUseClient", "turn-ended", "--previous-notify", JSON.stringify([old])];
    fs.writeFileSync(CONFIG, `notify = ${JSON.stringify(sky)}\n` + INTEL);
    const st = mem.codexWired();
    assert.strictEqual(st.via, "previous-wrapper");
    assert.strictEqual(st.wired, true);
    assert.strictEqual(mem.installCodex("spacesheep", silent), "wrapper");
    assert.strictEqual(mem.installCodex("spacesheep", silent, { codexChain: true }), "chained");
    assert.strictEqual(mem.codexWired().via, "previous");
  });
  it("uninstall removes our line, stranded or not", () => {
    fs.writeFileSync(CONFIG, INTEL + OLD_OURS + "\n");
    mem.uninstallCodex(silent);
    assert.strictEqual(read(), INTEL);
  });
});

describe("the chain script, run", () => {
  it("passes Codex's argument to both commands and keeps the original's exit status", () => {
    const dir = fs.mkdtempSync(path.join(HOME, "chain-"));
    const rec = path.join(dir, "rec.sh");
    fs.writeFileSync(rec, `#!/bin/sh\necho "$0 $*" >> "${dir}/log"\n`, { mode: 0o755 });
    const orig = path.join(dir, "orig.sh");
    fs.writeFileSync(orig, `#!/bin/sh\necho "orig $*" >> "${dir}/log"\nexit 3\n`, { mode: 0o755 });
    const script = path.join(dir, "codex-notify");
    fs.writeFileSync(script, cc.chainScript([orig, "turn-ended"], ["/bin/sh", rec, "memory", "sync", "--source", "codex"]), { mode: 0o755 });
    let status = 0;
    try { execFileSync(script, ['{"type":"agent-turn-complete"}']); } catch (e) { status = e.status; }
    assert.strictEqual(status, 3);
    for (let i = 0; i < 50 && (fs.readFileSync(path.join(dir, "log"), "utf8").split("\n").filter(Boolean).length < 2); i++) execFileSync("sleep", ["0.05"]);
    const log = fs.readFileSync(path.join(dir, "log"), "utf8");
    assert.match(log, /orig turn-ended \{"type":"agent-turn-complete"\}/);
    assert.match(log, /rec\.sh memory sync --source codex \{"type":"agent-turn-complete"\}/);
    assert.deepStrictEqual(cc.chainOriginal(fs.readFileSync(script, "utf8")), [orig, "turn-ended"]);
  });
});

describe("prefix", () => {
  it("reads the npm prefix a global copy lives under, and nothing for npx", () => {
    if (process.platform === "win32") return;
    assert.strictEqual(prefix.prefixOf("/Users/y/.local/lib/node_modules/spacesheep/bin/spacesheep.js"), "/Users/y/.local");
    assert.strictEqual(prefix.prefixOf("/usr/local/Cellar/node/25.2.1/lib/node_modules/spacesheep/bin/spacesheep.js"), "/usr/local/Cellar/node/25.2.1");
    assert.strictEqual(prefix.prefixOf("/Users/y/.npm/_npx/ab12/node_modules/spacesheep/bin/spacesheep.js"), null);
    assert.strictEqual(prefix.prefixOf("/Users/y/src/spacesheep-cli/bin/spacesheep.js"), null);
  });
  it("knows Homebrew's versioned node folder from its stable links", () => {
    assert.strictEqual(prefix.inVersionedCellar("/usr/local/Cellar/node/25.2.1/lib/node_modules/spacesheep/bin/spacesheep.js"), true);
    assert.strictEqual(prefix.inVersionedCellar("/opt/homebrew/Cellar/node@22/22.9.0/lib/node_modules/spacesheep/x.js"), true);
    assert.strictEqual(prefix.inVersionedCellar("/usr/local/opt/node/bin/node"), false);
    assert.strictEqual(prefix.inVersionedCellar("/Users/y/.local/lib/node_modules/spacesheep/bin/spacesheep.js"), false);
  });
});
