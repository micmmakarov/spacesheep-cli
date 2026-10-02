"use strict";
const test = require("node:test");
const assert = require("node:assert");
const os = require("os");
const { createSampler } = require("../lib/system");
const { createLoadTest } = require("../lib/loadtest");

test("--system reads every core, memory and a temperature per core, on this OS", async () => {
  const sample = createSampler({ host: "box" });
  await new Promise((r) => setTimeout(r, 120));
  const v = sample({ test: null });
  assert.equal(v.host, "box");
  assert.equal(v.cpus, os.cpus().length);
  assert.equal(v.cpu.length, v.cpus);
  assert.equal(v.temp_c.length, v.cpus);
  assert.ok(["model", "sensor"].includes(v.temp_source));
  assert.ok(v.mem.total_mb > 0 && v.mem.used_mb >= 0);
  assert.equal(v.load.length, 3);
  assert.ok(JSON.stringify(v).length < 16384, "a reading fits a stream value");
});

test("--load-test clamps whatever a page sends, and stop ends it", () => {
  const lt = createLoadTest();
  const r = lt.press("run", { intensity: "$(rm -rf /)", seconds: -4 });
  assert.equal(r.status, "started");
  assert.match(r.note, /100% for 5s/);
  assert.equal(lt.state().intensity, 100);
  assert.match(lt.press("run", { intensity: 250, seconds: 9999 }).note, /100% for 120s/);
  assert.match(lt.press("run", { intensity: 1 }).note, /5% for 30s/);
  assert.equal(lt.press("stop").status, "done");
  assert.equal(lt.state(), null);
  assert.equal(lt.press("rm").status, "refused");
});
