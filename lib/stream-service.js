// `spacesheep stream <name> … --service`: keep this stream running in the background —
// a systemd user unit on Linux, a launchd agent on macOS — restarted if it stops and
// started again at boot. `--remove-service` takes it away.
//
// The service runs an INSTALLED copy of this CLI (an npx cache path can vanish), so a
// run from npx installs this version globally first, the way `machine on` does.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");
const cfg = require("./config");

const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8" }); return { ok: r.status === 0, out: r.stdout || "", err: r.stderr || "" }; };
const slug = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "stream";
const xml = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const sdQuote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%").replace(/\$/g, "$$$$")}"`;

/** The argv the service runs: this command line minus --service, on an installed copy. */
function serviceArgv(log) {
  const args = process.argv.slice(2).filter((a) => a !== "--service");
  const mem = require("./memory");
  if (mem.binPath().viaNpx) {
    const pkg = require("../package.json");
    const target = require("./prefix").pathPrefix();
    log(`  Installing ${pkg.name}@${pkg.version} so the stream can run in the background…`);
    try { execFileSync("npm", ["install", "-g", `${pkg.name}@${pkg.version}`, ...(target ? ["--prefix", target] : [])], { stdio: ["ignore", "ignore", "inherit"] }); }
    catch { throw new Error("couldn't install it (`npm install -g spacesheep` failed) — run that yourself, with sudo if your npm needs it, then run this again"); }
    let prefix = target || "";
    if (!prefix) try { prefix = execFileSync("npm", ["prefix", "-g"], { encoding: "utf8" }).trim(); } catch {}
    const script = fs.realpathSync(path.join(prefix, "lib", "node_modules", "spacesheep", "bin", "spacesheep.js"));
    return [process.execPath, script, ...args];
  }
  return mem.hookArgv(args);
}

function envFor() {
  const dirs = [path.dirname(process.execPath), ...String(process.env.PATH || "").split(path.delimiter).filter((d) => d && path.isAbsolute(d)), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  const env = { PATH: [...new Set(dirs)].join(path.delimiter), HOME: os.homedir() };
  for (const k of ["SPACESHEEP_APP_ORIGIN", "SPACESHEEP_CONFIG_DIR", "SPACESHEEP_ORIGIN"]) if (process.env[k]) env[k] = process.env[k];
  return env;
}

function install(opts, log) {
  const name = String(opts._[0] || "");
  if (!name) throw new Error("usage: spacesheep stream <name> --system --load-test --service");
  if (!cfg.readConfig().key) throw new Error("the background service uses the key saved in " + cfg.configPath() + " — save one first (`spacesheep keys save`, `spacesheep connect <key> --scope stream` or `spacesheep login`); SPACESHEEP_KEY from this shell isn't passed to it");
  const id = slug(name), argv = serviceArgv(log), env = envFor();
  const logFile = path.join(cfg.configDir(), `stream-${id}.log`);
  fs.mkdirSync(cfg.configDir(), { recursive: true, mode: 0o700 });
  if (process.platform === "darwin") {
    const label = `dev.spacesheep.stream.${id}`, p = path.join(os.homedir(), "Library", "LaunchAgents", label + ".plist");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>${argv.map((a) => `<string>${xml(a)}</string>`).join("")}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${xml(k)}</key><string>${xml(v)}</string>`).join("")}</dict>
</dict></plist>
`);
    const uid = process.getuid();
    sh("launchctl", ["bootout", `gui/${uid}/${label}`]);
    if (!sh("launchctl", ["bootstrap", `gui/${uid}`, p]).ok && !sh("launchctl", ["load", "-w", p]).ok) throw new Error(`launchctl wouldn't load ${p}`);
    log(`  ✓ ${name} streams in the background (launchd ${label}); log: ${logFile}`);
    return;
  }
  if (process.platform === "linux" && sh("sh", ["-c", "command -v systemctl"]).ok) {
    const unit = `spacesheep-stream-${id}.service`;
    const body = `[Unit]
Description=spacesheep stream ${name}
After=network-online.target

[Service]
ExecStart=${argv.map(sdQuote).join(" ")}
Restart=always
RestartSec=3
${Object.entries(env).map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`)}`).join("\n")}
StandardOutput=append:${logFile.replace(/%/g, "%%")}
StandardError=append:${logFile.replace(/%/g, "%%")}

[Install]
WantedBy=default.target
`;
    const p = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user", unit);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    sh("systemctl", ["--user", "daemon-reload"]);
    const en = sh("systemctl", ["--user", "enable", "--now", unit]);
    if (!en.ok) throw new Error(`systemctl --user couldn't start it (${(en.err || "").trim().split("\n")[0].slice(0, 160)}). On a server with no login session, run \`sudo loginctl enable-linger ${os.userInfo().username}\` and try again.`);
    // Without lingering, a user service stops when the last session closes (an ssh logout).
    const linger = sh("loginctl", ["enable-linger", os.userInfo().username]).ok;
    log(`  ✓ ${name} streams in the background (systemd --user ${unit}); log: ${logFile}`);
    if (!linger) log(`  ! To keep it running after you log out: sudo loginctl enable-linger ${os.userInfo().username}`);
    return;
  }
  throw new Error("no service manager this CLI knows here (systemd or launchd) — run the same command without --service under your own supervisor");
}

function remove(opts, log) {
  const id = slug(String(opts._[0] || ""));
  if (process.platform === "darwin") {
    const label = `dev.spacesheep.stream.${id}`, p = path.join(os.homedir(), "Library", "LaunchAgents", label + ".plist");
    sh("launchctl", ["bootout", `gui/${process.getuid()}/${label}`]);
    try { fs.unlinkSync(p); } catch {}
  } else {
    const unit = `spacesheep-stream-${id}.service`;
    sh("systemctl", ["--user", "disable", "--now", unit]);
    try { fs.unlinkSync(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "systemd", "user", unit)); } catch {}
    sh("systemctl", ["--user", "daemon-reload"]);
  }
  log(`  ✓ background stream ${opts._[0]} removed`);
}

module.exports = { install, remove, slug };
