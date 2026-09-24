"use strict";
// The same cases as packages/app/test/redact-secrets.test.ts in the spacesheep repo:
// the two copies of the rules must agree. Run: npm test
const { describe, it } = require("node:test");
const assert = require("node:assert");
const { redactSecrets, hasSecret, redactDeep, REDACTED } = require("../lib/redact");

const expect = (a) => ({
  toBe: (b) => assert.strictEqual(a, b),
  toContain: (b) => assert.ok(a.includes(b), `${JSON.stringify(a)} should contain ${b}`),
  not: { toContain: (b) => assert.ok(!a.includes(b), `${JSON.stringify(a)} should not contain ${b}`) },
  toBeLessThan: (b) => assert.ok(a < b, `${a} < ${b}`),
});

// Built at runtime so no literal credential-shaped string sits in the repo.
const rnd = (n, abc = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") =>
  Array.from({ length: n }, (_, i) => abc[(i * 7 + 3) % abc.length]).join("");
const hex = (n) => rnd(n, "0123456789abcdef");

describe("redactSecrets — vendor token formats", () => {
  const cases = [
    ["GitHub", "ghp_" + rnd(36)],
    ["GitHub fine-grained", "github_pat_" + rnd(40)],
    ["OpenAI", "sk-proj-" + rnd(48)],
    ["Anthropic", "sk-ant-api03-" + rnd(60)],
    ["AWS key id", "AKIA" + rnd(16, "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")],
    ["Slack", "xoxb-" + rnd(12, "0123456789") + "-" + rnd(24)],
    ["Stripe", "sk_live_" + rnd(24)],
    ["Google API", "AIza" + rnd(35)],
    ["spacesheep", "ss_" + hex(48)],
    ["Telegram bot", "123456789:AA" + rnd(33)],
    ["JWT", "eyJ" + rnd(20) + ".eyJ" + rnd(30) + "." + rnd(40)],
    ["Hugging Face", "hf_" + rnd(34)],
    ["Pinecone", "pcsk_" + rnd(40)],
    ["npm", "npm_" + rnd(36)],
  ];
  for (const [name, tok] of cases) {
    it(`removes a ${name} token wherever it sits`, () => {
      const out = redactSecrets(`here you go ${tok} thanks`);
      expect(out).not.toContain(tok);
      expect(out).toContain(REDACTED);
      expect(out.startsWith("here you go ")).toBe(true);
    });
  }

  it("removes a whole private key block", () => {
    const pem = `-----BEGIN OPENSSH PRIVATE KEY-----\n${rnd(64)}\n${rnd(64)}\n-----END OPENSSH PRIVATE KEY-----`;
    const out = redactSecrets(`key:\n${pem}\ndone`);
    expect(out).not.toContain(rnd(64));
    expect(out).toContain("done");
  });

  it("removes a private key block that was cut off mid-paste", () => {
    const out = redactSecrets(`-----BEGIN RSA PRIVATE KEY-----\n${rnd(64)}`);
    expect(out).not.toContain(rnd(64));
  });
});

describe("redactSecrets — credentials by context", () => {
  it("keeps the user and host of a URL, drops the password", () => {
    expect(redactSecrets("psql postgres://admin:S3cr3t!pw@db.example.com:5432/app")).toBe(`psql postgres://admin:${REDACTED}@db.example.com:5432/app`);
  });

  it("env lines and config", () => {
    expect(redactSecrets("export DB_PASSWORD=hunter2")).toBe(`export DB_PASSWORD=${REDACTED}`);
    expect(redactSecrets('STRIPE_SECRET_KEY="abc123def456"')).toBe(`STRIPE_SECRET_KEY="${REDACTED}"`);
    expect(redactSecrets("api_key: 9f8e7d6c5b4a")).toBe(`api_key: ${REDACTED}`);
    expect(redactSecrets('{"password": "correct horse"}')).not.toContain("correct");
    expect(redactSecrets("client_secret=abcdEFGH1234")).toBe(`client_secret=${REDACTED}`);
    expect(redactSecrets("mysql -u root --password=Hunter2!")).toBe(`mysql -u root --password=${REDACTED}`);
    expect(redactSecrets("curl -H 'x-api-key: abcd1234efgh'")).toBe(`curl -H 'x-api-key: ${REDACTED}'`);
  });

  it("prose that hands over a password", () => {
    expect(redactSecrets("log in as admin, password Hunter2! then open settings")).toBe(`log in as admin, password ${REDACTED} then open settings`);
    expect(redactSecrets("the password is Tr0ub4dor&3")).toBe(`the password is ${REDACTED}`);
    expect(redactSecrets("my wifi password is `x9Kq-77aa`")).toBe(`my wifi password is \`${REDACTED}\``);
    expect(redactSecrets("set the password to Summer2026")).toBe(`set the password to ${REDACTED}`);
  });

  it("a secret in a query string, behind a scheme and other params", () => {
    expect(redactSecrets("open https://x.dev/cb?a=1&token=abcDEF123456&b=2")).toBe(`open https://x.dev/cb?a=1&token=${REDACTED}&b=2`);
    expect(redactSecrets("https://x.dev/?api_key=zz99yy88")).toBe(`https://x.dev/?api_key=${REDACTED}`);
  });

  it("an Authorization header", () => {
    const tok = rnd(40);
    expect(redactSecrets(`curl -H "Authorization: Bearer ${tok}" https://api.x`)).not.toContain(tok);
  });
});

describe("redactSecrets — leaves ordinary text alone", () => {
  const untouched = [
    "the password is wrong",
    "I reset my password yesterday",
    "passwords in plaintext in my sessions",
    "password: string;",
    "const password = hash(pw)",
    "password = form.password",
    "token: ${token}",
    "API_KEY=$OPENAI_API_KEY",
    "api_key: process.env.OPENAI_API_KEY",
    "max_tokens: 4096",
    "input_tokens=128k",
    "the token limit is 200000",
    "the token GITHUB_TOKEN needs repo scope",
    "commit 3350858 fixed it; sha 9f2c1e0a7b",
    "set your API key under Settings → API keys",
    "secret: <your-secret>",
    "token budget usage/cost",
    "the refresh token refreshToken is rotated",
    "https://spacesheep.dev/@misha/sessions-hooks",
    "a uuid 123e4567-e89b-12d3-a456-426614174000",
  ];
  for (const s of untouched) {
    it(JSON.stringify(s), () => {
      expect(redactSecrets(s)).toBe(s);
      expect(hasSecret(s)).toBe(false);
    });
  }

  it("is idempotent", () => {
    const once = redactSecrets("export DB_PASSWORD=hunter2 and password is Hunter2!");
    expect(redactSecrets(once)).toBe(once);
  });

  // The first cut found the secret word inside an identifier with a nested pattern
  // and never returned on "password_password_…"; these pin that it can't regress.
  const adversarial = [
    ["a long identifier of secret words", "password_".repeat(5000) + "=" + "a".repeat(5000)],
    ["secret words and spaces", "password ".repeat(20000)],
    ["a long whitespace run", "password" + " ".repeat(50000) + "is x"],
    ["an unterminated key block", "-----BEGIN RSA PRIVATE KEY-----" + "A".repeat(200000)],
    ["URL-ish noise", "postgres://" + "a:".repeat(20000)],
    ["a 200 KB session reply", ("Here is the fix. The api_key: ${KEY} stays in env, password is wrong, max_tokens: 4096. ").repeat(2500)],
  ];
  for (const [name, s] of adversarial) {
    it(`stays fast on ${name}`, () => {
      const t0 = Date.now();
      redactSecrets(s);
      expect(Date.now() - t0).toBeLessThan(500);
    });
  }
});

describe("redactDeep — what the hooks send", () => {
  it("redacts every string in a turn batch, leaving keys and numbers", () => {
    const body = { source: "codex", session_id: "019a-77", turns: [{ seq: 3, user: "use DB_PASSWORD=hunter2", assistant: "done", at: 1 }] };
    const out = redactDeep(body);
    expect(out.turns[0].user).toBe(`use DB_PASSWORD=${REDACTED}`);
    assert.strictEqual(out.turns[0].seq, 3);
    expect(out.session_id).toBe("019a-77");
  });
});
