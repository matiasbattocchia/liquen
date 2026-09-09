# mu — an org-level agent harness

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

First run seeds `./data/` from the package's `src/seed/` templates: the log, the agent's
workspace, and its docs (identity, org, memories — edit them, boot never overwrites).
`data/` is living state and stays out of git; `src/seed/` is the org definition at birth.

## Knobs

Every knob lives in `config.jsonc` at the project root (the catalog — init
materializes it, the system never writes it; comments document each key). Env is for
secrets only. The org is where you run mu; `--dir <path>` names it from anywhere else.

## Connections

### GitHub (dev-tier: `gh webhook forward`)

```sh
deno task connect github     # app / bot / user doors → the vault (secrets live there)
deno task start              # every declared connection: webhook receiver → the log, replies → gh api
gh webhook forward --repo=you/repo \
  --events=issue_comment,pull_request,pull_request_review_comment \
  --url=http://localhost:8788/
```

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
   deno task connect slack app    # client id + secret (what the OAuth door serves from)
   deno task connect slack bot    # bot token (xoxb) + app-level token (xapp) for Socket Mode
   ```
3. **Serve the OAuth door** and put a synchronous proxy in front (cloudflared in dev —
   an async webhook relay can't carry the 302):

   ```sh
   deno task oauth:slack        # /oauth/slack/start + /callback on :8790
   ```

4. **Share the door**: give members `https://<public>/oauth/slack/start` however you like
   (paste it in a channel). Everyone — the admin included — connects their personal leg
   through it; installing was the workspace leg only.
5. **Run the connection** (both halves, over the shared `./data` root):

   ```sh
   deno task start             # both halves in one process: Socket Mode (or HTTP) in,
                               # chat.postMessage out (tokens from the vault)
   ```

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
