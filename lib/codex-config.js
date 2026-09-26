// Codex's ~/.codex/config.toml, as far as turn sync needs it: its one top-level
// `notify` command.
//
// Codex reads `notify` only at the top level of the file — before the first
// [table]. Codex itself appends a [projects."<path>"] table for every folder it
// trusts, so a real config nearly always ENDS in a table, and a line appended at the
// end lands inside it: TOML reads it as projects."<path>".notify and Codex never runs
// it. That shipped until 1.9.1 and read as "installed" for 41 hours on @yaroslavvb's
// Intel Mac with 0 turns synced (report, 2026-09-26). So everything here works on
// the top-level region only, and a notify line of ours found inside a table is
// reported as misplaced, never as installed.
//
// Pure text in, text out: memory.js does the file I/O.

"use strict";

/** A notify written on one line — what every tool, ours included, writes. */
const NOTIFY_LINE = /^[ \t]*notify[ \t]*=[ \t]*(\[.*\])[ \t]*(?:#.*)?$/m;
/** Any top-level notify key, however its value is laid out. */
const NOTIFY_KEY = /^[ \t]*notify[ \t]*=/m;
/** A notify that runs spacesheep's turn sync directly. */
const OURS = /spacesheep(?:\.js)?",\s*"memory",\s*"sync"/;

/** Walks one line, keeping track of a multi-line string or array it opens or closes,
 *  so a line inside one is never mistaken for a table header. */
function scan(line, st) {
  let i = 0;
  while (i < line.length) {
    if (st.str) {
      const j = line.indexOf(st.str, i);
      if (j < 0) return;
      i = j + 3;
      st.str = null;
      continue;
    }
    const ch = line[i];
    if (ch === "#") return;
    if (line.startsWith('"""', i) || line.startsWith("'''", i)) { st.str = line.slice(i, i + 3); i += 3; continue; }
    if (ch === '"') {
      i++;
      while (i < line.length && line[i] !== '"') i += line[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (ch === "'") { const j = line.indexOf("'", i + 1); i = j < 0 ? line.length : j + 1; continue; }
    if (ch === "[") st.depth++;
    else if (ch === "]") st.depth = Math.max(0, st.depth - 1);
    i++;
  }
}

/** Offset of the first table header ([x] or [[x]]) — a line that starts with "["
 *  outside any multi-line string or array — or -1 when there is none. */
function firstTableAt(text) {
  const st = { depth: 0, str: null };
  let pos = 0;
  for (const line of text.split("\n")) {
    if (!st.str && st.depth === 0 && /^[ \t]*\[/.test(line)) return pos;
    scan(line, st);
    pos += line.length + 1;
  }
  return -1;
}

function split(text) {
  const at = firstTableAt(text);
  return at < 0 ? { head: text, tail: "", at: text.length } : { head: text.slice(0, at), tail: text.slice(at), at };
}

function parseArgv(raw) {
  try { const a = JSON.parse(raw); return Array.isArray(a) && a.every((x) => typeof x === "string") ? a : null; } catch (_) { return null; }
}

/** notify as Codex sees it. `{ raw, argv, index, length }` for a top-level one-line
 *  notify (`other` when it isn't ours); `{ other: true, raw }` for a top-level notify
 *  laid out over several lines; `{ misplaced: true, … }` for a line of ours inside a
 *  table, where Codex never reads it; null when there is none. */
function readNotify(text) {
  const { head, tail, at } = split(text);
  const m = NOTIFY_LINE.exec(head);
  if (m) return { raw: m[1], argv: parseArgv(m[1]), index: m.index, length: m[0].length, misplaced: false, other: !OURS.test(m[1]) };
  const k = NOTIFY_KEY.exec(head);
  if (k) {
    const rest = head.slice(k.index).split("\n")[0];
    return { raw: rest.replace(NOTIFY_KEY, "").trim(), argv: null, index: k.index, length: 0, misplaced: false, other: true };
  }
  const t = NOTIFY_LINE.exec(tail);
  if (t && OURS.test(t[1])) return { raw: t[1], argv: parseArgv(t[1]), index: at + t.index, length: t[0].length, misplaced: true, other: false };
  return null;
}

function dropLine(text, index, length) {
  return text.slice(0, index) + text.slice(index + length).replace(/^\r?\n/, "");
}

/** Puts `line` at the top level: just before the first table, or at the end of a
 *  file that has none. */
function insertTopLevel(text, line) {
  const { head, tail } = split(text);
  if (!tail) return (head.trim() ? head.replace(/\s*$/, "\n") : "") + line + "\n";
  return (head.trim() ? head.replace(/\s*$/, "\n") : "") + line + "\n\n" + tail;
}

/** The config with `line` as its notify, for a config whose notify is ours or absent:
 *  a top-level line of ours is rewritten where it stands, a misplaced one is moved to
 *  the top level, and a missing one is added there. Never called over another tool's
 *  notify (see readNotify's `other`). */
function withNotify(text, line) {
  const n = readNotify(text);
  if (n && !n.misplaced && !n.other) return text.slice(0, n.index) + line + text.slice(n.index + n.length);
  if (n && n.misplaced) return insertTopLevel(dropLine(text, n.index, n.length), line);
  return insertTopLevel(text, line);
}

/** The config with its top-level notify line replaced by `line` — for pointing another
 *  tool's notify at the chain wrapper, and for putting it back on uninstall. */
function replaceNotify(text, line) {
  const n = readNotify(text);
  if (!n || n.misplaced || !n.length) return null;
  return text.slice(0, n.index) + line + text.slice(n.index + n.length);
}

const CHAIN_MARK = "# spacesheep-chain-original: ";

/** A shell script that runs spacesheep's turn sync and then the notify command that
 *  was there before, with Codex's arguments, keeping that command's exit status and
 *  timing: ours goes to the background (its parent exits in milliseconds anyway). */
function chainScript(original, ours) {
  const q = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";
  return [
    "#!/bin/sh",
    "# Written by `spacesheep memory install --codex-chain`. Codex runs one notify",
    "# command, so this runs spacesheep's turn sync and then the one you had.",
    "# `spacesheep memory uninstall` puts the original back and deletes this file.",
    CHAIN_MARK + JSON.stringify(original),
    `${q(ours[0])} ${q(ours[1])} ${ours.slice(2).join(" ")} "$@" >/dev/null 2>&1 &`,
    `exec ${original.map(q).join(" ")} "$@"`,
    "",
  ].join("\n");
}

/** The original notify argv a chain wrapper of ours recorded, or null. */
function chainOriginal(script) {
  const line = String(script).split("\n").find((l) => l.startsWith(CHAIN_MARK));
  if (!line) return null;
  return parseArgv(line.slice(CHAIN_MARK.length));
}

// Codex Computer Use takes the notify slot itself and keeps the command it found in
// its own argv — ["…/SkyComputerUseClient", "turn-ended", "--previous-notify",
// "<that command as JSON>"] — and runs it after itself (seen on a Mac where it had
// wrapped an older spacesheep script, 2026-09-26). So a notify is ours when its
// --previous-notify is, and chaining onto that client is one more pair in its argv,
// not a wrapper that would run the client a second time.
const PREVIOUS = "--previous-notify";

/** The command a notify argv chains to with --previous-notify, or null. */
function previousNotify(argv) {
  if (!Array.isArray(argv)) return null;
  const i = argv.indexOf(PREVIOUS);
  return i >= 0 && typeof argv[i + 1] === "string" ? parseArgv(argv[i + 1]) : null;
}

/** `argv` with its --previous-notify set to `prev` (added when absent, replaced when
 *  present), or removed when `prev` is null. */
function withPrevious(argv, prev) {
  const out = argv.slice();
  const i = out.indexOf(PREVIOUS);
  if (i >= 0) out.splice(i, 2);
  if (prev) out.push(PREVIOUS, JSON.stringify(prev));
  return out;
}

/** A notify command that is Codex Computer Use's own client. */
const isComputerUse = (argv) => Array.isArray(argv) && typeof argv[0] === "string" && /(^|\/)SkyComputerUseClient$/.test(argv[0]);

module.exports = { firstTableAt, readNotify, withNotify, replaceNotify, insertTopLevel, chainScript, chainOriginal, parseArgv, previousNotify, withPrevious, isComputerUse, OURS };
