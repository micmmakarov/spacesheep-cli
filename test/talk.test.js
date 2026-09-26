"use strict";
const test = require("node:test");
const assert = require("node:assert");
const { listenLoop, linkFrom, sessionId, STOPPED } = require("../lib/talk");

const URL_ = "https://spacesheep.dev/api/talk/listen/sst_" + "a".repeat(43);

test("finds the link in talk_listen's bash command", () => {
  assert.equal(linkFrom({ monitor_command: `f=$(mktemp); while :; do code=$(curl -sS -o "$f" '${URL_}') ...` }), URL_);
  assert.equal(linkFrom({ monitor_command: "nothing here" }), null);
});

test("session id: flag, then Claude Code's env, never a bad shape", () => {
  assert.equal(sessionId({ session: "abc-123" }), "abc-123");
  const prev = process.env.CLAUDE_CODE_SESSION_ID;
  process.env.CLAUDE_CODE_SESSION_ID = "11b51bc8-208b-468a-bc1a-d8505d8b9d16";
  assert.equal(sessionId({}), "11b51bc8-208b-468a-bc1a-d8505d8b9d16");
  if (prev === undefined) delete process.env.CLAUDE_CODE_SESSION_ID; else process.env.CLAUDE_CODE_SESSION_ID = prev;
  assert.throws(() => sessionId({ session: "a b" }));
});

test("rides out a deploy's 5xx and a blip, prints each message, stops only on 410", async () => {
  const seq = [[503, ""], ["throw"], [200, ""], [200, '{"spacesheep_talk":true,"id":1}\n'], [500, ""], [429, ""], [410, "expired"]];
  let i = 0; const waits = []; let printed = "";
  const fetchImpl = async () => { const [s, b] = seq[i++]; if (s === "throw") throw new Error("net"); return { status: s, text: async () => b }; };
  const r = await listenLoop(URL_, { fetchImpl, wait: async (ms) => { waits.push(ms); }, write: (s) => { printed += s; } });
  assert.equal(r, "stopped");
  assert.equal(printed, '{"spacesheep_talk":true,"id":1}\n' + STOPPED + "\n");
  assert.deepEqual(waits, [5000, 5000, 5000, 30000]);
});

test("--once returns on the first message", async () => {
  const seq = [[200, ""], [200, '{"id":7}']];
  let i = 0, printed = "";
  const r = await listenLoop(URL_, { once: true, fetchImpl: async () => { const [s, b] = seq[i++]; return { status: s, text: async () => b }; }, wait: async () => {}, write: (s) => { printed += s; } });
  assert.equal(r, "delivered");
  assert.equal(printed, '{"id":7}\n');
});
