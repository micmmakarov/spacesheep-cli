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
"use strict";

const STOPPED = JSON.stringify({ spacesheep_talk: false, stopped: "listen link expired or revoked" });

function sessionId(opts) {
  const id = opts.session || process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_SESSION_ID || "";
  if (!id) throw new Error("which session? pass --session <id> (Claude Code sets $CLAUDE_CODE_SESSION_ID for you)");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new Error("that doesn't look like a session id");
  return id;
}

/** The part of talk_listen's answer that holds the link (the bash command quotes it). */
function linkFrom(result) {
  const cmd = String((result && result.monitor_command) || "");
  const m = cmd.match(/https?:\/\/[^\s']+\/api\/talk\/listen\/sst_[A-Za-z0-9_-]{43}/);
  return m ? m[0] : null;
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

async function run(opts, call, out, log) {
  const sub = opts._[0];
  if (sub === "status" || !sub) return out(await call("talk_settings", {}));
  if (sub === "on" || sub === "off") return out(await call("talk_settings", { enabled: sub === "on" }));
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

module.exports = { run, listenLoop, linkFrom, sessionId, STOPPED };
