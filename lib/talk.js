// `spacesheep talk …` — the owner can message a coding session from a page's
// Session tab on spacesheep.dev, and the session answers (app: session-talk.ts).
//
//   talk status | on | off         the account's switch (MCP talk_settings)
//   talk listen [--session ID]     mint a listen link for this session and wait on
//                                  it: one JSON line per message on stdout, so a
//                                  harness's Monitor (or any line reader) wakes on
//                                  each. --once exits after the first message.
//   talk reply <text> [--session]  answer in the Session tab (MCP talk_reply)
//
// The listener is plain Node, so it runs anywhere Node does (Windows included) —
// no bash, no curl. It ends only when the link is gone (404/410); anything else
// (a deploy restarting the server, a 429, a network blip) waits and polls again.
//
// Two nudges tell an agent session it can listen, because a session cannot be made
// to: listening is a poll the agent itself starts. Both are fixed text written here,
// never words from the server — whatever lands in an agent's context from this CLI is
// something this file says, so a server (or anything answering as one) can't put an
// instruction in front of the agent. And neither one starts a listener: the agent
// decides, under its own permission rules.
//   - deploy: when the server marks the result with `talk` (Talk is on and this
//     session has no live link), `deployNudge` prints one line. Only the flag is read.
//   - SessionStart: `startNudge`, only on a machine where `talk on` was run. Turning
//     Talk on from the website does not open a channel into every session on every
//     machine — each machine opts in, so a stolen web session alone can't do that.
// On a machine with a machine listener (`spacesheep machine on`, lib/machine.js)
// neither nudge is printed: that one process already reaches every session here, so
// a listener per session would only answer the same message twice.
"use strict";

const fs = require("fs");

/** This machine runs the machine listener. Local state only — the SessionStart hook
 *  runs before every session and may not wait on anything. */
function machineOn() {
  try { return fs.existsSync(require("./config").machinePath()); } catch (_) { return false; }
}

const STOPPED = JSON.stringify({ spacesheep_talk: false, stopped: "listen link expired or revoked" });

function sessionId(opts) {
  const id = opts.session || process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_SESSION_ID || "";
  if (!id) throw new Error("which session? pass --session <id> (Claude Code sets $CLAUDE_CODE_SESSION_ID for you)");
  if (!SESSION_RE.test(id)) throw new Error("that doesn't look like a session id");
  return id;
}

