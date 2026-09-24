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

Codex takes one `notify` command. If yours is already set, `install` leaves it
alone and prints the line to add to a wrapper script.

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
