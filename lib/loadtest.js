// `spacesheep stream <name> --load-test`: buttons a page can press to load this
// machine, built in, so nothing has to be installed (no stress-ng, no scripts).
//
//   run      every core busy `intensity`% of the time for `seconds` (the page's slider)
//   cpu_one  one core flat out
//   memory   hold and keep touching a slice of RAM
//   stop     end whatever is running
//
// The press's data comes from anyone who can open the page, so every number is
// clamped here; nothing from it reaches a shell. One test at a time, and every test
// ends by itself.
"use strict";
const os = require("os");
const { Worker } = require("worker_threads");

const BUTTONS = ["run", "cpu_one", "memory", "stop"];

// A worker that is busy `duty` of every 100 ms slice, or one that holds `mb` of memory
// and writes a byte into every page of it, over and over.
const SPIN = `
const { workerData } = require("worker_threads");
if (workerData.mb) {
  const bufs = [];
  for (let left = workerData.mb; left > 0; left -= 64) bufs.push(Buffer.alloc(Math.min(64, left) * 1048576));
  let n = 0;
  (function touch() { for (const b of bufs) for (let i = 0; i < b.length; i += 4096) b[i] = n & 255; n++; setTimeout(touch, 0); })();
} else {
  const duty = workerData.duty, SLICE = 100;
  (function spin() {
    const t0 = Date.now(); let x = 0;
    while (Date.now() - t0 < SLICE * duty) x += Math.sqrt(x + 1);
    setTimeout(spin, Math.max(0, SLICE * (1 - duty)));
  })();
}`;

const clamp = (v, lo, hi, dflt) => { const n = Math.floor(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

function createLoadTest() {
  let workers = [], current = null, timer = null;
  function stop() {
    clearTimeout(timer); timer = null;
    for (const w of workers) w.terminate().catch(() => {});
    workers = []; current = null;
  }
  function start(name, n, workerData, seconds, extra) {
    stop();
    for (let i = 0; i < n; i++) {
      const w = new Worker(SPIN, { eval: true, workerData });
      w.on("error", () => {});
      w.unref();
      workers.push(w);
    }
    const now = Date.now();
    current = { name, started: now, ends: now + seconds * 1000, ...extra };
    timer = setTimeout(stop, seconds * 1000);
    if (timer.unref) timer.unref();
    return current;
  }
  return {
    buttons: BUTTONS,
    has: (name) => BUTTONS.includes(name),
    /** The test running now (for the readings), or null. */
    state: () => (current && current.ends > Date.now() ? current : null),
    /** Run a press. Returns { status, note } for the page. */
    press(name, data) {
      const d = data && typeof data === "object" ? data : {};
      const seconds = clamp(d.seconds, 5, 120, 30);
      if (name === "stop") { const was = current && current.name; stop(); return { status: "done", note: was ? `stopped ${was}` : "nothing was running" }; }
      if (name === "run") {
        const intensity = clamp(d.intensity, 5, 100, 100);
        start("run", os.cpus().length, { duty: intensity / 100 }, seconds, { intensity });
        return { status: "started", note: `every core at ${intensity}% for ${seconds}s` };
      }
      if (name === "cpu_one") { start("cpu_one", 1, { duty: 1 }, seconds); return { status: "started", note: `one core flat out for ${seconds}s` }; }
      if (name === "memory") {
        // Half the machine, never more than 80% of what is free right now.
        const mb = Math.max(64, Math.floor(Math.min(os.totalmem() * 0.5, os.freemem() * 0.8) / 1048576));
        start("memory", 1, { mb }, seconds, { mb });
        return { status: "started", note: `holding ${mb} MB for ${seconds}s` };
      }
      return { status: "refused", note: `no built-in button "${name}"` };
    },
    stop,
  };
}

module.exports = { createLoadTest, BUTTONS };
