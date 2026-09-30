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
to in the dashboard. If the folder now holds a different page (its `<title>` changed),
`deploy` stops rather than replace the old one: pass `--space <url>` to update it
anyway, or `--new` to publish the page as a new space. GitHub Actions skips that check.

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
| Antigravity (app, IDE and `agy` CLI) | a `spacesheep-sessions` entry in `~/.gemini/config/hooks.json` | `PreInvocation` → working, `PostToolUse` → heartbeat, `Stop` → idle; the first ask becomes the title. From 1.16.0 its `Stop` also runs `memory sync --source antigravity`, which sends each finished turn (the words inside `<USER_REQUEST>` and the model's `PLANNER_RESPONSE`) to your memory — unless you installed with `--no-memory`. |

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
Remote Control has no claude.ai link. An Antigravity row opens its own conversation
in Antigravity's web remote (`antigravity.google.com/r/<install>-v2?p=c/<conversation>?section=<project>`);
the project is the one in `~/.gemini/config/projects/` whose folder holds the
session's workspace. With no such project, or for a backfilled row until its next
hook fires, the link opens the remote's home. `spacesheep sessions status` also shows what
the board holds for this machine: sessions, links and accounts.

**Test runs stay off the board.** From 1.17.0 each Claude Code ping carries whether a
person attended the session, as Claude Code itself tells its hooks
(`CLAUDE_CODE_SESSION_ATTENDED`). A `claude -p` another session launched, say to check
that the hooks fire, reports "no", and when it was over within a minute on one turn the
board files it under **Hidden** instead of listing it. Anything else can be hidden by
hand from its row, and comes back once you use it again.

## Talk to a session from its page

On Pro and Team, a space's **Session** tab lets you message the coding session that
published it. The session only hears you while it runs a listener, which it has to
start itself:

```bash
spacesheep talk on               # your account's switch, and this machine's opt-in
spacesheep talk listen           # one JSON line per message (run it under Monitor)
spacesheep talk reply "done"     # answer in the Session tab
```

Sessions are told they can listen in two places. After `spacesheep deploy`, when
Talk is on and the session isn't listening yet. And, with `spacesheep sessions
install`, at the start of every Claude Code session on a machine that ran `talk on`.
Both notes are fixed text written by the CLI. The server's words never reach the
agent's context: the deploy note reads only whether the server set `talk`, and the
session id comes from the local environment. Neither note starts a listener; the
agent decides, under its own permission rules. Turning Talk on from the website
doesn't enable the start-of-session note on any machine, so a stolen web session
alone can't open a channel into every session you run.

## Let spacesheep.dev reach this machine

`spacesheep machine on` (1.21.0) runs one small listener in the background, so you
can message any Claude Code session on this machine from
[spacesheep.dev/sessions](https://spacesheep.dev/sessions), or start a new one in a
folder you allowed, from your phone or another computer. It replaces the listener
each session had to start for Talk. Pro and Team.

```bash
spacesheep machine on --folder ~/code/app --folder ~/code/site   # no --folder: the current folder
spacesheep machine status
spacesheep machine off
```

**Your passkey, checked here.** `on` prints a six-digit check and opens a pairing
page that shows the same digits; you confirm there with your passkey (Touch ID, Face
ID, a security key). The machine verifies the page's answer itself before it trusts
the passkey, and from then on every message has to be signed with it: through a
24-hour unlock (one Touch ID a day, kept by the page) or a fresh tap for one message.
The machine checks those signatures against the passkeys it paired with at its own
terminal, so a stolen web login, or the server itself, can't make it run anything.
`spacesheep machine pair` adds another device's passkey.

**What a message does.** It runs `claude -p` in the session's own folder, which the
machine reads from the session's transcript on its own disk (never from the server),
and only when that folder is inside one you allowed. A session that is open in a
terminal right now is never written to: the message goes to a copy
(`--fork-session`), and later messages follow the copy. The reply lands in the
session's thread on the page. Two run at once at most, and messages to one session
run in order. Each message reaches Claude Code behind a fixed line, written by the
CLI, saying it came from spacesheep.dev and your passkey confirmed it.

**Safe or auto.** Nobody is at the machine to approve a prompt, so:

- `--mode safe` (the default) runs Claude Code in `dontAsk` mode: what your
  permission rules already allow runs, anything that would ask is declined, and the
  reply names the tools that were.
- `--mode auto` runs it in Claude Code's own `auto` mode, which decides what is safe
  to run without asking.

Neither skips permissions. Re-running `on` adds folders or changes the mode, and
restarts the listener. It runs as a launchd agent on macOS and a systemd user service
on Linux (anywhere else, keep `spacesheep machine run` open in a terminal), logs one
line per event to `~/.config/spacesheep/machine.log`, and stays down once it stops on
purpose: the machine removed on the site, or Talk turned off. `spacesheep machine off`
stops it, tells spacesheep.dev, and deletes the passkeys it trusted, so nothing that
could run a command stays behind. On a machine with the listener, new sessions are no
longer told to start their own Talk listener.

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

## Back up every session

`sessions get` is a look at one session (turns capped at 4,000 characters, 100 at most).
For a copy you keep, `sessions export` (1.20.0) writes every session, complete:

```bash
spacesheep sessions export -o ~/backup/spacesheep            # → ~/backup/spacesheep/sessions/
spacesheep sessions export -o ~/backup/spacesheep --since $(( $(date +%s) * 1000 - 86400000 ))   # only the last day
spacesheep sessions export --zip sessions.zip                 # keep the archive as one file
```

`sessions/index.md` lists every session; `sessions/<harness>/<start day>-<session id>.md`
is one session — where it ran, how to resume it, what it was for, and its whole synced
thread (a long one continues in `.part-2.md`, `.part-3.md`…). The same folder the daily
Google Drive backup writes. File names are stable, so a `--since` export writes over the
last one. It is the MCP tool `export_sessions`: a one-hour, read-only link to one zip.

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
| `spacesheep deploy [dir\|file]` | Publish. Options: `--space`, `--new`, `--title`, `--slug`, `--emoji`, `--description`, `--visibility`, `--org`, `-m <version name>`, `--json`. A folder's `.spacesheep.json` pins it to one space; if `index.html`'s `<title>` no longer matches the page the pin last published, deploy stops and asks for `--space` (update it anyway) or `--new` (a new space). |
| `spacesheep list` | Your spaces |
| `spacesheep read <space> [path] [-o dir]` | Print a space's files, or save them to a folder |
| `spacesheep versions <space>` | Version history |
| `spacesheep share <space> --visibility v --email a@b.c` | Change who can view, invite people |
| `spacesheep sessions install` | Hook Claude Code, Codex and Antigravity into spacesheep.dev/sessions. Options: `--machine`, `--ssh`, `--claude`, `--codex`, `--antigravity`, `--no-memory`, `--config-dir`, `--codex-chain` |
| `spacesheep feedback <message> --client-id <id>` | Submit feedback; optional `--category`, repeated `--tag`, `--metadata` JSON; returns a JSON receipt |
| `spacesheep sessions list` | Query your tracked sessions with filters and pagination; JSON output |
| `spacesheep sessions get <id> --source <source>` | Inspect recent retained session history; optional `--limit`; JSON output |
| `spacesheep sessions export [-o DIR]` | Every session, complete, into `DIR/sessions` (a backup). `--since MS` for only recent ones, `--zip FILE` to keep the archive, `--json` |
| `spacesheep sessions status` | Check local reporting hooks, and how many of this machine's sessions the board has, with links and accounts |
| `spacesheep machine on` | Let spacesheep.dev reach this machine's Claude Code sessions: pairs your passkey here and starts the background listener. Options: `--folder` (repeatable; default the current folder), `--mode safe\|auto`, `--name`, `--no-service` |
| `spacesheep machine status \| pair \| off` | Check the listener; add another passkey; stop it and forget the passkeys it trusted |
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
