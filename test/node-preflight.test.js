"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"), path = require("path"), vm = require("vm");
const source = fs.readFileSync(path.join(__dirname, "../bin/spacesheep.js"), "utf8");

for (const version of ["12.18.4", "18.20.8", "20.0.0", "22.23.2"]) {
  test(`machine on runtime preflight: Node ${version}`, () => {
    const logs = [];
    const exit = new Error("exit"), loaded = new Error("loaded modules");
    const supported = Number(version.split(".")[0]) >= 20;
    assert.throws(() => vm.runInNewContext(`(function () { ${source.replace(/^#!.*\n/, "")} })()`, {
      process: { argv: ["/usr/local/bin/node", "spacesheep", "machine", "on"],
        versions: { node: version }, version: "v" + version, execPath: "/usr/local/bin/node",
        exit: (code) => { assert.equal(code, 1); throw exit; } },
      console: { error: (s) => logs.push(s) },
      require: () => { throw loaded; },
    }), (e) => e === (supported ? loaded : exit));
    if (supported) assert.deepEqual(logs, []);
    else {
      assert.match(logs[0], /requires Node >= 20/);
      assert.ok(logs[0].includes("v" + version));
      assert.ok(logs[0].includes("/usr/local/bin/node"));
      assert.match(logs[1], /\/usr\/local\/opt\/node\/bin.*npx -y spacesheep@latest machine on/);
    }
  });
}
