// `spacesheep stream <name> --system`: this machine's own numbers, read in-process.
//
// One reading per tick, the same shape on every OS so a page can draw any machine:
//   { host, cpus, model, t, load: [1m, 5m, 15m], cpu: [busy % per core],
//     split: {user, system, iowait, steal, idle}, mem: {total_mb, used_mb, cached_mb,
//     avail_mb, swap_used_mb}, psi, disk, net, temp_c: [per core], temp_source,
//     test, buttons }
// Per-core load and memory come from Node's `os` (Linux, macOS, Windows). On Linux the
// kernel's own counters add the CPU split, pressure stalls (PSI), disk and network.
// Temperatures are the machine's sensors when it has them (Linux hwmon / thermal
// zones); otherwise — a cloud VM, a Mac — a small thermal model of each core's load,
// marked temp_source "model" so a page can say so.
"use strict";
const fs = require("fs");
const os = require("os");

const r1 = (x) => Math.round(x * 10) / 10;
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const LINUX = process.platform === "linux";

// --- per-core busy from os.cpus() ---
function cpuTimes() {
  return os.cpus().map((c) => {
    const t = c.times, total = t.user + t.nice + t.sys + t.idle + t.irq;
    return { total, idle: t.idle };
  });
}

// --- Linux extras ---
function procStat() {
  const txt = read("/proc/stat");
  if (!txt) return null;
  const line = txt.split("\n").find((l) => l.startsWith("cpu "));
  if (!line) return null;
  const v = line.trim().split(/\s+/).slice(1, 9).map(Number);
  while (v.length < 8) v.push(0);
  return { user: v[0] + v[1], system: v[2] + v[5] + v[6], idle: v[3], iowait: v[4], steal: v[7], total: v.reduce((a, b) => a + b, 0) };
}
function memory() {
  const m = {};
  if (LINUX) for (const line of (read("/proc/meminfo") || "").split("\n")) { const x = line.match(/^(\w+):\s+(\d+)/); if (x) m[x[1]] = Number(x[2]); }
  const mb = (kb) => Math.round(kb / 1024);
  if (m.MemTotal) {
    const cached = (m.Cached || 0) + (m.Buffers || 0) + (m.SReclaimable || 0);
    return { total_mb: mb(m.MemTotal), used_mb: mb(Math.max(0, m.MemTotal - (m.MemFree || 0) - cached)), cached_mb: mb(cached),
      avail_mb: mb(m.MemAvailable || 0), swap_used_mb: mb((m.SwapTotal || 0) - (m.SwapFree || 0)) };
  }
  const total = os.totalmem(), free = os.freemem();
  return { total_mb: Math.round(total / 1048576), used_mb: Math.round((total - free) / 1048576), cached_mb: 0, avail_mb: Math.round(free / 1048576), swap_used_mb: 0 };
}
function psi() {
  const avg = (res, kind) => {
    const txt = read("/proc/pressure/" + res); if (txt === null) return null;
    const line = txt.split("\n").find((l) => l.startsWith(kind + " "));
    const x = line && line.match(/avg10=([\d.]+)/);
    return x ? Number(x[1]) : null;
  };
  if (!LINUX) return null;
  return { cpu_some: avg("cpu", "some"), mem_some: avg("memory", "some"), mem_full: avg("memory", "full"), io_some: avg("io", "some") };
}
function diskBytes() {
  if (!LINUX) return null;
  let names = []; try { names = fs.readdirSync("/sys/block"); } catch {}
  const real = new Set(names.filter((n) => !/^(loop|ram|zram|dm-|md|sr|fd)/.test(n)));
  let rd = 0, wr = 0;
  for (const line of (read("/proc/diskstats") || "").split("\n")) {
    const f = line.trim().split(/\s+/);
    if (f.length < 10 || !real.has(f[2])) continue;
    rd += Number(f[5]) * 512; wr += Number(f[9]) * 512;
  }
  return { rd, wr };
}
function netBytes() {
  if (!LINUX) return null;
  let rx = 0, tx = 0;
  for (const line of (read("/proc/net/dev") || "").split("\n")) {
    const i = line.indexOf(":"); if (i < 0) continue;
    if (line.slice(0, i).trim() === "lo") continue;
    const f = line.slice(i + 1).trim().split(/\s+/).map(Number);
    rx += f[0]; tx += f[8];
  }
  return { rx, tx };
}
function findSensors() {
  if (!LINUX) return [];
  const out = [];
  try {
    for (const h of fs.readdirSync("/sys/class/hwmon")) {
      const dir = "/sys/class/hwmon/" + h, name = (read(dir + "/name") || "").trim();
      if (!/^(coretemp|k10temp|zenpower)$/.test(name)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => /^temp\d+_input$/.test(x)).sort((a, b) => parseInt(a.slice(4)) - parseInt(b.slice(4)))) {
        const label = (read(dir + "/" + f.replace("_input", "_label")) || "").trim();
        if (name === "coretemp" && !/^Core/.test(label)) continue;
        out.push(dir + "/" + f);
      }
    }
  } catch {}
  return out;
}

