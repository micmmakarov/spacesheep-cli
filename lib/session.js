// session: what is pushing this deploy — the agent session that ran the CLI, the
// account it ran under, the machine, the repo — sent as `session` on the deploy
// so the space's version history can say "Claude Code · this laptop · session …"
// and link back. Everything here is local (env vars, one small file read, two git
// calls): it must never make a deploy slower. Any piece that
// isn't there is left out; nothing here can fail a deploy. The git calls are
// async so deploy can start this beside the uploads and pay nothing for it.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

// One git process for branch + commit, one for the remote, in parallel.
async function git(cwd) {
  const run = (args) => new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 1500 }, (err, out) => resolve(err ? "" : String(out).trim()));
  });
  const [head, repo] = await Promise.all([run(["log", "-1", "--format=%h%n%D"]), run(["config", "--get", "remote.origin.url"])]);
  // "<short sha>\n<decorations>": the branch is "HEAD -> <name>"; detached has none.
  const [commit, refs = ""] = head.split("\n");
  if (!commit) return {};
  const branch = /(?:^|, )HEAD -> ([^,]+)/.exec(refs)?.[1];
  // An https remote can carry a token (https://user:TOKEN@host/…); never send it.
  return { repo: repo.replace(/\/\/[^/@]*@/, "//") || undefined, branch, commit };
}

async function collectSession(cwd = process.cwd(), env = process.env) {
  const s = { machine: os.hostname() };
  const extra = { cli: `spacesheep-cli/${require("../package.json").version}`, os: `${os.platform()} ${os.release()}` };

  if (env.CLAUDE_CODE_SESSION_ID || env.CLAUDECODE) {
    s.agent = "claude-code";
    if (env.CLAUDE_CODE_SESSION_ID) s.session_id = env.CLAUDE_CODE_SESSION_ID;
    // The account id only — ~/.claude.json also holds the email and profile.
    const acct = readJson(path.join(os.homedir(), ".claude.json"))?.oauthAccount;
    if (acct?.accountUuid) s.account_id = acct.accountUuid;
    if (acct?.organizationUuid) s.org_id = acct.organizationUuid;
    if (env.CLAUDE_CODE_ENTRYPOINT) extra.entrypoint = env.CLAUDE_CODE_ENTRYPOINT;
    if (env.CLAUDE_CODE_REMOTE_SESSION_ID) s.url = `https://claude.ai/code/${env.CLAUDE_CODE_REMOTE_SESSION_ID}`;
  } else if (env.CODEX_SESSION_ID || env.CODEX_HOME || env.CODEX_SANDBOX) {
    s.agent = "codex";
    if (env.CODEX_SESSION_ID) s.session_id = env.CODEX_SESSION_ID;
    // auth.json holds tokens; only the account id is read out of it.
    const home = env.CODEX_HOME || path.join(os.homedir(), ".codex");
    const id = readJson(path.join(home, "auth.json"))?.tokens?.account_id;
    if (id) s.account_id = id;
  } else if (env.GITHUB_ACTIONS) {
    s.agent = "github-actions";
    s.session_id = env.GITHUB_RUN_ID;
    if (env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID) {
      s.url = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
    }
    if (env.GITHUB_WORKFLOW) extra.workflow = env.GITHUB_WORKFLOW;
  } else {
    s.agent = "spacesheep-cli";
  }
  if (env.AI_AGENT) extra.ai_agent = env.AI_AGENT;

  Object.assign(s, await git(cwd));
  s.extra = extra;
  for (const k of Object.keys(s)) if (s[k] === undefined || s[k] === "") delete s[k];
  return s;
}

module.exports = { collectSession };
