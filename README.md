# mu — an org-level agent harness

Each org member (a **principal**) gets an AI **agent** that acts for them over a shared
event log — CLI today; Slack/WhatsApp next. Design: [DESIGN.md](./DESIGN.md) · roadmap:
[PROJECT.md](./PROJECT.md) · agent-driven install: [SKILL.md](./SKILL.md).

## Run the REPL

Requires [Deno](https://deno.com) ≥ 2.

```sh
# 1. credentials — one of:
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .env   # a Console API key
ant auth login                             # or platform OAuth (then NO key line in .env, not even empty)

# 2. verify the machine (no key needed)
deno task check && deno task test

# 3. live transport smoke (optional)
deno task smoke

# 4. talk to your agent
deno task cli
```

In the REPL: type to your agent · `/y [note]` / `/n [reason]` answer approval cards ·
`/quit` exits.

First run seeds `./data/` from the `seed/docs/` templates: the log, the agent's
workspace, and its docs (identity, org, memories — edit them, boot never overwrites).
`data/` is living state and stays out of git; `seed/` is the versioned org definition.

## Knobs

Every knob lives in `data/config.jsonc` (the catalog, materialized on first boot — edit
values there; comments document each key). Env is for secrets only. Task mode is the one
exception left: `MU_MODEL` · `MU_EFFORT` (env, pending the same treatment).

## Connections

### GitHub (dev-tier: `gh webhook forward`)

```sh
deno task ingest:github      # webhook receiver → the log (set GITHUB_WEBHOOK_SECRET)
deno task dispatch:github    # agent replies → gh api (uses your `gh` auth)
gh webhook forward --repo=you/repo \
  --events=issue_comment,pull_request,pull_request_review_comment \
  --url=http://localhost:8788/ --secret="$GITHUB_WEBHOOK_SECRET"
```

### Slack (bring-your-own app, per org)

1. **Create the app** — print the prefill link and open it (creates the app in your
   workspace, pre-configured from [`seed/slack-manifest.json`](./seed/slack-manifest.json);
   edit the `redirect_urls` placeholder to your public host first):

   ```sh
   deno eval "console.log('https://api.slack.com/apps?new_app=1&manifest_json=' +
     encodeURIComponent(await Deno.readTextFile('seed/slack-manifest.json')))"
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
   deno task ingest:slack      # SLACK_APP_TOKEN set → Socket Mode; else HTTP (Events API)
   deno task dispatch:slack    # agent replies → chat.postMessage (bot token from the store)
   ```

   The ingest is one webhook function either way — Socket Mode is just the local carrier;
   an edge deploy serves the same function at the app's Events API request URL.

## Development

```sh
deno task check   # fmt + lint + typecheck
deno task test    # all tests
deno task fix     # format + lint
```
