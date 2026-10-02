"use strict";
// What `spacesheep machine run` checks before it lets a message from spacesheep.dev
// reach a coding session on this machine (protocol v1, the machine listener).
//
// The server is not trusted here. A command runs only when it carries signatures
// this machine can check ITSELF, against the passkeys it paired with at its own
// terminal (`spacesheep machine on`): either a 24-hour "grant" — the passkey
// vouching for a browser key — plus that browser key's signature over the command,
// or a "confirm" — a fresh passkey tap over the command itself. So a stolen web
// login (a cookie, a password), or the server itself, can't make this machine do
// anything: none of them holds the passkey.
//
// Every signature covers the EXACT bytes as transmitted (`grant.str`, `cmd`): the
// strings are parsed to read their fields and never re-serialized to verify.
//
// Pure: no files, no network, no clock of its own (`now` is passed in), so every
// path is unit-tested with a simulated authenticator (test/machine-verify.test.js).

const crypto = require("crypto");
const path = require("path");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const SKEW = 5 * MIN;              // clocks disagree; a command may be signed a little "in the future"
const GRANT_MAX = 24 * HOUR + SKEW; // the longest unlock a passkey can vouch for
// A command is judged by when it was SIGNED, not when it arrives: a message sent
// while this machine slept must still run when it wakes. The server checks the
// 10-minute freshness at send time; here a command may be up to a day old, and the
// nonce memory (25 h, machine.js) is what stops it running twice.
const CMD_MAX_AGE = 24 * HOUR;
const MAX_TEXT = 4000;
const MAX_CMD = 16 * 1024;         // a command is a few hundred bytes; never parse megabytes
const UP = 0x01, UV = 0x04;        // authenticatorData flags: user present, user verified
const ES256 = -7, RS256 = -257;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Base64url, no padding, is what the spec sends. Standard base64 decodes to the same
// bytes and every value decoded here is either signed or a key from pairing, so the
// looser alphabet is accepted rather than refused on a formatting detail.
const B64_RE = /^[A-Za-z0-9_\-+/]*={0,2}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{22,128}$/; // at least 16 random bytes

// Files attached to a `start` (attachments contract §1). Each is named by the SHA-256
// of its bytes, so the command's signature covers the contents; the machine fetches
// them, checks size + hash, and only then writes them (machine.js attachFiles).
const MAX_FILES = 10;
const MAX_FILE_NAME = 200;
const MAX_FILE_TYPE = 100;
const MAX_FILE_SIZE = 25 * 1024 * 1024;   // 26 214 400
const MAX_FILES_TOTAL = 50 * 1024 * 1024; // 52 428 800
const TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const FILE_SHA_RE = /^[A-Za-z0-9_-]{43}$/; // SHA-256, base64url, no padding

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest();
const b64url = (buf) => Buffer.from(buf).toString("base64url");
function unb64(s) {
  if (typeof s !== "string" || !B64_RE.test(s)) return null;
  return Buffer.from(s.replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), "base64url");
}
const no = (why) => ({ ok: false, why });
const isNum = (n) => typeof n === "number" && Number.isFinite(n);

/** A WebAuthn origin the passkey may have been used from: https on the rp id or a
 *  subdomain of it; for rp id `localhost`, plain http on any port too. The whole
 *  string must be a bare origin (no path), which is what a browser writes. */
function allowedOrigin(origin, rpId) {
  if (typeof origin !== "string" || typeof rpId !== "string" || !rpId) return false;
  let u;
  try { u = new URL(origin); } catch (_) { return false; }
  if (u.origin !== origin) return false;
  const hostOk = u.hostname === rpId || u.hostname.endsWith("." + rpId);
  if (!hostOk) return false;
  if (u.protocol === "https:") return true;
  return u.protocol === "http:" && rpId === "localhost";
}

