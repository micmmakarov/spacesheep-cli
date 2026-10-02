"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path");
const { execFileSync } = require("child_process");

const repo = path.resolve(__dirname, "..");
const foreign = { hooks: [{ type: "command", command: "other-tool sync" }] };
const sessionpipe = { hooks: [{ type: "command", command: "sessionpipe hook" }] };
const old = (command) => ({ hooks: [{ type: "command", command }] });

for (const mode of ["machine", "uninstall"]) {
  test(`${mode}: removes memory hooks from every Claude config and preserves other settings`, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "ss-cleanup-"));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const dirs = [".claude", ".claude-yv2", "env-account", "explicit-account"];
    for (const d of dirs) {
      fs.mkdirSync(path.join(home, d));
      fs.writeFileSync(path.join(home, d, "settings.json"), JSON.stringify({
        permissions: { allow: ["Bash(echo *)"] },
        hooks: Object.fromEntries(["Stop", "SessionEnd"].map((ev) => [ev, [
          foreign, sessionpipe, old('"/usr/local/bin/node" "/old/spacesheep.js" memory sync'),
          old("spacesheep memory sync"),
          ...(mode === "machine" ? [old(`spacesheep sessions ping ${ev === "Stop" ? "stop" : "end"}`)] : []),
        ]])),
      }));
    }
    const script = `
      const assert = require("node:assert/strict");
      const fs = require("fs"), path = require("path");
      const home = process.env.HOME;
      const opts = { claude: true, configDir: [path.join(home, "explicit-account")] };
      const logs = [];
      const log = (s) => logs.push(s);
      const migrate = () => require("./lib/sessionpipe").moveTo("machine", opts, log, {
        run: () => {}, machine: { readMachine: () => null },
      });
      (async () => {
        for (let i = 0; i < 2; i++) {
          if (${JSON.stringify(mode)} === "machine") await migrate();
          else require("./lib/memory").uninstall(opts, log);
          for (const d of ${JSON.stringify(dirs)}) {
            const settings = JSON.parse(fs.readFileSync(path.join(home, d, "settings.json")));
            assert.deepEqual(settings.permissions, { allow: ["Bash(echo *)"] });
            for (const ev of ["Stop", "SessionEnd"]) {
              assert.deepEqual(settings.hooks[ev], ${JSON.stringify([foreign, sessionpipe])}, d + ": " + ev);
            }
          }
        }
        for (const d of ${JSON.stringify(dirs)}) {
          assert.ok(logs.some((s) => s.includes(d) && /memory hooks removed/.test(s)), "cleanup log for " + d);
        }
      })().catch((e) => { console.error(e); process.exitCode = 1; });
    `;
    execFileSync(process.execPath, ["-e", script], {
      cwd: repo,
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"),
        SPACESHEEP_CONFIG_DIR: path.join(home, ".config", "spacesheep"), SPACESHEEP_KEY: "",
        CLAUDE_CONFIG_DIR: path.join(home, "env-account"), CODEX_HOME: path.join(home, ".codex") },
      encoding: "utf8", stdio: "pipe",
    });
  });
}

test("machine on repairs an already migrated account with only leftover memory hooks", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ss-repair-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, ".claude-yv2");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ hooks: {
    Stop: [old("spacesheep memory sync"), sessionpipe],
    SessionEnd: [old("spacesheep memory sync"), sessionpipe],
  } }));
  execFileSync(process.execPath, ["-e", `
    require("./lib/sessionpipe").moveTo("machine", {}, () => {}, {
      run: () => {}, machine: { readMachine: () => null },
    }).catch((e) => { console.error(e); process.exitCode = 1; });
  `], { cwd: repo, env: { ...process.env, HOME: home, USERPROFILE: home,
    SPACESHEEP_CONFIG_DIR: path.join(home, ".config"), SPACESHEEP_KEY: "", CLAUDE_CONFIG_DIR: "",
    CODEX_HOME: path.join(home, ".codex") }, stdio: "pipe" });
  const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json")));
  assert.deepEqual(settings.hooks, { Stop: [sessionpipe], SessionEnd: [sessionpipe] });
});