// --- the thermal model: first-order RC per core, coupled to its ring neighbours ---
const T_AMB = 38, TAU_S = 6, K = 0.5, COUPLE = 0.08;
function thermalModel() {
  let temps = null;
  return (busy, dt) => {
    const n = busy.length;
    if (!temps || temps.length !== n) temps = busy.map((b) => T_AMB + K * b);
    const a = 1 - Math.exp(-dt / TAU_S), c = 1 - Math.exp(-COUPLE * dt);
    const heated = temps.map((T, i) => T + a * (T_AMB + K * busy[i] - T));
    temps = heated.map((T, i) => (n < 2 ? T : T + c * ((heated[(i - 1 + n) % n] + heated[(i + 1) % n]) / 2 - T)));
    return temps.map(r1);
  };
}

/** A sampler: call it every tick; each call returns one reading (the first call primes). */
function createSampler(opts = {}) {
  const host = opts.host || os.hostname().split(".")[0];
  const sensors = findSensors();
  const model = thermalModel();
  const cpuModel = ((os.cpus()[0] || {}).model || "").trim() || null;
  let prev = { at: process.hrtime.bigint(), cores: cpuTimes(), stat: procStat(), disk: diskBytes(), net: netBytes() };
  return function sample(extra = {}) {
    const cur = { at: process.hrtime.bigint(), cores: cpuTimes(), stat: procStat(), disk: diskBytes(), net: netBytes() };
    const dt = Math.max(0.05, Number(cur.at - prev.at) / 1e9);
    const busy = cur.cores.map((c, i) => {
      const p = prev.cores[i]; if (!p) return 0;
      const tot = c.total - p.total, idle = c.idle - p.idle;
      return tot > 0 ? Math.min(100, Math.max(0, r1(100 * (tot - idle) / tot))) : 0;
    });
    let split = null;
    if (cur.stat && prev.stat) {
      const A = cur.stat, B = prev.stat, d = A.total - B.total, pct = (x) => (d > 0 ? r1(100 * x / d) : 0);
      split = { user: pct(A.user - B.user), system: pct(A.system - B.system), iowait: pct(A.iowait - B.iowait), steal: pct(A.steal - B.steal), idle: pct(A.idle - B.idle) };
    } else {
      const avg = busy.length ? busy.reduce((a, b) => a + b, 0) / busy.length : 0;
      split = { user: r1(avg), system: 0, iowait: 0, steal: 0, idle: r1(100 - avg) };
    }
    const real = sensors.map((p) => { const v = Number(read(p)); return Number.isFinite(v) ? r1(v / 1000) : null; });
    const useReal = real.length > 0 && real.every((x) => x !== null);
    const modelled = model(busy, dt);
    const out = {
      host, cpus: busy.length, model: cpuModel, t: Date.now(),
      load: os.loadavg().map((x) => Math.round(x * 100) / 100),
      cpu: busy, split, mem: memory(), psi: psi(),
      disk: cur.disk && prev.disk ? { read_kbs: r1((cur.disk.rd - prev.disk.rd) / 1024 / dt), write_kbs: r1((cur.disk.wr - prev.disk.wr) / 1024 / dt) } : null,
      net: cur.net && prev.net ? { rx_kbs: r1((cur.net.rx - prev.net.rx) / 1024 / dt), tx_kbs: r1((cur.net.tx - prev.net.tx) / 1024 / dt) } : null,
      temp_c: useReal ? real : modelled, temp_source: useReal ? "sensor" : "model",
      ...extra,
    };
    prev = cur;
    return out;
  };
}

module.exports = { createSampler, thermalModel };