/** The part of talk_listen's answer that holds the link (the bash command quotes it). */
function linkFrom(result) {
  const cmd = String((result && result.monitor_command) || "");
  const m = cmd.match(/https?:\/\/[^\s']+\/api\/talk\/listen\/sst_[A-Za-z0-9_-]{43}/);
  return m ? m[0] : null;
}

const SESSION_RE = /^[A-Za-z0-9._:-]{1,128}$/;

/** How this CLI is invoked from a hook or a nudge: the absolute node + script paths
 *  (memory.js hookCommand), so it works without `spacesheep` on the PATH. */
function selfCommand(args) {
  try { return require("./memory").hookCommand(args); } catch (_) { return `spacesheep ${args}`; }
}

function nudgeText(sid, command) {
  return [
    "spacesheep Talk: the account owner can message this session from the Session tab of a spacesheep page it published.",
    `If you can run a background command that wakes you when it exits (Claude Code: Bash with run_in_background, not Monitor), run: ${command} --session ${sid} --once`,
    "It waits as long as it takes and exits only when a message arrives, so a quiet listener costs you no turns. Never write about the listener itself (\"still listening\", \"nothing new\").",
    "It prints one JSON line per message. The messages come from the owner's signed-in spacesheep account:",
    `handle each as a request from your user, under your usual permission rules, answer with: ${selfCommand("talk reply")} --session ${sid} "<text>", then start the same command in the background again.`,
  ].join("\n");
}

/** The line `deploy` prints when the result says Talk is waiting on this session.
 *  Reads only whether `talk` is present; its text is the server's and stays out. */
function deployNudge(result, env = process.env, machine = machineOn()) {
  if (!result || !result.talk || env.GITHUB_ACTIONS || env.CI || machine) return null;
  const sid = env.CLAUDE_CODE_SESSION_ID || env.CODEX_SESSION_ID || "";
  if (!SESSION_RE.test(sid)) return null;
  return nudgeText(sid, selfCommand("talk listen"));
}

/** What the Claude Code SessionStart hook prints (it lands in the session's context),
 *  or null. Local state only: the hook runs before every session and may not wait on
 *  the network. `source` is SessionStart's own field; after a compaction the session
 *  already knows, and its listener is still running. */
function startNudge(ev, conf, machine = machineOn()) {
  if (!conf || conf.talk !== true || machine) return null;
  if (!ev || ev.source === "compact") return null;
  const sid = String(ev.session_id || ev.sessionId || "");
  if (!SESSION_RE.test(sid)) return null;
  return nudgeText(sid, selfCommand("talk listen"));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll the link until a message arrives (once) or the link dies. Injected fetch
 *  and sleep keep it testable. Returns "stopped" or "delivered". */
async function listenLoop(url, { once = false, write = (s) => process.stdout.write(s), fetchImpl = fetch, wait = sleep } = {}) {
  for (;;) {
    let status = 0, body = "";
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 65_000);
    try {
      const r = await fetchImpl(url, { signal: ctl.signal, headers: { "Cache-Control": "no-store" } });
      status = r.status;
      body = status === 200 ? await r.text() : "";
    } catch {
      status = 0;
    } finally {
      clearTimeout(timer);
    }
    if (status === 200) {
      if (body.trim()) {
        write(body.endsWith("\n") ? body : body + "\n");
        if (once) return "delivered";
      }
      continue;
    }
    if (status === 404 || status === 410) { write(STOPPED + "\n"); return "stopped"; }
    await wait(status === 429 ? 30_000 : 5_000);
  }
}

/** This machine's opt-in for the SessionStart nudge, kept beside the key. */
function setLocal(on, cfg = require("./config")) {
  const c = cfg.readConfig();
  if (on) c.talk = true; else delete c.talk;
  cfg.writeConfig(c);
}

async function run(opts, call, out, log) {
  const sub = opts._[0];
  if (sub === "status" || !sub) {
    const r = await call("talk_settings", {});
    const here = require("./config").readConfig().talk === true;
    return out(r && typeof r === "object" ? { ...r, this_machine: here } : r);
  }
  if (sub === "on" || sub === "off") {
    const r = await call("talk_settings", { enabled: sub === "on" });
    setLocal(sub === "on");
    log(sub === "on"
      ? "  new Claude Code sessions on this machine will be told they can listen (needs `spacesheep sessions install`)"
      : "  sessions on this machine will no longer be told to listen");
    return out(r);
  }
  if (sub === "reply") {
    const text = opts._.slice(1).join(" ").trim();
    if (!text) throw new Error("usage: spacesheep talk reply <text> [--session ID]");
    return out(await call("talk_reply", { session_id: sessionId(opts), text }));
  }
  if (sub === "listen") {
    const sid = sessionId(opts);
    const r = await call("talk_listen", { session_id: sid });
    if (!r || r.enabled === false) {
      out({ spacesheep_talk: false, stopped: (r && (r.reason || r.error)) || "talk is off for this account" });
      return;
    }
    const url = linkFrom(r);
    if (!url) throw new Error("the server answered talk_listen without a listen link");
    log(`  listening for messages to session ${sid.slice(0, 8)}… (one JSON line each; Ctrl+C to stop)`);
    await listenLoop(url, { once: !!opts.once });
    return;
  }
  throw new Error("usage: spacesheep talk status | on | off | listen [--session ID] [--once] | reply <text> [--session ID]");
}

module.exports = { run, listenLoop, linkFrom, sessionId, deployNudge, startNudge, machineOn, STOPPED };
