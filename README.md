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

## Commands

| Command | What it does |
|---|---|
| `spacesheep login` | Browser sign-in; stores a key in `~/.config/spacesheep/config.json` |
| `spacesheep logout` | Forget the stored key |
| `spacesheep whoami` | Who the current key belongs to |
| `spacesheep deploy [dir\|file]` | Publish. Options: `--space`, `--title`, `--slug`, `--emoji`, `--description`, `--visibility`, `--org`, `-m <version name>`, `--json` |
| `spacesheep list` | Your spaces |
| `spacesheep read <space> [path] [-o dir]` | Print a space's files, or save them to a folder |
| `spacesheep versions <space>` | Version history |
| `spacesheep share <space> --visibility v --email a@b.c` | Change who can view, invite people |
| `spacesheep update` | Install the newest version globally |

`<space>` is a UUID or a `spacesheep.dev/@user/slug` URL.

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