/** A public key from pairing, as a KeyObject that matches its algorithm — or null. */
function publicKey(spki, alg) {
  const der = unb64(spki);
  if (!der || !der.length) return null;
  let key;
  try { key = crypto.createPublicKey({ key: der, format: "der", type: "spki" }); } catch (_) { return null; }
  if (alg === ES256) {
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails && key.asymmetricKeyDetails.namedCurve === "prime256v1" ? key : null;
  }
  if (alg === RS256) {
    return key.asymmetricKeyType === "rsa" && key.asymmetricKeyDetails && key.asymmetricKeyDetails.modulusLength >= 2048 ? key : null;
  }
  return null;
}

/** A passkey assertion over `challenge` (bytes), checked against one trusted key
 *  {id, alg, spki}. Returns {ok:true} or {ok:false, why}. */
function checkAssertion(challenge, bundle, key, rpId) {
  if (!bundle || typeof bundle !== "object") return no("the passkey signature is missing");
  if (!key || key.id !== bundle.cred) return no("signed with a passkey this machine doesn't trust");
  const cdBytes = unb64(bundle.cd), ad = unb64(bundle.ad), sig = unb64(bundle.sig);
  if (!cdBytes || !ad || !sig || !sig.length) return no("the passkey signature is malformed");
  let cd;
  try { cd = JSON.parse(cdBytes.toString("utf8")); } catch (_) { return no("the passkey signature is malformed"); }
  if (!cd || typeof cd !== "object") return no("the passkey signature is malformed");
  if (cd.type !== "webauthn.get") return no("the passkey signature is not a sign-in assertion");
  if (cd.challenge !== b64url(challenge)) return no("the passkey signed something else");
  if (!allowedOrigin(cd.origin, rpId)) return no(`the passkey was used on ${typeof cd.origin === "string" ? cd.origin.slice(0, 80) : "an unknown site"}, not ${rpId}`);
  if (cd.crossOrigin === true) return no("the passkey was used from inside another site's frame");
  if (ad.length < 37) return no("the passkey signature is malformed");
  const rpHash = sha256(Buffer.from(rpId, "utf8"));
  if (!crypto.timingSafeEqual(ad.subarray(0, 32), rpHash)) return no(`the passkey belongs to another site, not ${rpId}`);
  const flags = ad[32];
  if (!(flags & UP) || !(flags & UV)) return no("the passkey didn't verify the person (no Touch ID / PIN)");
  const pub = publicKey(key.spki, key.alg);
  if (!pub) return no("a trusted passkey has an unusable key");
  const signed = Buffer.concat([ad, sha256(cdBytes)]);
  let ok = false;
  try {
    ok = key.alg === ES256
      ? crypto.verify("sha256", signed, { key: pub, dsaEncoding: "der" }, sig)
      : crypto.verify("sha256", signed, pub, sig);
  } catch (_) { ok = false; }
  return ok ? { ok: true } : no("the passkey signature doesn't verify");
}

/** The 24-hour unlock: a trusted passkey vouching for a browser key. Returns
 *  {ok:true, grant, pub} (pub: the browser key, a KeyObject) or {ok:false, why}.
 *  Deliberately NOT "has it expired by now": what matters is whether it was live
 *  when the command was signed (checkCmdWithGrant) — a command queued at 23:00
 *  under an unlock ending at midnight is still good when the machine wakes at 08:00. */
function checkGrant(bundle, { trusted, rpId }) {
  if (!bundle || typeof bundle !== "object" || typeof bundle.str !== "string" || bundle.str.length > MAX_CMD) return no("the unlock is missing or malformed");
  let g;
  try { g = JSON.parse(bundle.str); } catch (_) { return no("the unlock is malformed"); }
  if (!g || typeof g !== "object") return no("the unlock is malformed");
  if (g.v !== 1 || g.t !== "ss-machine-grant") return no("the unlock is not a spacesheep machine unlock");
  if (g.rp !== rpId) return no(`the unlock is for ${typeof g.rp === "string" ? g.rp.slice(0, 80) : "another site"}, not ${rpId}`);
  if (!isNum(g.iat) || !isNum(g.exp) || typeof g.pub !== "string") return no("the unlock is malformed");
  if (g.exp <= g.iat) return no("the unlock is malformed");
  if (g.exp - g.iat > GRANT_MAX) return no("the unlock lasts longer than 24 hours");
  const key = (trusted || []).find((k) => k && k.id === bundle.cred);
  if (!key) return no("the unlock was signed with a passkey this machine doesn't trust");
  const a = checkAssertion(sha256(Buffer.from(bundle.str, "utf8")), bundle, key, rpId);
  if (!a.ok) return a;
  const pub = publicKey(g.pub, ES256);
  if (!pub) return no("the unlock's browser key is unusable");
  return { ok: true, grant: g, pub };
}

