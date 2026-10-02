"use strict";
// The machine's own check of a command from spacesheep.dev (lib/machine-verify.js),
// against a simulated passkey and page key. Every refusal path the protocol names,
// and the ways in: grant + command signature, a fresh confirm, a pairing proof.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const v = require("../lib/machine-verify");
const { authenticator, browserKey, makeGrant, makeCmd, signedJob, confirmedJob, RP } = require("./machine-helpers");

const es = authenticator(-7);
const rs = authenticator(-257);
const br = browserKey();
const MACHINE = "m_test";

function opts(extra = {}) {
  const seen = new Set();
  return {
    machineId: MACHINE, rpId: RP, trusted: [es.key, rs.key], now: Date.now(),
    seenNonce: (n) => { if (seen.has(n)) return true; seen.add(n); return false; },
    ...extra,
  };
}
const refused = (r, re) => { assert.equal(r.ok, false, "expected a refusal"); assert.match(r.why, re); };

// --- ways in -----------------------------------------------------------------------

test("grant (ES256 passkey) + command signature: runs", () => {
  const cmd = makeCmd();
  const r = v.authorize(signedJob(1, cmd, makeGrant(es, br), br), opts());
  assert.equal(r.ok, true, r.why);
  assert.equal(r.via, "grant");
  assert.equal(r.cmd.text, "what's the status?");
});

test("grant (RS256 passkey) + command signature: runs", () => {
  const r = v.authorize(signedJob(1, makeCmd(), makeGrant(rs, br), br), opts());
  assert.equal(r.ok, true, r.why);
});

test("a fresh confirm tap over the command: runs (ES256 and RS256)", () => {
  for (const a of [es, rs]) {
    const r = v.authorize(confirmedJob(2, makeCmd(), a), opts());
    assert.equal(r.ok, true, r.why);
    assert.equal(r.via, "confirm");
  }
});

test("a start command in a folder with a fresh uuid: runs", () => {
  const cmd = makeCmd({ action: "start", session: crypto.randomUUID(), cwd: "/Users/me/proj" });
  assert.equal(v.authorize(signedJob(3, cmd, makeGrant(es, br), br), opts()).ok, true);
});

test("https origins on the rp id or a subdomain; http only for localhost", () => {
  assert.ok(v.allowedOrigin("https://spacesheep.dev", "spacesheep.dev"));
  assert.ok(v.allowedOrigin("https://acme.spacesheep.dev", "spacesheep.dev"));
  assert.ok(v.allowedOrigin("http://localhost:8791", "localhost"));
  assert.ok(v.allowedOrigin("https://localhost", "localhost"));
  assert.ok(!v.allowedOrigin("http://spacesheep.dev", "spacesheep.dev"));
  assert.ok(!v.allowedOrigin("https://evilspacesheep.dev", "spacesheep.dev"));
  assert.ok(!v.allowedOrigin("https://spacesheep.dev.evil.com", "spacesheep.dev"));
  assert.ok(!v.allowedOrigin("https://spacesheep.dev/path", "spacesheep.dev"));
  assert.ok(!v.allowedOrigin("http://localhost.evil.com", "localhost"));
});

// --- the passkey assertion ------------------------------------------------------------

test("wrong origin is refused", () => {
  refused(v.authorize(signedJob(1, makeCmd(), makeGrant(es, br, { origin: "https://evil.example" }), br), opts()), /evil\.example/);
  refused(v.authorize(confirmedJob(1, makeCmd(), es, { origin: "http://spacesheep.dev" }), opts({ rpId: "spacesheep.dev" })), /used on/);
});

test("wrong rp id (authenticator data for another site) is refused", () => {
  refused(v.authorize(signedJob(1, makeCmd(), makeGrant(es, br, { rpId: "evil.example" }), br), opts()), /another site/);
  refused(v.authorize(confirmedJob(1, makeCmd(), es, { rpId: "evil.example" }), opts()), /another site/);
});

