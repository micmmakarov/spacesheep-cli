"use strict";
// The browser half of the machine protocol, simulated with Node crypto, for the
// machine tests: a passkey authenticator (ES256 or RS256) that makes WebAuthn
// assertions, and the page's WebCrypto key that signs commands. No tests here.
const crypto = require("crypto");
const { sha256, b64url } = require("../lib/machine-verify");

const ORIGIN = "http://localhost:8791";
const RP = "localhost";

/** A passkey. `assert(challenge, opts)` returns {cred, ad, cd, sig} the way a browser's
 *  navigator.credentials.get() result is sent: authenticatorData = sha256(rpId) ||
 *  flags || signCount, signed over authData || sha256(clientDataJSON). */
function authenticator(alg = -7) {
  const pair = alg === -7
    ? crypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
    : crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const id = b64url(crypto.randomBytes(32));
  return {
    key: { id, alg, spki: b64url(pair.publicKey.export({ format: "der", type: "spki" })) },
    assert(challenge, o = {}) {
      const client = { type: o.type || "webauthn.get", challenge: b64url(challenge), origin: o.origin || ORIGIN };
      if (o.crossOrigin !== undefined) client.crossOrigin = o.crossOrigin;
      const cd = Buffer.from(JSON.stringify(client));
      const flags = o.flags === undefined ? 0x05 : o.flags;
      const ad = Buffer.concat([sha256(Buffer.from(o.rpId || RP)), Buffer.from([flags]), Buffer.from([0, 0, 0, 7])]);
      const data = Buffer.concat([ad, sha256(cd)]);
      const sig = alg === -7
        ? crypto.sign("sha256", data, { key: pair.privateKey, dsaEncoding: "der" })
        : crypto.sign("sha256", data, pair.privateKey);
      return { cred: o.cred || id, ad: b64url(ad), cd: b64url(cd), sig: b64url(sig) };
    },
  };
}

/** The page's non-extractable WebCrypto key: ECDSA P-256, raw r||s signatures. */
function browserKey() {
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    pub: b64url(pair.publicKey.export({ format: "der", type: "spki" })),
    sign: (str) => b64url(crypto.sign("sha256", Buffer.from(str, "utf8"), { key: pair.privateKey, dsaEncoding: "ieee-p1363" })),
  };
}

/** A 24-hour unlock: the passkey vouching for the browser key. */
function makeGrant(auth, br, { now = Date.now(), iat = now, exp = now + 24 * 3600e3, rp = RP, v = 1, t = "ss-machine-grant", ...assertOpts } = {}) {
  const str = JSON.stringify({ v, t, pub: br.pub, iat, exp, rp });
  return { str, ...auth.assert(sha256(Buffer.from(str, "utf8")), assertOpts) };
}

function makeCmd(fields = {}) {
  return JSON.stringify({
    v: 1, t: "ss-machine-cmd", machine: "m_test", action: "message", source: "claude-code",
    session: "11b51bc8-208b-468a-bc1a-d8505d8b9d16", cwd: null, text: "what's the status?",
    nonce: b64url(crypto.randomBytes(16)), iat: Date.now(), ...fields,
  });
}

const signedJob = (id, cmd, grant, br) => ({ id, cmd, csig: br.sign(cmd), grant, confirm: null, created_at: Date.now() });
const confirmedJob = (id, cmd, auth, o) => ({ id, cmd, csig: null, grant: null, confirm: auth.assert(sha256(Buffer.from(cmd, "utf8")), o), created_at: Date.now() });

module.exports = { authenticator, browserKey, makeGrant, makeCmd, signedJob, confirmedJob, ORIGIN, RP };
