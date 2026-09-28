"use strict";
// Keep the transport generic; these builders map CLI spelling to MCP arguments.
const fs = require("fs");
const path = require("path");

// Mirrors shared/message-limits.ts on the server: the message row, and the text
// file an agent may attach beside it. The server is the judge; these only save a
// round trip for a file that could never be accepted.
const FEEDBACK_MESSAGE_MAX = 20000;
const FEEDBACK_ATTACH_MAX = 100000;
const ATTACH_NAME = /^[^\x00-\x1f\x7f/\\]+\.(txt|md|log)$/i;
function integer(opts, key, min, max) {
  if (opts[key] === undefined) return undefined;
  if (!/^\d+$/.test(String(opts[key]))) throw new Error(`--${key} must be an integer`);
  const n = Number(opts[key]);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`--${key} must be between ${min} and ${max}`);
  return n;
}
function sessionArgs(opts) {
  const args = {};
  if (opts.source !== undefined) {
    if (!/^[a-z][a-z-]{1,22}$/.test(opts.source)) throw new Error("invalid --source");
    args.source = opts.source;
  }
  const limit = integer(opts, "limit", 1, 100);
  if (limit !== undefined) args.limit = limit;
  if (opts._[0] === "get") {
    if (!args.source || opts._.length !== 2 || !/^[A-Za-z0-9._:-]{1,128}$/.test(opts._[1]))
      throw new Error("usage: spacesheep sessions get <id> --source <source> [--limit N]");
    args.session_id = opts._[1];
  } else {
    if (opts._.length !== 1) throw new Error("usage: spacesheep sessions list [options]");
    if (opts.state !== undefined) {
      if (!["working", "needs_you", "idle", "done"].includes(opts.state)) throw new Error("--state must be working, needs_you, idle or done");
      args.state = opts.state;
    }
    if (opts.machine !== undefined) {
      if (opts.machine.length > 80) throw new Error("--machine must be at most 80 characters");
      args.machine = opts.machine;
    }
    for (const key of ["since", "offset"]) {
      const n = integer(opts, key, 0, key === "offset" ? 1000000 : Number.MAX_SAFE_INTEGER);
      if (n !== undefined) args[key] = n;
    }
  }
  return args;
}
function feedbackArgs(opts) {
  if (opts._.length !== 1 || !opts._[0].trim() || !/^[A-Za-z0-9_-]{8,80}$/.test(opts.clientId || ""))
    throw new Error('usage: spacesheep feedback "message" --client-id <8–80 letters/digits/_/-> [--category bug] [--tag deploy] [--metadata \'{"status":503}\'] [--attach file.log]');
  const args = { message: opts._[0].trim(), client_id: opts.clientId };
  if (opts.category !== undefined) {
    args.category = opts.category.trim();
    if (!args.category || args.category.length > 80) throw new Error("--category must contain 1–80 characters");
  }
  if (opts.tags?.length) {
    args.tags = opts.tags.map(t => t.trim());
    if (args.tags.length > 10 || args.tags.some(t => !t || t.length > 80)) throw new Error("use at most 10 --tag values of 1–80 characters");
  }
  if (opts.metadata !== undefined) {
    try { args.metadata = JSON.parse(opts.metadata); } catch { throw new Error("--metadata must be a JSON object of scalar values"); }
    const m = args.metadata;
    if (!m || Array.isArray(m) || typeof m !== "object" || Object.keys(m).length > 20 ||
        Object.entries(m).some(([k, v]) => !k || k.length > 80 || !(v === null || typeof v === "boolean" ||
          (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= 500))))
      throw new Error("--metadata accepts at most 20 scalar fields (strings up to 500 characters)");
  }
  if (opts.attach !== undefined) {
    // What the team should see verbatim — a log, a transcript tail — rides as a file
    // beside the message; the agent (or the person) chose what to put in it.
    let text;
    try { text = fs.readFileSync(String(opts.attach), "utf8"); }
    catch (e) { throw new Error(`--attach: cannot read ${opts.attach}: ${e.code || e.message}`); }
    if (!text.trim()) throw new Error("--attach: that file is empty");
    if (text.length > FEEDBACK_ATTACH_MAX) throw new Error(`--attach: the file holds ${text.length} characters; the limit is ${FEEDBACK_ATTACH_MAX}`);
    const base = path.basename(String(opts.attach));
    const filename = ATTACH_NAME.test(base) ? base : `${base.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 100)}.txt`;
    args.attachment = { text, filename };
  }
  const { message, client_id, attachment, ...context } = args;
  if (`${message}\n\n[Agent feedback context]\n${JSON.stringify({ source: "mcp", ...context })}`.length > FEEDBACK_MESSAGE_MAX)
    throw new Error(`feedback message and context must fit within ${FEEDBACK_MESSAGE_MAX} characters`);
  return args;
}
module.exports = { sessionArgs, feedbackArgs };
