"use strict";
const test = require("node:test");
const assert = require("node:assert");
const mem = require("../lib/memory");
const ses = require("../lib/sessions");

// Antigravity sessions showed "turns: 0" on the board: its hooks sent state only
// (@yaroslavvb, 2026-09-26). Its transcript is one step per line.
const step = (o) => JSON.stringify(o);
const lines = [
  step({ step_index: 0, type: "USER_INPUT", created_at: "2026-09-26T18:00:00Z", content: "<USER_SETTINGS>theme: dark</USER_SETTINGS>\n<USER_REQUEST>\nMeasure the LPDDR4X link speed\n</USER_REQUEST>" }),
  step({ step_index: 1, type: "RUN_COMMAND", created_at: "2026-09-26T18:00:05Z", content: "./bench --link" }),
  step({ step_index: 2, type: "PLANNER_RESPONSE", created_at: "2026-09-26T18:01:00Z", content: "The link runs at 4266 MT/s." }),
  step({ step_index: 3, type: "USER_INPUT", created_at: "2026-09-26T18:02:00Z", content: "<USER_REQUEST>\nLabel it in the diagram\n</USER_REQUEST>" }),
  step({ step_index: 4, type: "PLANNER_RESPONSE", created_at: "2026-09-26T18:03:00Z", content: "Labelled." }),
  step({ step_index: 5, type: "USER_INPUT", created_at: "2026-09-26T18:04:00Z", content: "<USER_REQUEST>\nAnd the other one?\n</USER_REQUEST>" }),
  "",
];

test("Antigravity steps become turns: the person's words from USER_REQUEST, the model's from PLANNER_RESPONSE", () => {
  const r = mem.parseAntigravity(lines, 0);
  assert.deepEqual(r.turns.map((t) => [t.user, t.assistant]), [
    ["Measure the LPDDR4X link speed", "The link runs at 4266 MT/s."],
    ["Label it in the diagram", "Labelled."],
  ]);
  assert.equal(r.turns[0].at, Date.parse("2026-09-26T18:00:00Z"));
  // A question with no reply yet waits: the cursor stops before it.
  assert.equal(r.line, 5);
});

test("a later sync picks up from the cursor", () => {
  const more = lines.slice(0, 6).concat([step({ step_index: 6, type: "PLANNER_RESPONSE", created_at: "2026-09-26T18:05:00Z", content: "The other one is 3200 MT/s." }), ""]);
  const r = mem.parseAntigravity(more, 5);
  assert.deepEqual(r.turns.map((t) => [t.user, t.assistant]), [["And the other one?", "The other one is 3200 MT/s."]]);
});

test("with turn sync on, Antigravity's Stop runs memory sync after the session ping", () => {
  const on = ses.antigravityEntry(true), off = ses.antigravityEntry(false);
  assert.equal(on.Stop.length, 2);
  assert.match(on.Stop[0].command, /sessions ping stop --antigravity/);
  assert.match(on.Stop[1].command, /memory sync --source antigravity/);
  assert.equal(off.Stop.length, 1);
  assert.deepEqual(on.PreInvocation, off.PreInvocation);
});
