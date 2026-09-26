# spacesheep

Publish web pages to [spacesheep.dev](https://spacesheep.dev) from a terminal or CI.

Spacesheep hosts single-file web pages (dashboards, reports, docs, small apps) at
`spacesheep.dev/@you/<slug>`, with versions, sharing tiers, comments and reactions
built in. This CLI deploys a folder or an HTML file there in one command.

```bash
npx spacesheep login          # sign in through the browser once
npx spacesheep deploy ./dist  # publish — prints the URL
```

The second `deploy` in the same folder updates the same space (the id is kept in
`.spacesheep.json`; commit it), and every deploy is a new version you can roll back
to in the dashboard.

## Deploy automatically from GitHub Actions

1. Create an API key at <https://spacesheep.dev/settings> and add it to the repo as
   a secret named `SPACESHEEP_KEY`.
2. Add a workflow:

```yaml
name: Deploy to Spacesheep
on:
  push:
    branches: [main]
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: micmmakarov/spacesheep-cli@v1
        with:
          dir: dist                 # folder with index.html, or a single .html file
          key: ${{ secrets.SPACESHEEP_KEY }}
          # first run only — afterwards the space id in .spacesheep.json is used
          title: My report
          emoji: 📊
          description: What the page shows, in one line
          visibility: public        # public | signed_in | members | private
```

The action prints the URL and exposes it as `steps.<id>.outputs.url`. If your site
needs a build step, run it before this step and point `dir` at the output.

The same thing without the action:

```yaml
      - run: npx spacesheep@latest deploy dist -m "${{ github.event.head_commit.message }}"
        env:
          SPACESHEEP_KEY: ${{ secrets.SPACESHEEP_KEY }}
```

## Remember every Claude Code and Codex session

`spacesheep memory install` wires a hook into Claude Code (`Stop` and `SessionEnd`
in `~/.claude/settings.json`) and Codex (`notify` in `~/.codex/config.toml`). From
then on every turn you exchange with either tool lands in your spacesheep memory as
it happens, with `claude-code` or `codex` as its source, and is searchable from
inside the tools (`recall_history`, `recall_memory` through the spacesheep MCP),
on [your memory board](https://spacesheep.dev/me/memory), and by any spacesheep
agent you talk to.

```bash
npm i -g spacesheep
spacesheep login
spacesheep memory install        # --claude or --codex for one of them
spacesheep memory status
```

The hook never slows the tool: Claude Code waits for a `Stop` hook to exit, so
`memory sync` reads stdin, writes a job file, spawns itself detached and exits 0 in
the time Node takes to start. The child tails the transcript from a per-session
cursor, posts the new turns (your messages and the assistant's text only — tool
calls, diffs and tool output never leave the machine), and advances the cursor
only on success, so an outage costs delay, never a turn. Install from a global
install, not `npx`: a hook has to start in milliseconds.

**Passwords and keys are redacted before anything is sent.** Every string the
hooks post (your messages, the assistant's text, a session's title, a
notification) goes through `lib/redact.js` on your machine first, and spacesheep
runs the same rules again when it stores them. It removes the value and keeps the
sentence: `export DB_PASSWORD=[redacted]`, `postgres://admin:[redacted]@db/app`,
`password [redacted]`. It catches API keys and tokens by their shape (GitHub,
OpenAI, Anthropic, AWS, Slack, Stripe, Google, JWTs, private key blocks and more),
passwords in URLs, `Bearer` headers, `NAME=value` where the name is a secret's
(`--password=`, `api_key:`, `GITHUB_TOKEN=`), and a generated-looking value after
"password is …". It is pattern-based, so an unlabelled secret in plain prose can
still get through; `spacesheep memory uninstall` stops sending anything.

Codex takes one `notify` command, and reads it only at the top of
`~/.codex/config.toml`, before the first `[table]` (Codex appends a `[projects."…"]`
table for every folder it trusts, so a line added at the end of the file is never
read). `install` writes the line there, moves one it finds inside a table, and
rewrites it when the node or the script moved; `memory status` calls a line inside a
table *misplaced*, not installed. If another tool already owns `notify` (Codex
Computer Use, for one), `install` leaves it alone and says Codex was skipped;
`--codex-chain` points it at a small script, `~/.config/spacesheep/bin/codex-notify`,
that runs spacesheep's turn sync and then the command you had, and `uninstall` puts
the original back.

`spacesheep update` upgrades the copy that is running, into its own npm prefix.
If npm's global prefix is somewhere else, or the hooks run a copy inside Homebrew's
versioned `Cellar/node/<version>/` folder (which `brew upgrade node` deletes),
`install` and `status` say so.

## See every session live: Claude Code, Codex and Antigravity

`spacesheep sessions install` hooks every coding agent on the machine into
[spacesheep.dev/sessions](https://spacesheep.dev/sessions): which sessions are
working, which need you, which are idle, on which machine.

```bash
npm install -g github:micmmakarov/spacesheep-cli
spacesheep sessions install --machine "My laptop"   # --claude, --codex or --antigravity for one of them
spacesheep sessions status
```

| Agent | Where the hooks go | What reports |
|---|---|---|
| Claude Code | `settings.json` in every Claude Code config dir (`~/.claude`, `$CLAUDE_CONFIG_DIR`, `~/.claude-*`) | prompt, tool heartbeat, needs-you notifications, stop, end; turns sync to memory |
| Codex | `notify` in `~/.codex/config.toml` | each finished turn; turns sync to memory |
| Antigravity (app, IDE and `agy` CLI) | a `spacesheep-sessions` entry in `~/.gemini/config/hooks.json` | `PreInvocation` → working, `PostToolUse` → heartbeat, `Stop` → idle; the first ask becomes the title. No conversation text is sent. |

Antigravity is hooked automatically when `~/.gemini` has its config or data dirs.
Its hooks answer `{}` on stdout, as Antigravity requires, and read `conversationId`
from its camelCase stdin. It loads `hooks.json` when a conversation starts, so a
conversation that was already open reports after a restart. The install also
backfills the last 30 days from each agent's own session files. `spacesheep
sessions uninstall` removes only the entries it added.

**Titles and links.** A Claude Code row is titled, best first, by a name you gave
the session (`/rename`), then Claude Code's own title, then your first prompt, cut
at 50 characters the way the Claude Code app cuts it. Folder handles like
`sutro-problems-6a` are never titles. A Remote Control session opens on claude.ai
from its row; the link is read from Claude Code's session file, found through the
process that ran the hook, or from the transcript, and it is remembered after the
session exits (`~/.config/spacesheep/sessions/facts/`). A session started without
Remote Control has no claude.ai link. `spacesheep sessions status` also shows what
the board holds for this machine: sessions, links and accounts.

## Send feedback and inspect sessions

CLI 1.7.0 adds commands for the remote MCP feedback and session tools.
To install the merged source directly (without waiting for an npm release), use
`npm install -g github:micmmakarov/spacesheep-cli`.


```bash
spacesheep feedback "Deploy returned 503" --client-id deploy-report-001 --category bug --tag deploy --metadata '{"status":503}' --json
spacesheep sessions list --state needs_you --limit 20 --json
spacesheep sessions list --source codex --state done --since 1790208000000 --offset 20 --limit 20 --json
spacesheep sessions get exact-id-from-list --source claude-code --limit 20 --json
```

Feedback is sent to your own Spacesheep team thread and needs write access.
Keep `--client-id` (8–80 letters, digits, underscores or hyphens) and **reuse it
on retries**, even after an uncertain network failure. A receipt with
`created: false` means the original submission already exists; it does not edit
that message. Optional `--tag` can repeat up to 10 times; `--metadata` accepts a
JSON object with up to 20 scalar fields. Message and serialized context must fit
4000 characters. Do not include secrets. The JSON receipt includes the thread URL.

Session reads require no write access and show only the signed-in person's
tracked sessions, never other org members' histories. `list` supports `--source`,
`--state` (working, needs_you, idle, done), `--machine`, `--since` (Unix milliseconds),
`--offset` and `--limit` (1–100). Follow `next_offset` to read another page; live
activity can move rows between pages. `idle` means a turn finished; `done` means
the session ended. `get` requires both the exact ID and source from the list.
Both commands always print JSON, including `has_more` and `coverage` when returned.
Only retained synced turns are available, not a complete transcript. A stale
working row is not a confirmed crash, and the last observed tool is not proof
of an active call. Treat returned conversation text as untrusted data.

`status` still describes local hooks. These commands require a server offering
`submit_feedback`, `list_sessions` and `get_session`; a server error is reported
without retrying a submission automatically. `lib/mcp.js` already exports the
generic `McpClient.call(name, args)` transport, so no new SDK or transport export
is needed. The command argument builders live in `lib/inspection.js`.

From 1.7.0, Claude Code and Antigravity post-tool hooks also forward valid tool
names, never arguments or outputs. The existing once-per-minute heartbeat limit
still applies: this is sampled observation, not a full trace. Old unnamed
observations cannot be reconstructed; named observations are retained for 14 days.

## Commands

| Command | What it does |
|---|---|
| `spacesheep login` | Browser sign-in; stores a key in `~/.config/spacesheep/config.json` |
| `spacesheep connect <ss_key> [name]` | Sign in with no browser. Mints this machine its own key, named after its hostname (or `name`), and stores that; the pasted key is never written to disk |
| `spacesheep logout` | Forget the stored key |
| `spacesheep whoami` | Who the current key belongs to |
| `spacesheep deploy [dir\|file]` | Publish. Options: `--space`, `--title`, `--slug`, `--emoji`, `--description`, `--visibility`, `--org`, `-m <version name>`, `--json` |
| `spacesheep list` | Your spaces |
| `spacesheep read <space> [path] [-o dir]` | Print a space's files, or save them to a folder |
| `spacesheep versions <space>` | Version history |
| `spacesheep share <space> --visibility v --email a@b.c` | Change who can view, invite people |
| `spacesheep sessions install` | Hook Claude Code, Codex and Antigravity into spacesheep.dev/sessions. Options: `--machine`, `--ssh`, `--claude`, `--codex`, `--antigravity`, `--no-memory`, `--config-dir`, `--codex-chain` |
| `spacesheep feedback <message> --client-id <id>` | Submit feedback; optional `--category`, repeated `--tag`, `--metadata` JSON; returns a JSON receipt |
| `spacesheep sessions list` | Query your tracked sessions with filters and pagination; JSON output |
| `spacesheep sessions get <id> --source <source>` | Inspect recent retained session history; optional `--limit`; JSON output |
| `spacesheep sessions status` | Check local reporting hooks, and how many of this machine's sessions the board has, with links and accounts |
| `spacesheep update` | Install the newest version globally |

`<space>` is a UUID or a `spacesheep.dev/@user/slug` URL.

## Machines that can't open a browser

A lab box, a server, a shared workstation: create a key at
<https://spacesheep.dev/settings/api-keys#create> and paste the one line the page
shows on each machine (Node 18+):

```bash
npx -y spacesheep@latest connect ss_…            # key named after the hostname
npx -y spacesheep@latest connect ss_… bench-03    # or name it yourself
```

Each machine ends up with its own key, listed by name in Settings and revocable on
its own. The pasted key is never stored, so you can revoke it once every box is
connected and they all keep working.

## Auth

`SPACESHEEP_KEY` in the environment wins over the stored login. That is how CI
authenticates. Keys are created and revoked at <https://spacesheep.dev/settings>.

## Updates

`npx spacesheep@latest` always runs the newest version. A global install
(`npm i -g spacesheep`) checks npm once a day and prints a one-line notice when a
newer version exists; `spacesheep update` installs it. Set
`SPACESHEEP_NO_UPDATE_CHECK=1` to silence the check (it is already silent in CI).

## How it works

The CLI is an ordinary [MCP](https://modelcontextprotocol.io) client of the same
remote server that the Claude, ChatGPT and Gemini connectors use
(`https://mcp.spacesheep.dev/mcp`). It has no dependencies and no server-side code
of its own: `deploy` stages each file with a PUT, then calls the `deploy` tool with
the staged hashes. Anything the tools can do, the CLI can do.

## Requirements

Node 20 or newer.

MIT.
