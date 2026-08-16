# PROJECT — the roadmap to a working implementation

Companion to [DESIGN.md](DESIGN.md) (the what and why); this file tracks the arc (the
when). Status as of 2026-08-12 (Slack live, both directions, model in the loop).

## v0.0 — one agent, files, CLI (the "it's alive" milestone)

### Done — the spine, all tested (69)

- `store/` — log (publish/read/subscribe/lock, multi-process, store-owned uuidv7 ids), id
  (uuidv7 generator), docs (progressive disclosure; 2026-08-04: one discovery rule — a doc
  is a frontmattered .md, recursive, kind in frontmatter, on the `system/·org/·agents/`
  layout), lock (a `locks` row in the log's DB, steal-reporting TTL), agents (the registry:
  `agents/` folders declare — the framework way — and `syncAgents` mirrors the table at
  start; REPL principal = OS username, name-matched to its agent, auto-created on first
  run; later: N:M principals↔agents, autonomous agents)
- `render` — Schema B, no-turns boundary derivation, weld, docs cascade
- `mu(input, transport)` — the pure step; `transport` — the model edge (Anthropic today;
  the layer another provider adapts in). Chain: main → xi → nu → mu
- `nu` — the turn (render → mu w/ backoff → stamped events, `meta.stop` on the last)
- `xi` — short-lived invocation: `decide` once (think | act | ignore) from one window,
  lockless ignore, steal-sweep, gates, send/search; a turn ends with ONE atomic
  publish+release, so the wake it fires never finds the lease held
- `main` (2a) — the process: holds the subscriptions and nothing else — each agent tails
  the log through its own policy-scoped port (2026-08-01: `policy.ts`, the RLS seam —
  `scoped(log, {readable, writable})`: reads filter before the window limit, writes are
  WITH-CHECKed all-or-nothing, delivery itself is filtered à la Realtime; defaults
  allow-all until the connections map). No poke payload, no queue; the turn lease is the
  concurrency control, and it lives in the store. Keeps only the in-flight set, so
  teardown can await it
- `cli` (2b) — the line REPL over the log: stdin → principal message; streamed
  deltas (text live, thinking dim); tool/send/error lines; approval cards with
  `/y` / `/n`. Run: `deno task cli` (env: `MU_DIR`, `MU_MODEL`,
  `ANTHROPIC_API_KEY` via `.env`).
- `exec/` — the exec plane (DESIGN §9, from the pi / Agent-SDK study): `bash`
  tool (workspace cwd, 120s default timeout, merged output, tail-truncation
  2000 lines/50KB with full output persisted to `.out/`, non-zero exit →
  is_error, ungated by design) + `aread`/`awrite`/`aedit` binaries (one `afs.ts`
  source, PATH shims in `{dir}/bin`; head-truncated paging read, stdin write,
  conflict-marker multi-edit with exact→fuzzy matching, BOM/CRLF preserved).
  Installed by main by default; `rg`/`fd` come from the image, not from us.

### Remaining for a working v0.0

- ~~Live smoke~~ **done (2026-07-20)** — transport round-trip + tool cycle live; full
  CLI conversation: think → bash(awrite+aread heredoc) → act → closing reply, verified
  against the log and the workspace. Caught and fixed one real-API render bug:
  `mid_conv_system` blocks are only valid in TRAILING position — separators and error
  markers are now plain text blocks; `sys()` is reserved for the `now:` anchor.
- ~~Seed docs~~ **done (2026-07-20)** — `store/seed.ts` installs the cascade
  write-if-absent at boot: `harness/instruction/principal.md` (the machine contract,
  memory hygiene baked in), org + agent placeholders, one lazy example memory. Live
  verified: identity honesty, memory writing (one fact per file, frontmatter, deletes
  the placeholder), style adaptation.
