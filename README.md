# liquen — an org-level agent harness

Each org member (a **principal**) gets an AI **agent** that acts for them over a shared
event log — CLI today; Slack/WhatsApp next. Design: [DESIGN.md](./DESIGN.md) · roadmap:
[PROJECT.md](./PROJECT.md) · agent-driven install: [SKILL.md](./SKILL.md).

## Run an org

Requires [Deno](https://deno.com) ≥ 2. An org is a folder: `config.jsonc` declares it,
`data/` is its living state, `.env` its secrets, and `deno.jsonc` names the package
(`@liquen/liquen`) every task runs.

```sh
# 1. the org, and your agent on its roster
deno run -A jsr:@liquen/liquen/init myorg && cd myorg
deno task agent <you>

# 2. credentials — one of:
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .env   # a Console API key
ant auth login                             # or platform OAuth (then NO key line in .env, not even empty)

# 3. talk to your agent
deno task repl
```

In the REPL: type to your agent · `/y [note]` / `/n [reason]` answer approval cards ·
`/quit` exits.

`liquen <task>` is `deno task <task>` said from anywhere inside the org — `liquen start`,
`liquen agent ana`, `liquen --dir ~/myorg status` from outside it. The command holds no
code of its own, so the package that runs is always the one the org's `deno.jsonc` pins:

```sh
deno install -g -A -n liquen jsr:@liquen/liquen/liquen
```

`./data/` is seeded from the package's `src/seed/` templates by the command that declares:
`liquen init` writes `data/system/` and `data/organizations/` — what every agent reads — and `liquen
agent <name>` writes that agent's workspace, `data/agents/<name>/`, with the instruction
file that says who they are and a memory to write the next by. So the words are on disk to
edit before anything runs. A first run adds what only a run can make (the log, the CA and
its bundle, the file shims) and seeds whatever is missing — a roster entry typed into
`config.jsonc` by hand gets its home then. Nothing seeded is ever overwritten, and nothing
is seeded into a folder that already exists — delete a doc you do not want and it stays
deleted; delete the folder to ask for the set again. Docs are read fresh every turn, so an
edit lands on the agent's next turn without a restart.
`data/` is living state and stays out of git; `src/seed/` is the org definition at birth.

## Knobs

Every knob lives in `config.jsonc` at the project root (the catalog — init
materializes it, the system never writes it; comments document each key). Env is for
secrets only. The org is where you run liquen; `--dir <path>` names it from anywhere else.

## Connections

A connect door refuses a grant nobody is listening for: a granted service delivers from
that second on, and a delivery that finds no door is dropped by everyone. So the org runs
first — `deno task start` — and the doors run against it. On a fresh org the first door
declares its connection in `config.jsonc` and waits while you restart `start` in the
other terminal, so it can go on in the same run.

### GitHub (dev-tier: `gh webhook forward`)

Two identities, either alone enough to start: the org's, which every agent falls back to,
and an agent's own, which posts under that person's name. The smallest setup is one paste
and no GitHub App at all:

```sh
deno task start                               # webhook receiver → the log, replies → gh api
deno task connect github user --org --token   # a machine user's token → the org
gh webhook forward --repo=you/repo \
  --events=issue_comment,pull_request,pull_request_review_comment \
  --url=http://localhost:8788/
```

An App buys three things a paste cannot: an org token minted hourly with nothing static
stored, deliveries the ingest can verify, and a device flow that signs a person in without
a secret crossing the terminal.

```sh
deno task connect github app     # App ID + .pem + (optional) webhook secret, client id/secret
deno task connect github bot     # its installation → the org
deno task connect github user    # the device flow → your own leg
```

Every door closes by naming what the org still owes, and `--help` explains each option.

### Slack (bring-your-own app, per org)

1. **Create the app** — print the prefill link and open it (creates the app in your
   workspace, pre-configured from [`src/seed/slack-manifest.json`](./src/seed/slack-manifest.json);
   edit the `redirect_urls` placeholder to your public host first):

   ```sh
   deno eval "console.log('https://api.slack.com/apps?new_app=1&manifest_json=' +
     encodeURIComponent(await (await fetch(
       'https://raw.githubusercontent.com/matiasbattocchia/liquen/main/src/seed/slack-manifest.json')).text()))"
   ```

2. **Install it** (admin, once): *Install to Workspace* on the app page → the workspace
   leg. Then paste the pieces into the vault:

   ```sh
   deno task connect slack bot      # bot token (xoxb) — the org's shared identity
   deno task connect slack socket   # app-level token (xapp) — the Socket Mode carrier
   ```
3. **Connect your own leg**: installing granted the workspace only; each member's user
   token (xoxp, *OAuth & Permissions → User OAuth Token*) is pasted through their door:

   ```sh
   deno task connect slack user [agent]
   ```

4. **The connection runs under `deno task start`** — both halves in one process: Socket
   Mode (or HTTP) in, chat.postMessage out, tokens from the vault. A token pasted through
   a door (2, 3) is picked up on the next start.

   The ingest is one webhook function either way — Socket Mode is just the local carrier;
   an edge deploy serves the same function at the app's Events API request URL.

## Development

This repo is the package. An org runs a checkout instead of the registry by naming it in
its `deno.jsonc` — `"links": ["../liquen"]` — and every task follows.

```sh
deno task check   # fmt + lint + typecheck
deno task test    # all tests
deno task fix     # format + lint
deno task smoke   # live transport round-trip (credentials in .env)
```