/** The command's fields, read from the exact string. Returns {ok:true, cmd} or {ok:false, why}. */
function parseCmd(str) {
  if (typeof str !== "string" || !str || str.length > MAX_CMD) return no("the command is missing or too long");
  let c;
  try { c = JSON.parse(str); } catch (_) { return no("the command is malformed"); }
  if (!c || typeof c !== "object" || Array.isArray(c)) return no("the command is malformed");
  if (c.v !== 1 || c.t !== "ss-machine-cmd") return no("not a spacesheep machine command");
  if (c.action !== "message" && c.action !== "start") return no("unknown command");
  if (c.source !== "claude-code") return no("only Claude Code sessions can be reached");
  if (typeof c.machine !== "string" || typeof c.session !== "string" || typeof c.nonce !== "string" || !isNum(c.iat)) return no("the command is malformed");
  if (typeof c.text !== "string" || !c.text.trim()) return no("the message is empty");
  if (c.text.length > MAX_TEXT) return no(`the message is longer than ${MAX_TEXT} characters`);
  if (c.cwd !== null && c.cwd !== undefined && typeof c.cwd !== "string") return no("the command is malformed");
  if (c.files !== undefined) {
    if (c.action !== "start") return no("only a new session can carry attached files");
    const f = parseFiles(c.files);
    if (!f.ok) return f;
    c.files = f.files;
  }
  return { ok: true, cmd: c };
}

/** A start command's `files`, checked against the contract's rules. Returns
 *  {ok:true, files:[{name,type,size,sha256}]} (names NFC-normalized) or {ok:false, why}. */
function parseFiles(list) {
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_FILES) return no(`attached files must be a list of 1 to ${MAX_FILES}`);
  const out = [], seen = new Set();
  let total = 0;
  for (const f of list) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return no("an attached file is malformed");
    if (typeof f.name !== "string") return no("an attached file has no name");
    const name = f.name.normalize("NFC");
    const len = [...name].length;
    if (len < 1 || len > MAX_FILE_NAME) return no(`an attached file's name must be 1 to ${MAX_FILE_NAME} characters`);
    if (/[\/\\\u0000-\u001f\u007f]/.test(name)) return no("an attached file's name has a slash or a control character");
    if (name.startsWith(".")) return no("an attached file's name can't start with a dot");
    const key = name.toLowerCase();
    if (seen.has(key)) return no("two attached files have the same name");
    seen.add(key);
    if (typeof f.type !== "string" || f.type.length < 1 || f.type.length > MAX_FILE_TYPE || !TYPE_RE.test(f.type)) return no(`the attached file ${name.slice(0, 60)} has an unusable type`);
    if (!Number.isInteger(f.size) || f.size < 1 || f.size > MAX_FILE_SIZE) return no(`the attached file ${name.slice(0, 60)} must be 1 byte to 25 MB`);
    if (typeof f.sha256 !== "string" || !FILE_SHA_RE.test(f.sha256)) return no(`the attached file ${name.slice(0, 60)} has a malformed hash`);
    total += f.size;
    if (total > MAX_FILES_TOTAL) return no("the attached files add up to more than 50 MB");
    out.push({ name, type: f.type, size: f.size, sha256: f.sha256 });
  }
  return { ok: true, files: out };
}

/**
 * Is this job a command this machine may run?
 *   job:  { cmd, csig, grant, confirm } as the server handed it (nothing else is read)
 *   opts: { machineId, rpId, trusted:[{id,alg,spki}], now, seenNonce(nonce) }
 * `seenNonce` is called once, last, and only for a command whose signatures all
 * verified: answer true if the nonce was seen before, and remember it. (So a job with
 * a forged signature can't burn the nonce of the real one.)
 * Returns { ok:true, cmd, via:"grant"|"confirm" } or { ok:false, why:"<plain words>" }.
 */