test("no user verification (UV) or no user presence (UP) is refused", () => {
  refused(v.authorize(confirmedJob(1, makeCmd(), es, { flags: 0x01 }), opts()), /verify the person/);
  refused(v.authorize(confirmedJob(1, makeCmd(), es, { flags: 0x04 }), opts()), /verify the person/);
  refused(v.authorize(signedJob(1, makeCmd(), makeGrant(es, br, { flags: 0x01 }), br), opts()), /verify the person/);
});

test("not a get assertion, cross-origin, or a signature from the wrong key: refused", () => {
  refused(v.authorize(confirmedJob(1, makeCmd(), es, { type: "webauthn.create" }), opts()), /not a sign-in/);
  refused(v.authorize(confirmedJob(1, makeCmd(), es, { crossOrigin: true }), opts()), /frame/);
  // rs signs, but claims to be es's credential
  refused(v.authorize(confirmedJob(1, makeCmd(), rs, { cred: es.key.id }), opts()), /doesn't verify/);
});

test("a passkey the machine never paired with is refused", () => {
  const stranger = authenticator(-7);
  refused(v.authorize(confirmedJob(1, makeCmd(), stranger), opts()), /doesn't trust/);
  refused(v.authorize(signedJob(1, makeCmd(), makeGrant(stranger, br), br), opts()), /doesn't trust/);
  refused(v.authorize(signedJob(1, makeCmd(), makeGrant(es, br), br), opts({ trusted: [rs.key] })), /doesn't trust/);
});

// --- the grant ------------------------------------------------------------------------

// A command is judged by when it was signed: the machine may have been asleep.
test("a command signed 3 h ago under a grant that has since expired runs (fresh nonce)", () => {
  const now = Date.now();
  const g = makeGrant(es, br, { iat: now - 20 * 3600e3, exp: now - 2 * 3600e3 });
  const r = v.authorize(signedJob(1, makeCmd({ iat: now - 3 * 3600e3 }), g, br), opts({ now }));
  assert.equal(r.ok, true, r.why);
  // ... once: the same command again is a replay
  const o = opts({ now });
  assert.equal(v.authorize(signedJob(2, makeCmd({ iat: now - 3 * 3600e3, nonce: "n".repeat(22) }), g, br), o).ok, true);
  refused(v.authorize(signedJob(3, makeCmd({ iat: now - 3 * 3600e3, nonce: "n".repeat(22) }), g, br), o), /already used/);
});

test("a command signed 25 h ago is refused, even under a grant that was live then", () => {
  const now = Date.now();
  const g = makeGrant(es, br, { iat: now - 26 * 3600e3, exp: now - 2 * 3600e3 });
  refused(v.authorize(signedJob(1, makeCmd({ iat: now - 25 * 3600e3 }), g, br), opts({ now })), /more than 24 hours ago/);
});

test("a command signed after its grant's exp is refused", () => {
  const now = Date.now();
  const g = makeGrant(es, br, { iat: now - 25 * 3600e3, exp: now - 3600e3 });
  refused(v.authorize(signedJob(1, makeCmd({ iat: now - 30 * 60e3 }), g, br), opts({ now })), /after its 24-hour unlock had ended/);
  refused(v.authorize(signedJob(1, makeCmd({ iat: now }), g, br), opts({ now })), /after its 24-hour unlock had ended/);
});

test("a grant longer than 24 hours (+5 min skew) is refused; exactly that long is fine", () => {
  const now = Date.now();
  refused(v.authorize(signedJob(1, makeCmd(), makeGrant(es, br, { iat: now, exp: now + 24 * 3600e3 + 6 * 60e3 }), br), opts()), /longer than 24 hours/);
  assert.equal(v.authorize(signedJob(1, makeCmd(), makeGrant(es, br, { iat: now, exp: now + 24 * 3600e3 + 5 * 60e3 }), br), opts()).ok, true);
});

test("a grant for another rp, of another type, or ending before it starts is refused", () => {
  const now = Date.now();
  refused(v.authorize(signedJob(1, makeCmd(), makeGrant(es, br, { iat: now, exp: now }), br), opts()), /malformed/);
  refused(v.authorize(signedJob(1, makeCmd(), makeGrant(es, br, { rp: "evil.example" }), br), opts()), /evil\.example/);
  refused(v.authorize(signedJob(1, makeCmd(), makeGrant(es, br, { t: "something-else" }), br), opts()), /not a spacesheep/);
});

test("a grant whose string was edited after the passkey signed it is refused", () => {
  const g = makeGrant(es, br);
  const other = browserKey();
  const edited = { ...g, str: g.str.replace(br.pub, other.pub) };
  refused(v.authorize(signedJob(1, makeCmd(), edited, other), opts()), /signed something else/);
});

// --- the command ----------------------------------------------------------------------

test("a command changed after it was signed is refused", () => {
  const cmd = makeCmd();
  const job = signedJob(1, cmd, makeGrant(es, br), br);
  job.cmd = cmd.replace("what's the status?", "rm -rf ~");
  refused(v.authorize(job, opts()), /changed after it was signed/);
  // and a confirm over one command doesn't cover another
  const c = confirmedJob(2, makeCmd({ text: "harmless" }), es);
  c.cmd = makeCmd({ text: "something else" });
  refused(v.authorize(c, opts()), /signed something else/);
});

test("a command signed by a browser key the grant doesn't name is refused", () => {
  const other = browserKey();
  const cmd = makeCmd();
  refused(v.authorize({ id: 1, cmd, csig: other.sign(cmd), grant: makeGrant(es, br), confirm: null }, opts()), /changed after it was signed/);
});

test("a command for another machine is refused", () => {
  refused(v.authorize(signedJob(1, makeCmd({ machine: "m_other" }), makeGrant(es, br), br), opts()), /another machine/);
});

test("a replayed nonce is refused; the first use runs", () => {
  const o = opts();
  const cmd = makeCmd();
  assert.equal(v.authorize(signedJob(1, cmd, makeGrant(es, br), br), o).ok, true);
  refused(v.authorize(signedJob(2, cmd, makeGrant(es, br), br), o), /already used/);
});

test("a forged job doesn't burn the real command's nonce", () => {
  const o = opts();
  const cmd = makeCmd();
  const forged = signedJob(1, cmd, makeGrant(es, br), br);
  forged.csig = browserKey().sign(cmd);
  assert.equal(v.authorize(forged, o).ok, false);
  assert.equal(v.authorize(signedJob(2, cmd, makeGrant(es, br), br), o).ok, true);
});

test("command age: more than a day old, or more than 5 minutes in the future, is refused", () => {
  const now = Date.now();
  refused(v.authorize(confirmedJob(1, makeCmd({ iat: now - 24 * 3600e3 - 1 }), es), opts({ now })), /more than 24 hours ago/);
  refused(v.authorize(signedJob(1, makeCmd({ iat: now + 6 * 60e3 }), makeGrant(es, br), br), opts({ now })), /future/);
  refused(v.authorize(confirmedJob(1, makeCmd({ iat: now + 6 * 60e3 }), es), opts({ now })), /future/);
  // an hour old, 4 minutes ahead: fine (the server judged freshness when it was sent)
  assert.equal(v.authorize(confirmedJob(1, makeCmd({ iat: now - 3600e3 }), es), opts({ now })).ok, true);
  assert.equal(v.authorize(signedJob(1, makeCmd({ iat: now + 4 * 60e3 }), makeGrant(es, br), br), opts({ now })).ok, true);
});

test("a command signed before its grant began (beyond the 5-minute skew) is refused", () => {
  const now = Date.now();
  const g = makeGrant(es, br, { iat: now + 4 * 60e3, exp: now + 3600e3 });
  refused(v.authorize(signedJob(1, makeCmd({ iat: now - 6 * 60e3 }), g, br), opts()), /before its unlock began/);
  assert.equal(v.authorize(signedJob(1, makeCmd({ iat: now - 60e3 }), g, br), opts()).ok, true);
});

test("unsigned, empty, too long, wrong source, bad ids: refused", () => {
  refused(v.authorize({ id: 1, cmd: makeCmd(), csig: null, grant: null, confirm: null }, opts()), /isn't signed/);
  refused(v.authorize({ id: 1, cmd: makeCmd(), csig: "x", grant: null, confirm: null }, opts()), /isn't signed/);
  const g = makeGrant(es, br);
  refused(v.authorize(signedJob(1, makeCmd({ text: "   " }), g, br), opts()), /empty/);
  refused(v.authorize(signedJob(1, makeCmd({ text: "x".repeat(4001) }), g, br), opts()), /longer than 4000/);
  refused(v.authorize(signedJob(1, makeCmd({ source: "codex" }), g, br), opts()), /Claude Code/);
  refused(v.authorize(signedJob(1, makeCmd({ session: "../../etc/passwd" }), g, br), opts()), /session id/);
  refused(v.authorize(signedJob(1, makeCmd({ action: "start", session: "not-a-uuid", cwd: "/tmp" }), g, br), opts()), /fresh id/);
  refused(v.authorize(signedJob(1, makeCmd({ action: "start", session: crypto.randomUUID(), cwd: "relative/dir" }), g, br), opts()), /folder/);
  refused(v.authorize(signedJob(1, makeCmd({ action: "exec" }), g, br), opts()), /unknown command/);
  refused(v.authorize(signedJob(1, makeCmd({ v: 2 }), g, br), opts()), /not a spacesheep/);
  refused(v.authorize(signedJob(1, makeCmd({ nonce: "short" }), g, br), opts()), /malformed/);
  refused(v.authorize({ id: 1, cmd: "{not json", csig: null, grant: null, confirm: null }, opts()), /malformed/);
});

test("with both a failing grant and a good confirm, the confirm lets it through", () => {
  const cmd = makeCmd();
  const job = confirmedJob(1, cmd, es);
  job.grant = makeGrant(es, br, { origin: "https://evil.example" });
  job.csig = br.sign(cmd);
  const r = v.authorize(job, opts());
  assert.equal(r.ok, true, r.why);
  assert.equal(r.via, "confirm");
});

// --- attached files (start only) ----------------------------------------------------------

const SHA = v.b64url(v.sha256(Buffer.from("png bytes")));
const aFile = (o = {}) => ({ name: "screenshot.png", type: "image/png", size: 183402, sha256: SHA, ...o });
const startWith = (files, o = {}) => makeCmd({ action: "start", session: crypto.randomUUID(), cwd: "/Users/me/proj", files, ...o });

test("files: a start with valid files runs, names NFC-normalized; no files is today's start", () => {
  const g = makeGrant(es, br);
  const decomposed = "Cafe\u0301 notes.pdf";
  const r = v.authorize(signedJob(1, startWith([aFile(), aFile({ name: decomposed, type: "application/PDF", size: 1, sha256: v.b64url(crypto.randomBytes(32)) })]), g, br), opts());
  assert.equal(r.ok, true, r.why);
  assert.equal(r.cmd.files.length, 2);
  assert.equal(r.cmd.files[1].name, decomposed.normalize("NFC"));
  assert.deepEqual(Object.keys(r.cmd.files[0]).sort(), ["name", "sha256", "size", "type"]);
  const ten = Array.from({ length: 10 }, (_, i) => aFile({ name: `f${i}.png`, size: 5 * 1024 * 1024 }));
  assert.equal(v.authorize(signedJob(2, startWith(ten), g, br), opts()).ok, true, "10 files, 50 MB exactly");
  assert.equal(v.authorize(signedJob(3, startWith([aFile({ size: 25 * 1024 * 1024, name: "x".repeat(200) })]), g, br), opts()).ok, true, "25 MB, 200-char name");
  const plain = v.authorize(signedJob(4, startWith(undefined), g, br), opts());
  assert.equal(plain.ok, true);
  assert.equal(plain.cmd.files, undefined);
});

test("files: every rule of the contract refuses the command", () => {
  const g = makeGrant(es, br);
  const bad = (files, re, o) => refused(v.authorize(signedJob(1, startWith(files, o), g, br), opts()), re);
  // only on start
  refused(v.authorize(signedJob(1, makeCmd({ files: [aFile()] }), g, br), opts()), /only a new session/);
  // the list
  bad([], /1 to 10/);
  bad(null, /1 to 10/);
  bad({ 0: aFile() }, /1 to 10/);
  bad(Array.from({ length: 11 }, (_, i) => aFile({ name: `f${i}.png`, size: 1 })), /1 to 10/);
  bad(["screenshot.png"], /malformed/);
  // name
  bad([aFile({ name: undefined })], /no name/);
  bad([aFile({ name: 42 })], /no name/);
  bad([aFile({ name: "" })], /1 to 200/);
  bad([aFile({ name: "x".repeat(201) })], /1 to 200/);
  for (const n of ["a/b.png", "a\\b.png", "a\u0000b", "tab\there", "new\nline", "del\u007f"]) bad([aFile({ name: n })], /slash or a control/);
  for (const n of [".", "..", ".env", ".gitignore", ".git"]) bad([aFile({ name: n })], /start with a dot/);
  bad([aFile({ name: "Shot.PNG" }), aFile({ name: "shot.png", size: 1 })], /same name/);
  // type
  for (const t of [undefined, "", "image", "image/", "/png", "image/png; charset=x", "image /png", "-image/png", "a/" + "b".repeat(99)]) bad([aFile({ type: t })], /unusable type/);
  // size
  for (const n of [0, -1, 1.5, "100", null, 25 * 1024 * 1024 + 1]) bad([aFile({ size: n })], /1 byte to 25 MB/);
  // sha256: 43 base64url chars, no padding
  for (const h of [undefined, "", SHA.slice(0, 42), SHA + "A", SHA.slice(0, 42) + "=", SHA.slice(0, 42) + "+", Buffer.from(v.sha256(Buffer.from("x"))).toString("hex")]) bad([aFile({ sha256: h })], /malformed hash/);
  // total
  const three = Array.from({ length: 3 }, (_, i) => aFile({ name: `f${i}.bin`, size: 20 * 1024 * 1024 }));
  bad(three, /more than 50 MB/);
});

// --- pairing ----------------------------------------------------------------------------

test("pairing proof: verifies over the machine id and code, with the returned key", () => {
  for (const a of [es, rs]) {
    const challenge = v.sha256(Buffer.from("ss-machine-pair:m_abc:PAIRCODE1"));
    const proof = a.assert(challenge);
    assert.equal(v.verifyPairProof({ machineId: "m_abc", code: "PAIRCODE1", passkey: a.key, proof, rpId: RP }).ok, true);
    // another machine's (or another code's) proof doesn't count here
    refused(v.verifyPairProof({ machineId: "m_other", code: "PAIRCODE1", passkey: a.key, proof, rpId: RP }), /signed something else/);
    refused(v.verifyPairProof({ machineId: "m_abc", code: "OTHER", passkey: a.key, proof, rpId: RP }), /signed something else/);
  }
});

test("pairing proof: a key that didn't sign it, or a malformed key, is refused", () => {
  const challenge = v.sha256(Buffer.from("ss-machine-pair:m_abc:C"));
  const proof = rs.assert(challenge, { cred: es.key.id });
  refused(v.verifyPairProof({ machineId: "m_abc", code: "C", passkey: es.key, proof, rpId: RP }), /doesn't verify/);
  refused(v.verifyPairProof({ machineId: "m_abc", code: "C", passkey: { ...es.key, alg: -257 }, proof: es.assert(challenge), rpId: RP }), /shape/);
  refused(v.verifyPairProof({ machineId: "m_abc", code: "C", passkey: { ...es.key, spki: "AAAA" }, proof: es.assert(challenge), rpId: RP }), /shape/);
  refused(v.verifyPairProof({ machineId: "m_abc", code: "C", passkey: es.key, proof: es.assert(challenge, { flags: 0x01 }), rpId: RP }), /verify the person/);
});