- ~~Compaction~~ **done (2026-07-20)** — the checkpoint layer (`src/compact.ts`, from
  the pi study): `summary` event with `covers: [from, to]`; xi runs a bare checkpoint
  mu call — the checkpoint IS the turn (nu decides; the summary's insert wakes the
  displaced think) when the visible window outgrows `compactAt` (default 150K est.
  tokens — the API's server-side trigger; `keepRecent` ~20K uncovered); iterative merge folds the previous summary;
  render drops covered events and leads with the checkpoint. Pruning was already
  render's closed-region collapse.

- **World render as XML** (2026-08-13) — a formatter review of the multi-conversation
  window (2 WA DMs + a 3-sender group + Slack DM + channel) found the old
  `## service · peer` line derived its header from the *sender*, shredding groups into
  per-person headers, hiding channel identity, ignoring `kind`, and leaving every mark
  forgeable in plain Markdown (a peer's body could fake a principal line). Rework (§5):
  world messages render as `<conversation service id kind name>` elements of `<msg from
  at>` lines — inbound runs ts-sort then partition per conversation; the agent's sends
  join their element as `from="self"`; `&`/`<`/`"` escaping makes forged tags inert, so
  plain user-role text is by construction the narrator or the principal (home stays the
  ordinary user/assistant chat — plain, separated from the tagged world). Delivery
  failure became visible the same pass: permanent dispatch failure stamps
  `envelope.status = failed` (setDelivery; store already round-trips `status.state`) and
  the line renders `status="failed"`. Element `name` is empty until ingest stamps it:
  `conversation.name` exists end to end (type, store column, render attribute) — the
  connector just never fills it. Stamping the group subject / #channel name is a
  connector task (whatever lookup/cache it takes lives below the frontier).
  Follow-up (2026-08-13): renamed wire coordinates to `address` (`connection_address`,
  `conversation.address`, `sender.address` — `id` reserved for store pkeys, matching the
  store's columns); the element is `<conv>` and carries the FULL envelope: every non-null
  `Conversation` field (`address`, `kind`, `name`, `thread`) plus `connection`. Addresses
  went bare the same pass (§3): a Slack channel is `C123`, a GitHub issue `owner/repo#42`;
  dispatchers route on `envelope.service` and target with `connection_address` +
  `conversation.address`; `external_id` stays prefixed (the store-wide merge key). The
  sanitizer is deliberately hand-rolled (`escText`/`escAttr`, three substitutions): we
  only EMIT XML, never parse it, so escaping-on-encode is the entire surface — a closed,
  exhaustively-testable rule, no dependency.

- **Prompt-cache breakpoints on the conversation — LANDED 2026-08-11**: the request now
  carries three marks, not one. The system prefix (already there), the **closed/trailing
  boundary** (collapsed history: written once, then read forever), and the **last block
  before the anchor** (the live tool chain, which only grows while a turn runs). Caching is
  opt-in per breakpoint — nothing is cached without a `cache_control` mark, so the whole
  conversation was previously re-sent at full price on every tool round-trip. Transport
  needed no change (it passes `params` straight through) and `metered()` already recorded
  `cache_read_tokens`/`cache_write_tokens`, so the effect was measurable immediately.
  Measured on a 5-round-trip task: fresh input pinned at **84 tokens** (the anchor alone)
  for every request after the first, 9316 input tokens → **1834 billed-equivalent, 80%
  saved** — and the ratio improves with turn length, so a 19-tool bench task gains far
  more. Two invariants this rests on, both now tested: a `<conv>` element must not span the
  boundary (trailing messages joining it would rewrite the prefix's last block), and the
  chain appends across round-trips because each re-entry is a NEW step — `weldOrder` only
  groups uses-before-results *within* one turn (parallel calls), which is a single request
  anyway. A mid-turn message landing out of order costs a miss, i.e. a normal write.

- **Media, both directions — LANDED 2026-08-11** (plan of 2026-08-13, implemented as
  written, plus a request-level inline budget: 12MB raw NEWEST-first across the trailing
  region, so an attachment burst can't outgrow the API request cap — older files keep
  their markers; and per-file 3MB. Slack ingest downloads via org token → any authorized
  grant's token → env; dispatch uploads via `files.getUploadURLExternal` +
  `files.completeUploadExternal` with the text as `initial_comment`, best-effort ts from
  the share for the echo merge — absent, the echo lands as its own row. Deliberately NOT
  echo-deduped by content; revisit if live dupes annoy. Same day: `uri` is a real URI —
  `file://` local (canonical), `http(s)://` external, passed through untouched (no
  broker fetch/upload; `size` nullable). External images/PDFs reach the model as
  url-source blocks — the API fetches them itself, budget-free; Slack dispatch folds
  links into the text (unfurl), WhatsApp will pass them natively. Same day, the
  model-initiated half: `aread` on a bytes file → `MEDIA_MARK` sentinel → bash peels it
  into `ExecOutcome {output, files}` → FileParts on the tool_result event (generic; the
  transport shapes provider blocks) → render inlines them inside the tool_result
  content — the aread-a-picture loop, Claude Code's Read pattern.) Original plan:
  1. *Types*: `FilePart` already exists (open-bsp shape: `kind: MediaKind`, `file:
     {mime_type, uri, name?, size}`, `text?` caption) — `uri` becomes a LOCAL path; no
     new types.
  2. *Storage*: conversation-scoped, `${MU_DIR}/conversations/<safe(address)>/media/
     <content-hash>.<ext>` — content-named so re-downloads and the echo are idempotent;
     `safe()` = the address hashed/slugged for the filesystem. (Alternative flat
     `media/` rejected: the conversation dir is already the §8 conversation scope.)
  3. *Receive*: the connector downloads BROKER-side with its credential (Slack
     `url_private` + bearer; WA decrypt) and publishes the message with the FilePart
     pointing at the local path — the platform URL+token never cross the frontier (§9).
  4. *Render (the Anthropic side)*: inside the `<msg>` a media part renders as a
     `<media kind name path/>` marker (escaped like everything else); for images/PDFs in
     the TRAILING region render ALSO appends a real Messages-API content block after the
     element (`{type: "image", source: {type: "base64", …}}` / document block) — the
     model SEES the picture, not a filename. Closed region keeps only the marker (the
     tool-pair collapse pattern: heavy blocks are recent-only, the path is the durable
     handle the agent can re-view via `aread`/bash).
  5. *Send*: `send` gains optional `files: string[]` (workspace/media paths); same gate;
     the dispatcher uploads broker-side (Slack `files.uploadV2`, WA upload) and
     backfills `external_id` so the echo merges as today.
  6. *Anthropic mechanics*: SDK base64 image/document blocks, size-capped; no Files API
     initially (requests stay self-contained; only trailing carries weight).
  7. *Tests*: ingest writes file + part; render marker + trailing block + closed-region
     drop; dispatch upload; media echo merge.

- **Behavioral bench** (2026-07-20) — `deno task bench` (Terminal-Bench methodology:
  instruction + fresh org + programmatic check over log/workspace/docs state; Sonnet-tier,
  ~1min, 9 tasks: greet, file, memory, gate-approve/deny, truncation, burst, world,
  compaction). First runs found + fixed two real bugs: the **coalescing race** (messages
  landing between window-read and closing-publish were swallowed → `meta.consumed`
  horizon on closings, honored by owed/render/compaction) and a **render 400** (final
  user turn left empty by the race shape). Also hardened the memory format via a
  concrete example in the seed contract.

- **Terminal-Bench adapter** (2026-07-20) — `bench/tbench/` (Harbor `BaseInstalledAgent`,
  pi's pattern): headless task mode (`src/task.ts`, `deno task compile:task` → one
  binary: harness + transport + afs multi-call), uploaded per trial. First 16-task run
  on Sonnet 5: **11/16 (69%)** vs Claude Code + Sonnet 5 at 74.6% on the full 89-set.
  Findings fed back: timeout alignment (exit before the outer harness kills), the
  **stall-retry poke** (error-idle after an API outage burned a task; task mode now
  re-pokes bounded), and doc-index completeness assertions (killed self-discovery probes:
  greeting = 0 tool calls). A second cycle (pass-side trajectory audit → fix) found two
  more harness bugs: the **fresh-shell cd tax** (model re-cd'd every call → sticky cwd via
  a pwd sentinel that also preserves the real exit code) and a **background-pipe hang** (a
  detached `cmd &` held the stdout pipe open forever, hanging the call → pump-via-readers,
  wait for bash's own exit, grace-flush, cancel). Net: three tasks flipped fail→pass
  (mailman, configure-git-webserver, write-compressor), projected **~25/32 (78%)** —
  in/above the Claude Code + Sonnet 5 band (74.6%) at ~1/7th the cost (~$39 vs $288).
  Capability gap remaining: **no image/vision path** (chess-best-move, gcode-to-text
  unwinnable; arrives with v0.2 media).

v0.0 is **feature-complete**. Remaining before calling it: a long-session live smoke
(exercise compaction against the real model) and general hardening as usage reveals it.

- **Store → SQLite (done).** The event log moved off a JSONL file to embedded SQLite
  (`node:sqlite`, in the runtime → survives `deno compile`), behind the same store port.
  This subsumed the old "log growth" hardening item (indexed reads, no scan/segment-rotation),
  and brought the idempotency index, updatable delivery bookkeeping, and privacy-filter-at-
  source for free — all reimplementations the flat file would have needed by hand. Same port,
  so mu/nu/xi/main were untouched; only `store/log.ts` changed. Small jump to the Postgres
  substrate (both SQL). See DESIGN §9 "Storage ports & backends".
- **First connector (done, v0.1 preview).** GitHub, both halves, open-bsp shape:
  - **Ingest** (`connect/github.ts`) — portable webhook function: receive → verify HMAC → map →
    publish; injected `publish`, edge-portable; `deno task ingest:github` (fed by
    `gh webhook forward`). Cross-process wake (ingest → SQLite log → a `main` subscriber) is
    functionally tested.
  - **Dispatch** (`connect/github_dispatch.ts`) — subscribe → the agent's outbound `gh:owner/
    repo#N` sends → post via injected `post` (the `gh` CLI locally, holding the scoped write
    token *outside* the agent's context; a `fetch` on edge). `deno task dispatch:github`.
  - **Dedupe/echo/edits are the store's** — one mechanism: the flattened `events` table
    upserts on `external_id` (`json_patch` merge, the open-bsp trigger). The ingest stamps the
    artifact id (comment/review) or the delivery guid; dispatch backfills the posted comment id
    via `setDelivery` — so a retry, an edit, or our own comment looping back all MERGE (no new
    row, no wake). If the echo wins the race, `setDelivery` absorbs the echo row into the
    outbound one — so `selfLogin` (author-based skip) is fully retired; the ingest is
    authorship-blind. The in-memory `Dedupe` is gone.
  - **Flattened schema** (2026-07-24): every queried scalar a column (`*_address` naming,
    `agent_id`/`session_id`, `timestamp`/`created_at`/`updated_at`), `payload` + `status` JSON;
    append order = implicit rowid. See DESIGN §9 storage.
  - **Privacy-at-source mechanism** landed in the store (`read({conversations})` → `WHERE IN`;
    2026-08-01: `ReadQuery.filter` — a row predicate applied BEFORE `limit`, RLS `USING`
    semantics — which `policy.ts`'s `scoped()` pins per agent).
  - Still open: wiring the readable pushdown to the connections map (the scope that fills
    `conversations`).

## v0.1 — Slack + the org shape

5.5. **Connections + policy — LANDED 2026-08-05**: `connections` (`service, address,
   shared, owner_kind?, owner_id?`) + `memberships` (open-bsp's `conversations_agents`,
   address-keyed) in log.db; `policyFor` = the three-branch predicate (membership ∨ shared
   ∨ owned; the mind is a one-member conversation — privacy is plain membership), LIVE via
   read-through prepared statements (no snapshot-at-boot, no restart on bind); local =
   team chat (visible iff member; `send` to an agent's name → `dm:<sorted>` + both ends
   enrolled); derived for folder agents, explicit principals stay allow-all.
   `mu connect` LANDED for Slack 2026-08-12 (`deno task connect:slack`): the PASTE door —
   prefill link (user-only manifest: the bot leg is not required and only breeds the
   wrong-token paste) → dashboard install → **Reinstall to Workspace** (the manifest
   declares user scopes; only re-consent GRANTS them — the one step that actually tripped
   the first live run) → paste xoxp (TTY prompt or piped stdin) → shape guard (`auth.test`
   vouches for a bot token too, returning the BOT's user id: binding it as a principal
   would poison the identities map) → `auth.test` resolves the workspace (a token string
   never identifies one) → the same three map writes as the oauth door, but bound to the
   REAL registry name (OS username), so the classifier and the alter-ego dispatch resolver
   light up. Paste = local/dev tier; the hosted oauth door = org tier (one shared link, N
   principals). Still open: `--bot` / `--agent <name>` / `--shared` connect options (bot
   paste via `auth.test` on xoxb; per-agent apps for per-agent bots — one bot per
   app×workspace, a reinstall only rotates); ingest carrier per vaulted app token (the
   blob's `app_token` field is populated; today the entry still reads one SLACK_APP_TOKEN
   env);
   WhatsApp pairs by QR/code locally, by code through the mind remotely; SSH+REPL is the
   remote steering door.

6. **The identities map for real** — table LANDED 2026-08-05 (`identities(service,
   address, owner_kind, owner_id)` beside the registry; `conversation.kind` column too).
   Setup/management (2026-08-06): the oauth callback WRITES the map (workspace anchor +
   identity binding + vault legs; test-pinned), `deno task status` inspects it (secrets
   redacted), and oauth types against the official `OauthV2AccessResponse` (the open-bsp
   lesson). Messaging half LANDED 2026-08-12: ingest/dispatch on `@slack/types` /
   `ChatPostMessageResponse`; `channel_type` stamps `conversation.kind`; the sender handle
   classifies through `identity()` (wire id stays honest, resolved name + `meta.slack.
   identity` ride along); memberships MIRROR the wire — join/leave events move rows
   (`deleteMemberships`: a leave is a revocation, policy is live) and each event's
   `authorizations` passively enrolls bound identities; dispatch picks the author's xoxp
   (alter-ego) before the org bot. Live-verified end to end 2026-08-12 (item 7).
   **The mind-alias — LANDED 2026-08-12** (§4 "self-talk is special"): a
   principal-identified conversation (WA self-chat, Slack self-DM) maps to AND from the
   mind by **COPY, never rewrite** — an event with the right envelope must exist in the
   log to be dispatched, and the wire original stays honest where it landed. One
   broker-side component, `connect/mirror.ts` (`deno task mirror`), two rules: fan-in
   copies an alias inbound into `mind:<agent>` (provenance in `extra.via`; the agent
   wakes on it like a REPL line); fan-out CCs **every mind event the REPL shows** to
   every binding except the origin surface — the voice as `[agent] …` (a
   self-conversation renders both speakers as the principal; the tag is the surface's
   only input/output distinction), tool calls as redacted
   one-liners under a tag of their own (`[agent tool] bash(git status)`), and the principal's own
   words as `[you via whatsapp] …` (input replayed as output; fan-out over fan-in's own
   copy is what cross-syncs surfaces, and a REPL line CCs everywhere as `[you via repl]`).
   Every crossing line opens with WHO — one tag shape, no quoting.
   Each CC is an ordinary outbound event: the dispatchers post it unchanged and the
   platform echo merges by its own `external_id` — no per-surface delivery rows needed.
   Fan-in guards the echo on both sides of that merge: it settles (`settleMs`, default 1s)
   and re-reads before copying, so an echo the backfill absorbs copies nothing (the
   小-window one layer up); and when the backfill NEVER comes (a dispatcher that crashed
   between posting and stamping, a Slack file share that returned no `ts`), the same words
   sitting on a CC that still has no `external_id` identify the echo as ours — the mirror
   stamps that CC (`claimMs`, default 60s), which absorbs the echo exactly as `setDelivery`
   would have. Measured before the guard existed: with two alias surfaces the slip is not a
   duplicate but a runaway — each phantom copy fans out to the other surface, echoes again,
   and the mind grew 1 → 23 messages in ten seconds with the quoting nesting (`> > …`).
   Bindings (`log.aliases()`; `aliasOf` matches envelopes on the workspace root, so
   events anchored to the team/bot still hit the grant's binding) are DERIVED where
   platform structure gives them away and RECORDED where the id is opaque: an owned WA
   connection's self-chat IS its own address — nothing stored (don't record the
   derivable); the Slack paste door resolves the
   self-DM via `conversations.open` on the granting user's own id (no listing, no
   pagination — supersedes the `conversations.list` plan; the oauth door doesn't bind
   yet, backlog) and records it as `extra.self_conversation` on the grant row. Hiding is POLICY (§6): the alias conversation is invisible to its own
   agent, reads and writes alike — the copies are its face in the window, the world
   render never sees the surface, and `send` can't reach the principal. NO BACKFILL:
   the mirror tails live; only the REPL reads the log. The REPL paints alias-borne
   principal lines as `[via slack]` and stays silent on CC plumbing. Not mirrored v0:
   permission cards, edits/deletes of already-copied messages, mirror-downtime gaps.
   **Minds are user-scoped — decided 2026-08-12**: self-talk on an owned connection is
   the ONLY alias source. The declared-handle × shared-connection derivation (org-number
   DM as the principal's mind) was REJECTED on the secretary counterexample: a shared
   account has other humans behind it — the secretary holding the org WA would see the
   mind's traffic and could write into it as a third participant; those DMs are world
   conversations the agent serves. Explicit bindings (a `mu alias` door — what Teams'
   1:1 bot chat would need) deferred until wanted. Side fact for the CLASSIFIER (not
   aliases): Slack ids never need declaring — grants carry them (`auth.test`); an
   ungranted principal could resolve by declared email via `users.info` /
   `users.lookupByEmail` (`users:read.email` scope) if bot-tier recognition ever wants
   it.
   **The resource-shaped tables — LANDED 2026-08-13** (the recap that killed identities):
   agents and connections are RESOURCES, and every table is either mirrored-from-files or
   written-by-flows, never hand-edited. (a) `agents` absorbed `config.json`: columns
   `provider · model · effort · email · phone`, mirrored at start (model/effort override
   MainConfig defaults and reach the transport — test-pinned; malformed config or unknown
   effort fails the boot loudly). (b) `connections` reduced to `(service, address,
   shared, agent_id?, meta?)`: `agent_id` = the owner, `meta` = discovered account facts;
   upsert PRESERVES absent agent_id/meta (a door writes what it knows); the paste door
   now OWNS the workspace row (`agent_id` + `meta.user`). (c) `identities` DISSOLVED:
   declared handles are agents columns, discovered bindings are the connection's
   ownership edge, and the log.db migration folds old identity rows into connections
   before dropping the table. (d) the vault dropped `kind`:
   key `(service, connection, owner_id)`, secret a service-shaped JSON BLOB
   (`{token, app_token}` — "store the app token with every slack connection credential");
   `put` merges fields so no door clobbers another's; creds.db migrated in place (tokens
   folded per owner, table dropped) with the live xoxp+xapp verified readable. Parked
   from the same recap: an **`acl` table** (actor × resource × action — agents AND
   connections are the resources), mirrored from an org-level config.json into POSIX
   ACLs on workspaces and broker checks at the frontier — `shared` is its degenerate
   "everyone" row until then; identity at the broker door via unix socket + SO_PEERCRED
   when multi-user lands.
   **Slack legs — LANDED 2026-08-14** (the beast dissolved): a Slack user grant is its
   own connection, addressed `<team>:<user>` (the connector splits on `:`); the bot leg
   is the bare `<team>`. Ingest reads the leg a delivery arrived through off
   `authorizations` (`user_id` + `is_bot`) and stamps it as the event's anchor, so the
   two judgment flags of the tables refactor closed structurally: the oauth door now
   writes each principal's OWN owned row (no shared anchor to fight over, no sidecar
   binding), and branch-2 visibility is per-leg (an owned leg's events are exactly what
   that leg's token saw — owner-sees-all is the account view by construction).
   `meta.user` gone (the address carries the user); classifier = split + ownership;
   passive mirror = any delivery on an owned leg enrolls it; join/leave mirror only the
   leg's own user (others' churn is their legs' fact). "One connection = one credential"
   now holds for Slack: the leg's blob is `{token, app_token}`, the bot's `{token}` at
   the bare team; dispatch resolves author's leg → team bot → env. The identities-fold
   migration mints leg rows directly (old identity addresses WERE leg addresses); the
   live db was rewritten in place (1 connection, 11 events, 2 memberships, 1 credential
   re-anchored — policy-visibility and token resolution verified post-move).
   **Ownership is the privacy switch + the vault is KV — LANDED 2026-08-14** (corrects
   the entry above: deliveries are per APP, not per grant — one app on a workspace is
   ONE socket, one copy, `authorizations` listing every grant; the "per-surface delivery
   rows for ingest visibility" open is RETRACTED — what survives of that need is the
   outbound mind-alias fan-out only). The batch: (a) `shared` column dropped — ownerless
   ⇒ the org's shared inbox, owned ⇒ private, no live row ⇒ membership-only (acl refines
   later; the open-bsp "never infer shared" lesson retired with its premise — the
   ownerless-but-private anchor row no longer exists as a shape). (b) The anchor rule
   per delivery: bot can read it → the shared pipe (bare `<team>`), only a grant can →
   that grant (`authorizations`/`is_bot`) — a personal DM never anchors to the shared
   pipe even with a bot coexisting. (c) Classifier = sender grant-row point lookup (any
   sender classifies); passive mirror enrolls EVERY bound authorized user from the one
   copy. (d) **The publish gate**: a non-local event on an unregistered (or
   soft-deleted) connection is REFUSED at publish — registration is what opens the log;
   grant notes anchor to the grant they register. (e) **Soft-delete + revive** on
   connections (`deleted_at`; closes the GATE only — visibility over ingested history
   persists, so a revocation never empties a session's window; upsert revives,
   ownership preserved). (f) **The vault is a key:value store in log.db** — one substrate, own
   accessor (never rides the scoped Log): `(key, value, agent_id?, extra)`, value the
   mergeable secret blob; keys by connector convention (`slack:<team>:<owner>`,
   `slack:<team>:org`); `connections.credential_key` points at them; creds.db folded in
   and removed. (g) `meta`/`extra` split: payload.meta = harness correlation
   (turnId/stop/consumed), `events.extra` = wire-derived sidecar (json_patch-merged;
   `extra.slack` slimmed to `{subtype, authorizations}` — team/channel/ts/owner were
   already on the envelope). (h) Column standards: `created_at` datetimes everywhere
   (`usage.ts` renamed; integer clocks keep their names — `locks.born`,
   `oauth_states.born`), `updated_at` only where updates exist, `extra` the one JSON
   catch-all. **The anchor is the workspace** (corrected 2026-08-15): an event's
   `connection_address` is the bare `<team>`, inevitably — a delivery is authorized for
   MANY grants, so no single user address can be its connection (the per-delivery
   grant-anchor rule above is retired, and with it the anchor arbitrariness and the
   `<conv>` attribute flicker). Both doors register the workspace row (the gate's
   admission); grant rows `<team>:<user>` remain the identity/credential map;
   memberships enroll under the workspace, and SHARED follows the bot (same day): the
   bot's own grant row `<team>:<bot user>` (ownerless + org `credential_key`) IS the
   shared inbox and anchors bot-witnessed deliveries; a personal-only workspace leaves
   the bare `<team>` as a STUB — gate admission, membership-only visibility — and each
   connect flow enrolls its principal in the grant-note conversation so the note
   reaches them. Simplifying assumption (same day): **a workspace runs in one mode** —
   bot installed ⇒ no personal grants, personal grants ⇒ no bot. A belief about
   reality, NOT enforced by code: the per-delivery anchor handles a mixed workspace
   gracefully anyway, and mixed-workspace privacy design (bot channels vs personal
   DMs on one team) is simply not carried as an obligation.
   **No in-code migrations pre-v1** (decided 2026-08-15): the system is not
   in production and carries one deployment — schema changes converge the live db by
   hand (or regenerate) and the code ships clean DDL only; the guarded-ALTER chains
   were deleted and the last old-shape residue (meta.slack in pre-refactor events)
   hand-moved to `extra`. Deferred from the same pass: local as a real team chat (a
   conversations table — agents chatting is the missing piece). The mind-alias
   aliasing question resolved 2026-08-12: neither rewrite nor read-time — COPY
   (the landed entry in item 6).
   **Memberships soft-delete — LANDED 2026-08-11**: a membership is a lifetime, not a
   flag. A channel leave stamps `deleted_at` (first stamp wins); `isMember` takes the
   event's `ts`, so a left row keeps granting events up to the stamp — agents keep
   what they have seen, lose the conversation's future, and can't post into it (one
   predicate, both sides). A rejoin revives the row — the conversation whole again,
   join-shows-history. No `ts` (a bare probe) asks about NOW: live rows only. Live db
   converged by hand (`ALTER TABLE memberships ADD COLUMN deleted_at`).
7. **Slack connection** — **built (2026-07-25), LIVE SMOKE PASSED 2026-08-12**, end to
   end on a real workspace, model in the loop. The walk: `connect:slack` (user-only
   manifest → dashboard install → **reinstall to consent** → paste `xoxp`) wrote anchor +
   identity + vault leg; `ingest:slack` over the socket carrier classified an inbound
   self-DM (`sender.name = matias`, the classifier verdict in meta), stamped `kind: direct` from
   `channel_type: im`, and enrolled the principal from `authorizations` — the membership
   map filled itself from traffic, nobody wrote a row; the REPL agent then took a turn,
   emitted `send`, parked on the gate, and on `/y` `dispatch:slack` posted with the
   AUTHOR's xoxp (no bot token exists anywhere in this org — the post itself proves the
   alter-ego resolver), backfilled the `ts`, and the socket echo MERGED into the agent's
   own row. Both directions, one row per artifact. The run also demonstrated the
   dollhouse unplanned: the principal was chatting from Slack while the REPL ran, and the
   agent answered those messages in the mind — one agent, two surfaces, one log.
   Bug it caught: `send` hardcoded `local/agent` as the outbound envelope, so a Slack
   reply was stamped local (delivered anyway — dispatch filters on the id prefix — but the
   row lied to connection-scoped policy). Patched by copying the anchor off the
   conversation's latest visible event — settled 2026-08-13 as the design (DESIGN §2):
   the denormalized envelope on the conversation's events IS its record, so the log is
   the authority on a conversation's coordinates; the scoped read bounds anchoring by
   visibility; a never-seen address is first contact (the §5 address-book open).
   Three portable
   pieces over the shared store, all edge-shaped `(Request) => Response` functions:
   - `connect/slack_oauth.ts` — `/start` (stable shareable door, one-time state per click)
     + `/callback` (exchange → xoxb as org×workspace, xoxp as principal×workspace, principal
     bound from the Slack-verified `authed_user`; grant crosses the frontier as a log
     event). `store/credentials.ts` is the broker store (tokens keyed by the owner matrix +
     one-time oauth states). BYO-app per org: `seed/slack-manifest.json` + the prefill link
     in the README (admin installs = workspace leg; everyone OAuths for their personal leg;
     promotion is the admin's, human, job — the log is the frontier, DESIGN §4).
   - `connect/slack.ts` — the ingest as ONE webhook function (Events API: challenge,
     signing-secret verify + replay guard, map → publish; `external_id =
     slack:<team>:<channel>:<ts>` so retries/edits/echo merge). **Socket Mode is a thin
     local carrier feeding the same handler** — the edge tier drops the carrier and serves
     the function at the app's request URL.
   - `connect/slack_dispatch.ts` — subscribe → outbound `slack:` sends → `chat.postMessage`
     (token resolver: the author's xoxp when the vault holds one, else the org bot —
     dispatcher-internal, §4) → backfill `ts` via `setDelivery` (echo merges; no
     author-based skip).
8. **`mu init` (DX)** — JSR-published init scaffolding the surface (seed docs, config,
   `main.ts`, Dockerfile, template `AGENTS.md` for agent-driven customization); core as
   `jsr:@mu/core`. DESIGN §9 "Distribution (DX)".
9. **Docker image per org** — main + connections, env-var config, volume for the data
   dir. The deploy story.
10. **Alarms / the scheduler** — the periodic poke. Its FIRST job is the liveness floor
   (§2): any poke does whatever the log owes, so a heartbeat self-heals every stranded
   obligation — a holder that dies mid-turn. (The self-inflicted case, a wake bouncing off
   our own lease, is closed by `publishAndRelease`.) Digests and delays come after. Open:
   what event type carries a wake that must *inform*, since an alarm only re-derives what's
   owed (§9), and `control`→abort as a log query at tool boundaries.

## v0.2 — WhatsApp + maturity

10. **WhatsApp connection** — **LIVE since 2026-08-12** (paired +5491133585694 →
    `matias`, phone-code flow; ~28k messages / 434 conversations imported as
    `extra.backfill`). The live test drove the schema settlement (2026-08-16, all
    landed): the typed `payload` column (action · refs · turn keys — DESIGN §3), UTC
    in the store + org-config timezone at render, org `config.json` defaults,
    edits/deletes as first-class events, ReactionPart both directions (Slack reaction
    ingest was simply missing), the `<edit>`/`<del>`/`<react>` render elements, and
    two bridge fixes with live body counts: phone-pairing died at ~2 min (the QR
    channel's timeout), and receipts NEVER merged — self receipts (the phone reading
    the peer's messages) minted ids with our own address as author segment, 811 ghost
    stubs against 303 merges before the fix. Pending: live receipt-merge verification
    (needs organic traffic), the Slack `self (principal)` grant lookup, merge-only
    drafts still INSERT stubs for unknown referents (deferred), and a send-tool
    surface for the model to author reactions.
11. **Background completion** — early-return for long tools and the **non-blocking
    gates** fix parked in DESIGN §10; `escalation` as its first instance.
12. **Postgres substrate** — the same ports as SQL: events table + LISTEN/NOTIFY (log),
    advisory lock, RLS as the readable filter, per-row trigger invoking `handle`. The
    verdict-before-acquire race guard (fresh re-read) is already in place for this
    world.
13. **Egress proxy with header injection** (decided 2026-08-03, deferred — DESIGN §9
    credential-delivery rungs): THE one credential rung for everything — the sandbox never
    holds token material, the proxy IS the egress allowlist, and it normalizes outbound
    auth (strips sandbox-supplied headers, so smuggled credentials are unusable). Plus
    secret quarantine at ingest (pasted tokens → creds.db, a reference in the log).

## The honest framing

After 2b, nothing structural remains — the machine is complete and every later item is
either a capability (bash, compaction), a connection (Slack/WA), or a substrate swap
(Postgres) behind ports that already exist. The riskiest unknown left is not code but
behavior: how the model actually drives the three channels (think/assistant/send) once
real traffic hits it — which is exactly what 2b + the live smoke will show.