function authorize(job, { machineId, rpId, trusted, now, seenNonce }) {
  if (!job || typeof job !== "object") return no("empty job");
  const p = parseCmd(job.cmd);
  if (!p.ok) return p;
  const c = p.cmd;
  if (c.machine !== machineId) return no("the command is for another machine");
  if (c.iat > now + SKEW) return no("the command is dated in the future (is this machine's clock right?)");
  if (now - c.iat > CMD_MAX_AGE) return no("the command was signed more than 24 hours ago");
  if (!NONCE_RE.test(c.nonce)) return no("the command is malformed");
  if (c.action === "start") {
    if (!UUID_RE.test(c.session)) return no("a new session needs a fresh id");
    if (typeof c.cwd !== "string" || !path.isAbsolute(c.cwd)) return no("a new session needs a folder to start in");
  } else if (!UUID_RE.test(c.session)) {
    return no("that isn't a Claude Code session id");
  }

  // Either signature path is enough. When both came, the grant is tried first; the
  // refusal names the confirm's reason when there was one (it is the fresh tap).
  let via = null, why = null;
  if (job.grant && job.csig) {
    const r = checkCmdWithGrant(job.cmd, c, job.grant, job.csig, { trusted, rpId, now });
    if (r.ok) via = "grant"; else why = r.why;
  }
  if (!via && job.confirm) {
    const key = (trusted || []).find((k) => k && k.id === job.confirm.cred);
    const r = key ? checkAssertion(sha256(Buffer.from(job.cmd, "utf8")), job.confirm, key, rpId) : no("confirmed with a passkey this machine doesn't trust");
    if (r.ok) via = "confirm"; else why = r.why;
  }
  if (!via) return no(why || "the command isn't signed — unlock with your passkey on the page");
  if (typeof seenNonce !== "function" || seenNonce(c.nonce)) return no("this command was already used once");
  return { ok: true, cmd: c, via };
}

function checkCmdWithGrant(str, c, grant, csig, opts) {
  const g = checkGrant(grant, opts);
  if (!g.ok) return g;
  const sig = unb64(csig);
  if (!sig || sig.length !== 64) return no("the command's signature is malformed");
  let ok = false;
  try { ok = crypto.verify("sha256", Buffer.from(str, "utf8"), { key: g.pub, dsaEncoding: "ieee-p1363" }, sig); } catch (_) { ok = false; }
  if (!ok) return no("the command's signature doesn't verify — it was changed after it was signed");
  if (c.iat > g.grant.exp) return no("the command was signed after its 24-hour unlock had ended — unlock again on the page");
  if (c.iat < g.grant.iat - SKEW) return no("the command was signed before its unlock began");
  return { ok: true };
}

/** A passkey the server says was just paired: {id, alg, spki} in a usable shape. */
function validPasskey(pk) {
  if (!pk || typeof pk !== "object") return false;
  if (typeof pk.id !== "string" || !/^[A-Za-z0-9_-]{16,1400}$/.test(pk.id)) return false;
  if (pk.alg !== ES256 && pk.alg !== RS256) return false;
  return !!publicKey(pk.spki, pk.alg);
}

/** The pairing proof: the new passkey's assertion over
 *  SHA-256("ss-machine-pair:" + machineId + ":" + code). Only after this verifies does
 *  the key go into the machine's trust store. */
function verifyPairProof({ machineId, code, passkey, proof, rpId }) {
  if (!validPasskey(passkey)) return no("the paired passkey is in a shape this machine can't use");
  const challenge = sha256(Buffer.from(`ss-machine-pair:${machineId}:${code}`, "utf8"));
  return checkAssertion(challenge, proof, passkey, rpId);
}

module.exports = {
  authorize, checkAssertion, checkGrant, parseCmd, parseFiles, verifyPairProof, validPasskey, allowedOrigin, publicKey,
  sha256, b64url, UUID_RE, MAX_TEXT, ES256, RS256, MAX_FILES, MAX_FILE_SIZE, MAX_FILES_TOTAL,
};
