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
# an agent declared `provider: "google"` reads GEMINI_API_KEY from .env instead

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

A role is a lock: every process in a run holds `data/run/<role>.pid` while it lives —
`liquen` the supervisor, `main` the mind. So there is one of each, whoever started it: a
REPL that finds no daemon raises a mind of its own, and `liquen start` over it refuses
rather than tail, fan out and mirror the same log twice. `liquen stop` ends the run, not a
process — the supervisor first, then anything still standing, an interface-raised mind
included — and waits for each lock to come free, so `liquen stop && liquen start` is safe to
say in one breath. `liquen update` puts the org on the newest release of the package: the
lock names the version every task runs, so the new code comes up at the next `liquen start`.

`./data/` is seeded from the package's `src/seed/` templates by the command that declares:
`liquen init` writes `data/system/` and `data/organization/` — what every agent reads — and `liquen
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

1. **One sitting at the console.** The door prints the prefill link and opens it (Slack
   builds the app from [`src/seed/slack-manifest.json`](./src/seed/slack-manifest.json),
   consent lists filled from `connections.slack`), then takes what the console shows,
   each paste empty to skip: the OAuth client, its signing secret (HTTP ingest only), the
   app-level token (xapp, the Socket Mode carrier), and a public redirect URI. *Install to
   Workspace* while you are there, and the flags take the tokens it issued:

   ```sh
   deno task connect slack app --bot --user   # xoxb → the org's shared identity, xoxp → your own leg
   ```

   Which carrier ingest opens is read off the vault: an app-level token is the socket, a
   signing secret is HTTP.

2. **Connect a member who is not at this terminal**: Slack redirects to https only, so this
   needs the public redirect URI from step 1 with a tunnel or a real host in front of
   `connections.slack.oauthPort`. The door prints a link that binds the grant to `[agent]`
   and is good for one sign-in; send it to them and the door waits until they finish:

   ```sh
   deno task connect slack user [agent]
   ```

3. **The connection runs under `deno task start`** — both halves in one process: Socket
   Mode (or HTTP) in, chat.postMessage out, tokens from the vault. A token landed through
   a door (1, 2) is picked up on the next start.

   The ingest is one webhook function either way — Socket Mode is just the local carrier;
   an edge deploy serves the same function at the app's Events API request URL.

### Any HTTP API

An agent reaches an API with the `fetch` binary on its PATH — curl's flags, `aread`'s
truncation, a status outside 2xx as a failure — and the credential never enters user
space: a vault row declaring `extra.env` and `extra.hosts` is fronted as a `mu-grant-…`
handle under that name in the agent's environment, and the egress proxy swaps it for the
live token on the way out, toward those hosts only. `fetch -H "Authorization: Bearer
$GH_TOKEN" https://api.github.com/user` is the whole of it. The GitHub doors above write
that row for GitHub; for any other API the `token` door writes one from a paste:

```sh
deno task connect token crm --env CRM_TOKEN --hosts api.crm.io,*.crm.io   # the org's
deno task connect token crm --env CRM_TOKEN --hosts api.crm.io --agent ana # one agent's own
```

`--probe <url>` spends the token once before writing, so a bad paste is refused rather
than stored; the grant is picked up at the next `deno task start`. A connector of the org's
own writes the same row for its service from its own door.

## Development

This repo is the package. An org runs a checkout instead of the registry by naming it in
its `deno.jsonc` — `"links": ["../liquen"]` — and every task follows.

```sh
deno task check   # fmt + lint + typecheck
deno task test    # all tests
deno task fix     # format + lint
deno task smoke   # live transport round-trip (credentials in .env)
```
