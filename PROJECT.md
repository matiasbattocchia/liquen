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
  `/y` / `/n`. Run: `deno task cli [agent]` (org in `./data`; knobs in
  `org/config.jsonc`; `ANTHROPIC_API_KEY` via `.env`).
- `exec/` — the exec plane (DESIGN §9, from the pi / Agent-SDK study): `bash`
  tool (workspace cwd, 120s default timeout, merged output, tail-truncation
  2000 lines/50KB with full output persisted to `.out/`, non-zero exit →
  is_error, unasked by the default rule table) + `aread`/`awrite`/`aedit` binaries
  (one `afs.ts` source, PATH shims in `{dir}/bin`; head-truncated paging read, stdin write,
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
  plain user-role text is by construction the narrator or the principal (the mind session
  stays the ordinary user/assistant chat — plain, separated from the tagged world). Delivery
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

- **A transcript inherits the attention of its note — LANDED 2026-08-28**: found live. A new
  contact sent a voice note at 14:40; asked about it, the agent read `<audio/>`, said "te
  aviso cuando esté" and closed. The words landed at 14:44, correctly and on time — and then
  sat there, because to the ladder they were ambient news in a room the agent held no floor
  in, due at the next digest 13 minutes out. The principal then wrote "ok" at 14:56; the
  agent woke in 2s (rung 1 works), read the transcript, answered `<|SILENCE|>` — and that
  silent turn, being an own-voice closing at home, reset the last look and pushed the world
  another 15 minutes. Fix: a transcript is not new news, it is its note becoming readable, so
  it wakes once the note is behind the last look and never counts as a second arrival in the
  depth (§2). The other half of what the incident showed is DELIBERATE and stays: a turn that
  answers `<|SILENCE|>` still spends the whole world's digest clock, because it still read
  the whole window — the look is what the clock measures, not the output, and one look sees
  every conversation (§2). What the agent still lacks is any notion of a **debt**: "te aviso
  cuando esté" bought no attention, so the turn that finally read the words was free to drop
  the promise. Watching it before building anything; the scheduler (§10) is the obvious
  answer if it recurs — an undertaking to come back should arm the agent's own alarm.

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
     its kind's element (`<image name path/>` — escaped like everything else); for images/PDFs in
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
   app×workspace, a reinstall only rotates); ingest carrier per vaulted app token (landed 2026-08-25 with `mu connect slack bot`);
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
   broker-side component, `connect/mirror.ts` (a subscription main holds), two rules: fan-in
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
   "everyone" row until then; identity at the broker door is the per-agent socket's path,
   filesystem-enforced when multi-user lands (§9 the door).
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
     one-time oauth states). BYO-app per org: `src/seed/slack-manifest.json` + the prefill link
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
10. **Alarms / the scheduler** — **LANDED 2026-08-28** (both halves). The liveness floor is
   main's tick: any poke does whatever the log owes, so a heartbeat self-heals every
   stranded obligation. The scheduler proper is the `timers` table + the `schedule` tool +
   alarms that inform — see the entry below. Still open: `control`→abort as a log query at
   tool boundaries.

## v0.2 — WhatsApp + maturity

10. **WhatsApp connection** — **LIVE since 2026-08-12** (paired +5491133585694 →
    `matias`, phone-code flow; ~28k messages / 434 conversations imported as
    `extra.backfill`). The live test drove the schema settlement (2026-08-16, all
    landed): the typed `payload` column (action · refs · turn keys — DESIGN §3), UTC
    in the store + org-config timezone at render, org `config.json` defaults,
    edits/deletes as first-class events, ReactionPart both directions (Slack reaction
    ingest was simply missing), action-attributed `<msg>`/`<reaction>` rendering, and
    two bridge fixes with live body counts: phone-pairing died at ~2 min (the QR
    channel's timeout), and receipts NEVER merged — self receipts (the phone reading
    the peer's messages) minted ids with our own address as author segment, 811 ghost
    stubs against 303 merges before the fix. **Mentions — LANDED 2026-08-17**: the
    bridge owns the wire namespace both directions, so mu only ever sees canonical
    addresses (DESIGN §3). A lid-addressed chat (Communities, the LID rollout) names
    people by an opaque per-account id instead of their phone — inbound the bridge
    rewrites the inline `@digits` token and the mention list to canonical, outbound
    `encodeMentions` maps back through `Store.LIDs`, choosing the namespace from
    `AddressingMode` learned free off inbound traffic (`GetGroupInfo` only for a
    never-seen group). Before this, an outbound `@Euge` in a lid group both failed to
    bind AND published a phone number into a chat whose addressing exists to hide it.
    mu's ingest just names what arrives: `@<digits>` → `@<pushname>`. Pending: live
    receipt-merge verification (needs organic traffic) and merge-only drafts still INSERT
    stubs for unknown referents (deferred).
    **References — LANDED 2026-08-17**: `ref_external_id` was ingested and never rendered,
    so a fifth of live WhatsApp traffic (119 reactions against 550 events in 48h) reached
    the model as glyphs pointing at nothing, and replies lost the relationship entirely.
    Every `<msg>` now wears an `id` and every referring line a `re` (DESIGN §5) — one
    handle both ways, since `send(re:)` takes it back and `send(react:)` lands a glyph on
    it. `xi.referent` resolves the handle against the conversation's recent rows: unknown,
    ambiguous, and not-yet-on-the-wire all throw into the model's own tool_result rather
    than answering the wrong message. WhatsApp dispatch already spoke both (quote +
    reaction content); Slack gained `thread_ts` for a reply and `reactions.add/remove` for
    a glyph — with the emoji-name translation Slack requires, and a `failed` stamp when it
    can't name one, because the reaction leg used to drop such sends silently.
    **Mutations — LANDED 2026-08-18**: `send(action:)` completes the vocabulary the window
    renders — `edit`, `delete`, `remove` — so the model can write back everything it can
    read. xi refuses to edit or delete anything the account did not author (a wire would
    accept the stanza and ignore it). Slack: `chat.update`/`chat.delete`. WhatsApp: the
    bridge gained data kinds `edit` and `revoke` over `BuildEdit`/`BuildRevoke`, and the
    reaction content moved to the DataPart shape `openbsp.go` always expected — mu had been
    sending `type: "text", kind: "reaction"`, which the bridge's text case posted as an
    emoji quoting the target, so outbound WhatsApp reactions were text replies until now.
    Unreportable: WhatsApp ignores an edit past its 20-minute window (the tool description
    says so; the wire says nothing).
    **The window's clock — LANDED 2026-08-18**, the last thing between here and live
    WhatsApp: ingest ran for six days with the agent off, so the log holds ~1.8k live rows
    nobody answered (`extra.backfill` covers the July pairing import and nothing else —
    these arrived off the wire in real time). The boot read was count-bounded only, so the
    first turn would have opened on 500 events / 44 hours / 32 conversations, all of it
    unanswered and therefore owed. `since` bounds the read in event time — the agent comes
    up owing `backlogHours` of history and nothing older: 24 by default, `org/config.json`
    for the deployment, `MU_BACKLOG_HOURS` for one run (2 is the first-live-test value).
    A CUTOFF, not a rolling window (2026-08-18 call, after watching a rolling one): main
    resolves it once at start into a fixed instant, so what the agent inherited is settled
    when it comes up instead of being re-decided on every read. Under live traffic the
    500-event cap binds first anyway — 500 events reach back ~100 minutes of a busy
    WhatsApp account, so the hours are a boot policy and the count is the bill. Search
    still reaches everything outside both.
    **Names on every message — LANDED 2026-08-18**, found by asking whether the agent could
    search the conversation with a given contact. It could not, and the query was the lesser
    half of why: names reached mu only through the batch `contacts`/`groups` feeds, cached in
    the ingest process, so a name existed only for whoever had spoken since the last restart
    — `conversation_name` was set on **0 of 364** WhatsApp DMs and 25 of 72 groups, and that
    contact's 77 messages carried no name on any row. Meanwhile the bridge's own whatsmeow
    store held 2,378 contacts, 1,050 with address-book names, his among them. So the bridge
    now stamps `sender_name`/`conversation_name` on every message (`pickName`: address book
    → live pushname → stored pushname → business name; a DM is named by its peer, a group by
    its subject, and the account's own rows need no name), history import included; the
    ingest prefers the message's names and keeps the feeds as fallback. Then `search`'s
    `in`/`from` resolve a name to addresses (DESIGN §6). No contacts table — deliberately:
    the name rides the row that needed it, and open-bsp's own consumer keeps the entity
    version through the same `contacts` feed, which still flows.
### Open from the live run (2026-08-18) — found by driving it, none of them loud

The first session where the agent sent to a real contact (a birthday message, then a 🎂
on it via `re`). Both landed; he answered with a reaction and two lines. What that
exposed, worst first — all three fail SILENTLY, which is why they are written down
rather than left to be noticed:

- **The gate answers from any surface — LANDED 2026-08-18**, the first thing this run
  broke. `permission_request` crossed to nothing (`mirror.ccParts` returned null for
  "permission plumbing") and only the REPL could publish a `permission_response`, so a
  principal steering from WhatsApp watched `[agent tool] send(→ …)` scroll by, never saw a
  prompt, and every send stalled with no sign of why — indistinguishable from being
  ignored. Now the card crosses as `[agent asks] approve <tool> <args>` carrying the
  arguments (approving IS judging what will be said) plus the reply syntax, and xi reads
  `/y [note]` · `/n [reason]` off the principal's own line and publishes the verdict
  before it reads one — one invocation settles and acts. It went in xi, not ingest (where
  DESIGN §3 had parked it): xi already derives which cards are open, so every surface gets
  the same mechanism and the REPL's key handling becomes a shortcut rather than the only
  road. Disambiguation is the principal's, not ours (2026-08-18 call): a bare `/y` settles
  the ONE open card, several waiting means they quote the one they mean. The quote had to
  survive the mirror too — the fan-in copy dropped `ref_external_id`, which is the only
  record of what they pointed at.

  Who speaks when a verdict settles nothing took two tries. Letting `decide` think while
  gates wait cost a real duplicate: the model, seeing its own unresolved `tool_use`,
  re-issued both sends (17:50:32 cards → bare `/y` → 17:51:01 a second identical pair). The
  HARNESS answers instead, on an `error` the mirror carries — ambiguity ("N waiting, quote
  the one you mean") and, since the same run produced two look-alike pairs on his phone, the
  newer-and-dead case ("that one was already answered"). Both are said ONCE: the latest
  principal line is re-read on every wake, so a line counts as spent when a verdict OR a
  harness word follows it — without that the phone got the same complaint three times in
  three minutes.
- **The gate stopped blocking — LANDED 2026-08-18.** The duplicate above was the symptom;
  the disease was that asking produced no `tool_result` at all, so the only safe verdict
  while a card waited was to ignore EVERYTHING, principal included. Live, that read as a
  dead agent: two cards open at 17:50 and nothing he said for the next forty minutes got an
  answer. The fix is to make asking part of executing — `act` publishes the card AND
  answers the call with `{status: pending_approval}` in the same batch. The chain closes,
  the mind stays free, and the reason for the mute is gone.
  - The verdict is a second, later call: `owedOf` finds asks that have been ruled on but not
    run, xi runs them, and the outcome comes back as a `tool_result` carrying
    `payload.deferred` — the record keeps its `ref_id`, but render narrates it
    (`[system] send(to: Vivian) → sent`) instead of welding a second block onto a pair
    that is already spent. The mirror carries the same sentence to whoever approved it. It
    collapses with the rest of the tool traffic at the boundary, which answers his "at some
    point the async result should be removed too".
  - What is still waiting moved to the ANCHOR (his line: "pending gate isn't history, it's
    state. State belongs in the anchor"). It self-corrects — an ask that gets answered stops
    being listed — and each line carries the ask's id (`shortId`, the `re` vocabulary),
    the handle `cancel(id)` takes.
  - Policy became DATA: `Rule[] = [{tool, ask}]`, `gateOf(rules)`, default `send` asks and
    `*` does not. `gate ?? ((name) => name === "send")` was a special case living in code,
    and there are no special tools (2026-08-18 call) — bash goes unasked because a rule says
    so. Asking from inside execution is also what makes a rule able to be CONDITIONAL
    (arguments in hand: bash on a destructive command), and the table is the home
    `/always` · `/never` has been waiting for (`scope: "always"` exists in the type; only
    reading the table from org/agent config is left).
  - One rendering per tool, finally: `describeCall` (+ optional `ExecTool.describe`)
    replaced three divergent versions — `redact()` in the mirror, the card's
    `JSON.stringify(input).slice(0, 200)`, and what the anchor would have grown. Default is
    `name(k: v, …)`, with a single-string-argument call printing bare (`bash(git status)`)
    so bash needs no override; `send` supplies `to: <name | address>` (his call: name first,
    address the fallback). Two verbosities — the bounded line for traces and the anchor, the
    full form for the card, because approving is judging what will actually be said.
- **Ids the wire mints go through ONE namespace — LANDED 2026-08-18.** The bridge
  canonicalized the chat and sender of a message ROW
  (`conversationAddressFor`/`senderAddressFor`) but not the segments of the ids it built
  around one, so on a LID-addressed chat every id came out under the lid and matched
  nothing mu had stored from the other side. Three symptoms, one cause: his 😂 arrived
  with `ref_external_id = wmw.…230480930730172.…` against our stored
  `wmw.…15613518605.…` (same stanza, unmatchable) so render showed `re="?"`; no
  delivery/read receipt ever merged onto a message we sent; and — the expensive one — a
  quoted `/y`·`/n` from his phone pointed at a card mu could not find, so the gate dropped
  his verdict without a word. `chatSegment()` now supplies the chat segment of every id the
  bridge mints or parses (message ids, quoted refs, reaction refs, protocol-message
  originals, receipts, the history import), resolving through `canonicalUser` — which
  already owned the LID→PN lookup. Verified live: the next quoted reply resolved.
- **A bridge-originated send has no wire confirmation but `dispatched_at`.** whatsmeow
  does not echo its own client's messages, so `status.sent` (stamped from an echo) only
  ever appears for phone-typed messages. The missing echo is FINE and stays that way —
  waking an agent on its own send has no use case (2026-08-18 call; the self-reaction test
  that surfaced it was a one-off). What is worth having is the receipt half above:
  delivered/read merge for phone-addressed chats today and vanish for LID ones, so
  "left the process" is currently the strongest claim mu can make about a LID chat. Treat
  the absence as unknown, not as failure.
- **Nothing supervises the mirror.** It died mid-session with an empty log and no exit
  trace, and the failure presents exactly like a broken agent: cards stop crossing, `/y`
  stops arriving, and both ends wait. The processes are hand-started shells today; the
  first thing `mu init` (item 2b) owes is a supervisor with a heartbeat, because a relay
  that fails closed and quietly is worse than one that never existed.
- **A card can outlive its window.** `openCards` reads the window, so a
  `permission_request` that falls out of it simply stops existing: it vanishes from the
  anchor, a verdict for it resolves to nothing, and the call it was holding is never run.
  Nobody is told. The boot cutoff removed the clock half of this (a fixed floor cannot
  drift past a card), but the 500-event cap still can — a busy hour buries one. Cheap
  guard: read open cards outside the count bound (they are few, and they are the one thing
  whose position must not matter), or expire them explicitly with a denial the principal
  can see.
- **Spend joins the log — LANDED 2026-08-18.** `usage` gained `turn_id`, stamped by the
  metered transport from `CallMeta` (nu mints the turn BEFORE the call rather than after
  the emissions, which is the whole change). Cost per conversation is now a join instead of
  a guess from timestamps. Found while reading a day's bill: 123 calls, 1.80M input tokens
  of which 99.6% was cache traffic, and 18 full misses (5-minute TTL expiring between
  wakes) accounting for 206k of the 380k written. A 1h TTL was costed and rejected — at 2x
  write against 1.25x it lands within ~5% of the same money. The levers that matter are
  prompt size and model price.

### The config funnel (2026-08-19) — decided and LANDED

Prompted by the attention design ("N, T, W should be configurable… as always don't
hardcode"), an audit of every knob found three castes: read-from-config-with-fallback
(model, effort), settable-only-in-code (compactAt, retryDelaysMs, windowLimit, the
mirror's settle/claim), and purely hardcoded. One discipline replaces all three
(DESIGN §9, "the catalog"):

- **The catalog** (`src/config.ts`): every knob, its default as an exported constant, and
  the reader. `org/config.jsonc` (JSONC — the comments are documentation) always exposes
  the whole catalog: materialized when absent, healed when the catalog grows (missing keys
  appended, your values survive), loud on unknown keys and malformed values. Seed and code
  share the constants, so they cannot drift.
- **Sections by audience, funnel by depth**: `organization` holds org-wide facts,
  `agent` holds every agent's defaults (the section an agent's own file re-declares),
  `system` holds harness machinery — but each value funnels to the deepest function that
  needs it (`timezone` reads as org identity, lands in nu's render). Agent files are
  sparse: an `agent` section overriding key by key, plus `identity` (email/phone).
  Precedence: agent file → MainConfig (tests) → org file → constant.
- **100% parametrized functions**: `start`/`xi`/`nu`/`mu` never read env; mu gained
  argument defaults (`maxTokens`, `tools: []`) — purity means no reads, not no defaults.
  Rules (the permission table) joined the catalog under `agent.rules`, closing the
  "only reading the table from org/agent config is left" gap above.
- **Env shrank to secrets plus one pointer**: `ANTHROPIC_API_KEY`, and `MU_DIR` only for
  standalone connector processes (their launch contract, until the supervisor owns it).
  `MU_MODEL` · `MU_EFFORT` · `MU_BACKLOG_HOURS` · `MU_AGENT` · `USER` are gone. Session
  choices became arguments (`deno task cli [agent]`, connect doors take the principal);
  the REPL's data root is the constant `./data` — the org lives where you run mu. Task
  mode keeps its tiny env surface (`MU_MODEL`, `MU_MAX_TOKENS`, `MU_TASK_TIMEOUT_S`): it
  is the config-less entry, and env is a container's interface.
- Defaults changed while the constants moved: model `claude-sonnet-5`, timezone `"UTC"`
  (the deployment-zone fallback was hidden nondeterminism — same org, different stamps
  per box).
- Next chore, sequenced after this one: `rules?`/`gate?` move from `AgentConfig` to
  `XiPorts` — then config carries only values and ports carry only capabilities.

### Policies + attention (2026-08-19) — LANDED, same day

Two follow-ups on the catalog, both live (DESIGN §2 "Attention", §9):

- **The org file grew a third section**: `organization` (org-wide facts) / `agent` (every
  agent's defaults) / `system` — so an agent's config.jsonc reads as what it is:
  `{"agent": {…}, "identity": {…}}`, the same section re-declared, never "organization"
  inside an agent.
- **Rules became policies**: `{tool, action: allow|ask|deny, connection?, conversation?}`
  — first match decides; the scope fields are the org's three gating levels (conversation
  · connection · global — a "service" seat was considered and dropped: the account IS the
  level, and two workspaces of one service can differ). xi resolves where a `send` lands
  (peer-DM canonicalization included) before ruling; `deny` answers the call as a refused
  tool_result without asking anyone. The base table lives in `agent.rules`.
- **Verdicts grew scopes**: `/{y,n} [conv|conn|all] [reason]` — the bare form settles the
  one call; a scope word writes the REMEMBERED half (the `rules` table on the log,
  store/rules.ts, upserted by scope so a later verdict replaces the action). The gate
  compiles remembered-over-base, most specific first — the principal outranks config.
  One parser (`parseVerdict`) serves every door: xi's surface path and the REPL.
- **Attention**: `decide`'s unanswered-news rule classes per conversation — summons (the
  mind alias, nothing else) and engaged (the agent holds the floor: our complex's last word
  there was the model's, younger than `engagedMinutes`) wake now; ambient piles wait for the
  digest (`digestAfterMessages` deep, or `digestMinutes` old) and, inside `sleepHours` on
  the org clock, for morning. main's tick (`system.tickMs`) is the metronome that
  re-asks — and doubles as the liveness heartbeat §2 always wanted. All knobs in the
  catalog's `agent` section; the policy stays a pure window derivation (DB-tier ready).
- Live org: model `claude-sonnet-5` org-wide; `agents/matias` keeps only `effort: low`.

### Silenced rows: muted · archived join backfill (2026-08-19) — LANDED

`extra.backfill` was the first member of a class; muted and archived chats complete it
(DESIGN §2 "silencing marks", §3 sidecar). One predicate — `silenced` (render.ts) — reads
all three marks: a marked row never wakes — not even into a pile, so a muted group never
comes due — never renders, never mirrors; the turn window
drops it in SQL (`read({silenced: false})`, the renamed backfill option) and `search` is
the door. The WhatsApp wire contract grew `muted?`/`archived?` per message (and per edit —
an edit is its own event, so it carries the chat state too), stamped by the bridge from
whatsmeow's phone-synced chat settings (`ChatSettings{MutedUntil, Archived}`) at webhook
time — the same per-message denormalization as names, never retroactive, so an unmute
wakes only what arrives after it. **Bridge side is pending**: open-bsp-whatsmeow doesn't
send the fields yet (absent ⇒ unmarked, so nothing breaks meanwhile). **Slack has no wire
equivalent** — mute is a private client preference the bot can't see; a mu-side mute
deferred until the conversations table exists, someday.

### Token spend: the prompt cache was dead below the system prefix (2026-08-19) — LANDED

Read from the `usage` table, not guessed: 202 turns on 2026-08-19 cost ≈ $14.23, of which
$11.68 was cache *writes*. Every turn showed the same shape — `cache_read` pinned at 4,048
(the docs+tools block, and nothing else) with ~45K written fresh. Three causes, three fixes,
all mechanical (the attention-semantics ideas below are NOT done):

1. **The window was a sliding tail.** `read({limit: 500})` returns the most recent N, so
   every append dropped one event off the front and changed the prompt's first bytes; a
   cache matches a PREFIX, so render's boundary breakpoint never once hit in production.
   The floor now snaps down to a half-hour grid (`anchored`, xi.ts): it stands still for a
   bucket of turns and jumps once. The read carries `WINDOW_SLACK` (200) beyond the limit
   for the snap to keep. Time, not position, because position is exactly what slides.
2. **The durable breakpoints expired.** Four turns that day read 0 — all after >5min idle
   gaps. The system prefix and the boundary mark now take `ttl: "1h"` (2× write, 0.1×
   reads across the gaps); the within-turn mark keeps 5m, which outlives any tool chain.
3. **A turn per line typed.** 79 of 202 turns produced under 80 output tokens, most of them
   `(sin novedad)` — one full window spent per incoming message in a live DM. A world
   trigger now arms a `settleMs` (5s) timer instead of a turn and the burst joins it
   (main.ts); trigger-less pokes and the agent's own writes still fire immediately, so
   turn-to-turn chaining keeps its latency.

These three are mechanical. What attention MEANS was the other half, decided next.

### Compaction was unreachable code (2026-08-19) — LANDED

Zero `summary` events had ever been written, in any store. `compactionSpan` returned null on
its first line every time: `compactAt` was 150K est. tokens while `windowLimit` (500) caps
the window at ~95K on live traffic — the count cap always binds first, so the checkpoint
could not fire and DESIGN §5's "later: the window read starts at the latest summary" was
waiting on something that never arrives. Compounding it, the two numbers were in different
currencies: `estTokens` is chars/4 over the RAW events (ids, envelopes, the tool traffic the
closed region drops), which runs ~1.8x the prompt those events render to — so 150K "est"
was never the ~150K real-token trigger its comment claimed.

`compactAt` is now **50K** (org config + catalog default), and on the live log it fires at
once: a 525-event / 95K window covers 420 events and leaves 105 faithful (~20K est), so the
next checkpoint is ~165 events out — four or five a day at current volume. The prompt shrinks
with it: post-checkpoint the render is a summary plus ~105 events instead of 525.

`compact.test.ts` now guards reachability with a fixture shaped like a real row (uuidv7 ids,
external_id, phone addresses, denormalized names, delivery status — ~177 est. tokens each,
against ~76 for a stripped test message). **Known gap**: an org whose traffic is nothing but
short one-line messages weighs ~38K per full window and still would not compact. The count
cap can still shadow the token cap; it just no longer does for real traffic. The structural
fix is the §5 "later" — read from the latest summary rather than a count.

### Attention means: only the mind alias, and the floor is the principal's (2026-08-20) — LANDED

The other half of the token work, and this one is semantic. The 19–20 UTC hour on 2026-08-19
cost $14.43 across 95 turns; the driver was one friend's DM, 51 lines typed live, each a
summons under `conv.kind === "direct"` and each answered with a full window and the words
"(sin novedad — sigo en silencio)". The agent had *said* it was staying out of that chat,
in prose, sixteen minutes earlier.

Two changes, both mostly deletion:

1. **The summons is the mind alias and nothing else.** `summons` had four clauses; three are
   gone. A DM, a reply to something the agent said, its name spoken as a word — none of them
   address the agent, they address the principal's account in a room the agent is a bystander
   in. What is genuinely said TO the agent arrives in the mind session through the mirror's
   fan-in, and `conv.address === session.conversation` catches it (always `mind:<agent>`,
   never a wire
   address — so the `dm:` clause was redundant besides). Nothing is lost that `engaged` did
   not already hold: a reply landing while the agent has the floor still wakes it; one landing
   after the floor decayed is the world talking, which is what the digest is for. With
   `summons` a one-liner, `mention` and the helper itself dissolved into `attention`, and
   `Wake` lost `agentId` — the wake policy no longer reads it.
2. **Engagement is holding the floor, and the principal takes it back by speaking.**
   `engaged` scanned back for the agent's own last word, skipping *past* the principal's — so
   an agent that spoke once kept waking for a conversation its principal had since taken over
   by hand, answering over them for a whole engagement window. The scan now stops at whichever
   half of the complex spoke last (`ownComplex`) and engagement holds only if that half was
   the model (`ownVoice`; the discriminator is `payload.turn_id`, §3 — a wire echo from their
   phone carries `agent.id` and neither `session_id` nor `turn_id`). Their line ends it at
   once, without a clock. To hand the floor back they say so in the mind session.

The property that falls out: **the world can never pull the agent in without the principal.**
It is only ever engaged where it was sent. Replayed against that hour, Luciano's 51 lines are
ambient (and engagement would have been cut anyway, since the principal was replying there by
hand) — 95 turns becomes ~10, on top of the anchored cache.

With everything but the mind session ambient, the digest becomes the main path — and the per-conversation
pile it counted could not count, because `extra.consumed` is ONE global high-water mark
stamped by every closing session message, so any turn at all drained every pile. That is settled
in "The attention ladder" (2026-08-27) below, which stopped counting per conversation
altogether. Still open from here: whether a digest wake gets its own framing in the prompt.
At 19:32 the model emitted the same 49-token "(sin novedad)" twenty-five times in a row, and
a digest that renders identically to a summons will do it again, just less often.

### `<|SILENCE|>` — the model can finally say nothing (2026-08-21) — LANDED

Measured on the first full day of the new attention rules (Sonnet 5 at $2/$10): 70 session
messages, **44 of them "(sin novedad …)"**, and in the window the agent actually reads its own
messages were 45KB against the world's 97KB — a third of the context it pays to re-read, and
the third that says nothing. The instruction had told it "close quietly — silence is valid"
for weeks; it could not comply, because a turn ends with a session message and there was no way
to write one that was not a message.

`SILENCE` is that way: the model answers `<|SILENCE|>` alone, nu stamps `extra.silence`, and
the event stays in the log verbatim — it is still the close, and the `consumed` horizon still
rides on it, so nothing about attention changes. What changes is that the body goes nowhere:
`ccParts` returns null so no surface hears it (§4), render draws no block in either region
(§5), and the REPL holds text deltas back while they could still turn out to be the sentinel,
so a quiet turn prints nothing. `silent` is deliberately NOT a fourth silencing mark — a
silenced row never enters the window read, and dropping a silence note from the read would
strand the horizon on some real reply hours back and re-wake the agent for everything since.

Same day, on the live agent's first uses of it: the word arrived, but twice it came after a
paragraph explaining what had been read and why nothing was owed — a paragraph addressed to
nobody, which then crossed to WhatsApp because the strict rule (`trim() === SILENCE`) had
already decided the turn was speech. Two fixes: nu now takes the sentinel ANYWHERE in the
reply (it is a directive, not content — if the model said it, the reply goes nowhere, prose
and all), and the instruction says so in the imperative: the word and NOTHING else, no
summary, no "understood", not one line, because a message saying you have nothing to say is
still a message.

The saving is indirect and that is the point: the turn still runs and still costs its ~$0.014,
but it stops feeding the window, and window growth is what fires checkpoints — which at 4/day
were ~$1.10 of a $2.64 day (each checkpoint is ~$0.28: the summarizer call plus two cold
re-warms). It also settles half of the "digest framing" question above: the digest does not
need a different prompt so much as a way to end without speaking.

### Nights are sleep, not a slower clock (2026-08-21) — LANDED

`digestQuietMinutes` (180) and `quietHours` are one knob now, `sleepHours`: inside the span
the ambient class wakes nobody, however deep the pile. The number was never a saving.
Overnight wakes 3h apart each pay a full uncached prefix write — measured at $0.13 against
$0.009 for a warm one — so the three it bought cost more than the ten they replaced, and
each of the three read a third of a night. Under sleep the night arrives once, whole, as the
first digest of the morning: one cold wake instead of three, and one coherent read instead of
three fragments. The WUM caps already handle an oversized pile (`— N more … search to read
them —`), so nothing new was needed for the morning.

The guard sits BETWEEN the classes, not over them — after summons and engaged, before the
piles — so it never silences anything that was addressed to someone: the principal's own line
in the mind session is answered at 3am, and a conversation the agent is holding the floor in is one it is
IN. And sleep beats `digestAfterMessages`, deliberately: a pile-triggered 4am wake is exactly
the thing a slower cadence could not rule out, and ruling it out is the difference between
sleeping and ticking slowly.

### Voice notes become text — the audio processor (2026-08-23) — LANDED

`src/processors.ts` + `processors/qwen-asr/` (DESIGN §5 Media). The architecture note
lives there; what belongs here is the operational record. The processor is
huanglizhuo/QwenASR (Rust, Qwen3-ASR 0.6B, CPU) — release binaries ≤0.9.1 hang on short
clips on x86 (unbounded spin-join, fixed post-release; our build-fix PR:
https://github.com/huanglizhuo/QwenASR/pull/54), so the README says build HEAD. Measured on
the i7-1365U: a note transcribes in ≈ its own duration (5.4s → 9s, 57s → 37s), near-verbatim
Spanish; `OPENBLAS_NUM_THREADS=1` is mandatory (a pooled BLAS under qwen-asr's own threads
burned 25s of sys for 1.7s of work), `-t 4` beats more threads on the hybrid core layout,
`-S 20` is upstream's own batch recommendation. `--stdin` takes raw s16le 16k (a wav header
can't be backpatched on a pipe), hence the ffmpeg leg in `transcribe.sh`. Binary and model
are gitignored — each deployment builds/downloads its own (the README walks it). En route:
`saveMedia` now strips mime params, so `audio/ogg; codecs=opus` lands as `.ogg`, not
`.bin`.

### The egress proxy — the credential meets the request at the wire (2026-08-24) — LANDED

`src/proxy/` (DESIGN §9 credential-delivery rung 3 — the architecture lives there; this is
the operational record). Mandatory at start: bash issues every spawn `HTTPS_PROXY` +
`SSL_CERT_FILE` and — while the org holds exactly one google grant — the `mu-grant-…`
placeholder (logged at boot: a capability, not a secret; more than one grant is the
per-agent plane's call). `SSL_CERT_FILE` REPLACES the child's trust store (verified: `gws`
rejects Google's real cert as UnknownIssuer once it's set), so user space can only reach
what the proxy fronts. openssl does the X.509 (no JS cert dep); leaves mint lazily per
host with a random serial (a shared `.srl` would race concurrent mints). CONNECT bridges
through per-authority loopback `Deno.serve` backends because TLS-server-on-a-hijacked-conn
isn't a stable Deno primitive; a non-443 dial keeps its port to the origin, and a tunnel
that can't stand up answers 502 rather than hanging the client. The broker refreshes an
expired token single-flight and writes back through the vault's merging `put`
(refresh_token and client_id survive the write); a placeholder it can't honor 401s at the
proxy — the handle never leaves the box. Deno's `fetch` strips `content-encoding`/
`content-length` when it auto-decompresses and re-frames forwarded bodies as chunked
(both probed), so the verbatim header copy on re-origination is sound. Policy (allowlist,
auth normalization) is a seam on the terminated plaintext, deliberately unused.

11. **Background completion** — early-return for long tools generally; `escalation` as its
    first instance. The gate already walks this path (ask → `pending_approval` → a deferred
    outcome the harness narrates), so what is left is a tool that returns early on its own
    account rather than on a verdict. `cancel(id)` landed: a built-in tool that withdraws an
    open ask by the id the anchor's pending line names (`shortId`, the `re` vocabulary).
    It publishes the one settlement the gate already understands — a `permission_response`
    ref'ing the use, turn-marked (§3 authorship) so `owedOf` never mistakes it for a ruling
    to run — and the mirror carries it to the surfaces the card went to as
    `[system] withdrawn: send(…)`. A principal's later verdict on the withdrawn card gets
    gateVerdict's already-answered reply; with one card left, a bare `/y` is unambiguous
    again.
12. **Postgres substrate** — the same ports as SQL: events table + LISTEN/NOTIFY (log),
    advisory lock, RLS as the readable filter, per-row trigger invoking `handle`. The
    verdict-before-acquire race guard (fresh re-read) is already in place for this
    world.
13. **Egress policy at the proxy** (the landed proxy's unused seam — DESIGN §9): the
    egress allowlist and outbound auth normalization (strip/replace sandbox-supplied
    headers, so smuggled credentials are unusable) attach to the plaintext the proxy
    already terminates. Plus secret quarantine at ingest (pasted tokens → the vault, a
    reference in the log).

### Connectors became the plugin surface (2026-08-25) — LANDED

The restructure that makes connectors the most plugin-able part of the system, in one
move plus a proof:

- **Per-service folders, role-named files**: `src/connect/<service>/{ingest,dispatch,
  oauth,connect}.ts` (slack · google · whatsapp — google's poll is `calendar.ts`, named
  what it is). Cross-service helpers stay at the connect root; the audio processor is
  broker machinery rather than any connector's, and lives at `src/processors.ts`.
  `mentions.ts` stayed shared — it serves WhatsApp too, not just Slack.
- **One import seam**: `src/connector.ts` — the log, the vault + grant broker, the org
  config, `newId`, the event types, the dispatch error contract. A connector imports this
  and nothing deeper; the contract is documented in CONNECTORS.md §1.
- **Custom connectors live at `connectors/<name>/`**, repo root: code ships with the
  image, `data/` is the volume and carries state only. The experiment that set the bar:
  **github moved there by swapping places** — it imports only the seam, its cross-process
  test spawns the real entry, everything worked unchanged. That is the promise custom
  connectors inherit.
- **`mu connect` front door** (`deno task connect`): bare = the map (status); named =
  two-step resolution, shipped services first then `connectors/<name>/connect.ts`, spawn
  the door as a child with the remaining args (every door is an `import.meta.main`
  entry, so spawning keeps one contract for shipped, custom, and pasted-path doors).
- **Env shrank to secrets**: `MU_DIR` removed — the data root is the constant `./data`
  everywhere (the org lives where you run mu); `ANTHROPIC_API_KEY` is the SDK's own
  credential chain, not our knob.

### Config went the framework way for connectors (2026-08-25) — LANDED

The catalog moved to **`data/config.jsonc`** (data/ is the org's root the way `/` is
linux's; `data/agents/` is its `/home`) and the `connections` section became **one
subsection per connector, owned by the connector**: each ships a `config.ts` (its
DEFAULT_s, the config rules) and heals `connections.<name>` through
`ensureConnectorConfig` — missing keys appended with the spec's comments, unknown keys a
boot error, `check`s at boot. Main preserves subsections it does not know, so custom
connectors configure identically (github's `config.ts` sits in `connectors/github/`,
importing the seam). `PORT` and every remaining env knob died in the same pass —
`connections.<service>` now carries ingest/oauth ports (whatsapp ingest moved
8791 → 8793: it collided with google's oauth door), the bridge url, scopes, github's
event list. Env is secrets, full
stop; `transport.ts` no longer reads `ANTHROPIC_API_KEY` at all (an explicit key wins,
else the SDK's own chain). Also promoted while auditing: bash's tool timeout became
`system.bashTimeoutMs`. The one tracked exception left: task.ts's `MU_*` env vars,
pending the task-mode redesign.

A heal rewrites the WHOLE file while the writer holds only one connector's spec, so the
comments of every other subsection are read back off the file first (`harvest`, a line
scanner over the `connections` block) and re-emitted verbatim. Only the healing connector's
own annotations come from its spec — the catalog's word on its own knobs. Notes a human
wrote on a subsection no connector claims survive the same way.

### Slack's per-principal leg was never actually requested (2026-08-25) — FIXED

Found while auditing the default scopes. The hosted oauth door supports the user leg
(`user_scope` on `/start`, and a callback branch that writes the principal's own grant from
`authed_user.access_token`), but the entry point passed only `botScopes` — and without
`user_scope` Slack returns an `authed_user` carrying an id and no token, so that branch
never ran. The shared link re-installed the bot and nothing else; the only route to an xoxp
was the paste door. `userScopes` is now a catalog knob and the door asks for it.

The two lists differ for a reason worth keeping straight: the bot is ONE identity for the
org and sees a channel only once invited, so `channels:read` + histories + `chat:write`
is the job. A user token acts AS that human, so enumerating their private channels, DMs and
group DMs needs `groups:read`/`im:read`/`mpim:read`, and `search:read`/`files:read` have no
bot equivalent at all.

Same pass: the scope lists lived twice — in the catalog and in the slack manifest — kept in
sync by hand. The seed now carries only the app's shape and the door fills the consent from
the catalog (`withScopes`). And the manifest's relative path was one directory short, so
the user door died on `NotFound` before printing its link; the new test reads the seed,
which is what surfaced it.

### Outbound media: one door in, and mu stopped stating its own address (2026-08-25) — LANDED

Found by asking why a `mediaHost` knob existed at all. Inbound media is **pushed** to us
(the bridge decrypts and POSTs multipart before the message); outbound was **pulled** from
us (dispatch ran a second HTTP server and minted `http://<mediaHost>:<mediaPort>/m/<token>`
against an in-memory map). So mu had to be told its own hostname — a fact the bridge
already held as `OPENBSP_URL`, duplicated with nothing keeping the two equal, and wrong by
default the moment the bridge runs in a container.

Symmetry (mu POSTs the bytes) was the wrong fix: it moves CUSTODY. The bridge answers
`accepted` on a dispatch, so bytes it has taken but not yet uploaded would need a real
spool with crash recovery. The pull leg is what avoids that — mu keeps the only copy in
`data/media` and hands over a reference the bridge fetches when it is ready.

So the leg stayed and its two defects went:

- **Signed, not remembered.** `signMediaPath` mints `/m/<expiry:path>.<hmac>`, key in the
  vault (`media:sign`, minted on first use, read per use so two processes cannot disagree).
  Verification holds no state — which fixed a real bug: the token map died with the
  dispatch process, so a restart 404'd every path the bridge had not fetched yet, silently
  turning a media send into a message with no file. Same shape open-bsp-api gets from
  Supabase's signed URLs.
- **Relative, so the ingest can serve it.** Statelessness is what lets a DIFFERENT process
  verify, so `/m/…` is served by the ingest — the door the bridge already delivers to —
  and `media_url` ships as a path. The bridge resolves it against `OPENBSP_URL`
  (`resolveMediaURL`, absolute URLs untouched so open-bsp-api's storage links still work).

`system.mediaPort`/`mediaHost` are gone, the second server is gone, and the deployment
states where mu is exactly once, on the bridge. The store's boundary is checked
independently of the signature: a signed path outside `data/conversations` is a 404,
because a signature proves who minted a path, never that the path is innocent.

### GitHub's user door signs people in, instead of asking for a secret (2026-08-26) — LANDED

The user door's route is now the **device flow**, off the app's own client id: `mu connect
github user` asks GitHub for a code, the human types it at github.com/login/device, and the
poll returns a user-to-server token. Nobody mints a credential by hand, nobody pastes one
into a terminal, and the grant is bounded by the app's permissions and its installations
rather than by whatever a PAT's checkboxes happened to allow. It is what `gh auth login`
does with its own client id, done with ours.

The token that comes back is **refreshable**, and that is the point of preferring it: with
"expire user authorization tokens" left ON (what the app door now tells you to do), the
grant is an 8h `access_token` plus a rotating `refresh_token`, so the broker re-issues it
the way it already re-issues Google's and the installation's. A non-expiring `ghu_` sitting
in the vault forever is the same liability as the PAT, so the door prefers the expiring
shape and the broker gained the third branch: an `extra.app_id` with **no**
`installation_id` is the app's user leg, spent against that app's client secret at
github.com/login/oauth/access_token. GitHub rotates the refresh token on every use, so the
answer's is written back — miss that and the grant dies at the second refresh.

The paste survives as `--token`, and as the fallback when no app is vaulted (or when stdin
is piped: a device flow wants a human at a browser, and a secret manager is not one). Both
routes land on the same `connectGithubUser`, which writes **both credential slots every
time** — the unused one blanked. The vault merges what it is given, so re-connecting by the
other route without that would leave the old credential behind to shadow the new one.

### The door — scripts syscall by publishing tool_use events (2026-08-26) — LANDED

The execution-model discussion (scheduler thread) settled two calls and this ships them:
**a script's syscalls write `tool_use` events instead of executing** (even through the
door, tools gate — no second gate, no bypass lane), and **script-published tool
use/results wake the model**, which narrates outcomes to the principal. `src/door.ts`
(main-composed: one socket per agent at `agents/<name>/door.sock`, serving that agent's
scoped port) + `src/script.ts` (the zero-import user-space client) + the generated
`agents/<name>/mu.ts` stub that binds the client by its own location — **no `MU_DOOR`
env var**; the stub beside the socket is the pointer. Nothing in xi changed: `pendingOf`
already finds the script's uses (they carry the agent stamp), the `job:<id>` turn key
keeps them out of every session's turn machinery, `unclosedChain` is what wakes the
narrating think once act answers them, and a steal still cancels rather than re-runs
(a door use may have been mid-execution in the crashed act — same unknown, same sweep).
The client API is two verbs in the model's own vocabulary (`SendArgs`/`SearchArgs` from
`types.ts` — one set of types, no redefinition), and both are the same wire op: publish
the gated tool_use, return `queued` the moment the ask is in the log. Search included —
one path, so a policy on any tool rules scripts and model alike, and the hits land in the
log for the mind, never in the script (a first cut answered search at the door, gateless;
Matias called it: that re-branches the paths we had just unified and plants a policy
bypass — 2026-08-27). No waiting call at all: a foreground script runs inside the turn
that would answer it (bash holds the lease), so a script fires and forgets and the model
narrates; no close either — a script's exit is its hang-up. Scheduler itself (item 10)
still open — this is its execution half, trigger-agnostic: bash today, alarms later.

### `home` is gone — a session is a place (2026-08-28) — LANDED

The word named a conversation that was already the mind session (`home = mind:<agent>` since
2026-08-04), so it carried a distinction the machine did not have: `Wake.home`,
`TurnConfig.home`, `RenderInput.home`, an `agents.home` column and a `(session, home)` pair
threaded through every helper that had to ask "is this ours?". Two names for one fact is how
`use.envelope` came to look like a plausible anchor for a scheduled wake — it agreed with
`config.home` in production and disagreed in the fixtures.

`Session` now carries where it speaks: `{ id, agentId, conversation }`. `closingBoundary`,
`newsOf`, `lastLook`, `unclosedChain`, `compactionSpan` and `render` take the session and
nothing else; `Wake` lost its only non-knob field; the config field is `mind` — the mind
session's conversation (§4) — and so is the registry column (migration v4 renames it, and
backfills `timers.session_id` from the agent id, which is what v0's session ≈ agent means).
nu stamps one envelope instead of two: thinking, calls and the closing message all land in
the session's conversation, which in production they always did.

### The scheduler — a wake is a row, an alarm, and a note (2026-08-28) — LANDED

Roadmap item 10's second half. The agent arranges its own future: `schedule({note, at | in
| cron})` arms a row in the new `timers` table, main's tick fires whatever is due as an
`alarm` carrying the note, and the alarm's own fan-out is the wake — no special path, no
direct invoke. `cancel` gained the second half of its job (unset an armed wake, not just an
open approval), and the anchor lists what THIS session has armed beside the jobs and the
open asks, which is where the ids come from.

Three calls settled it. **A tool, not a skill** — DESIGN said "timer-row write or at/cron,
skill-guided, no dedicated tool", which predates the door: every verb is a gated tool_use
now, so scheduling rides the same table and a policy on `schedule` binds scripts and model
alike. **A note, never a canned call** — a stored tool_use would execute yesterday's
judgment blind against today's state, which is the thing the permission table exists to
prevent; the note costs nothing, subsumes the "run this job" case (the mind reads it and
issues the calls itself), and keeps the veto. **One alarm shape** — the data-part variant
is gone from the type: every alarm carries a text part of kind `alarm` and informs, because
a pure poke needs no event at all (the tick invokes trigger-less). That closes the §9/§10
open question about what carries a wake that must inform; the planned background-job exit
watcher now has its answer for free.

Alarms wake NOW — past the digest, past `sleepHours`: the agent chose the time, and
deferring it would answer a question nobody asked. Cron is five fields on the org's clock,
minute resolution (the tick's own), with `Intl` doing the zone math and DST measured at the
fire rather than assumed; firing consumes the row in the same pass, so a week of downtime
costs one late fire instead of one per missed occurrence. Recovery needed no code: rows
outlive the process and the first tick sweeps them.

**A wake belongs to a session.** The row carries `session_id`, so the session that armed it
is the one that lists it in its anchor, the only one that can `cancel` it, and the one the
alarm wakes — in `session.conversation`, the mind (§4), which is where that session speaks.
Deliberately not read off the `tool_use` envelope: that address names the plane a call is
stamped on, so it would be right by coincidence today and wrong the day sessions multiply.
The alarm also carries its provenance — `payload.ref_id` the `schedule` call, `extra.timer`
the row, who armed it and when — because a note read cold deserves to be traceable to the
moment it was written.

One implementation note worth keeping: the first `nextFire` walked minutes and hung the
suite. The cost was never the date arithmetic — it was asking "what is the org's wall clock
here?" once per candidate, on a path that built a fresh `Intl.DateTimeFormat` every time
(73µs measured; ~2.1M candidates to reach a leap-day cron ≈ 150s, which is exactly the
120s kill). Two fixes, both kept: walk DAYS and convert only on the ones that match
(~1400 integer comparisons), and do the conversion with `Temporal` — `PlainDateTime
.toZonedDateTime(tz)` is the instant←wall-clock direction `Intl` has no API for, so
`zonedTime`'s measure-the-offset-twice hack is gone, DST disambiguation is named rather
than emergent, and an impossible reading (31 February) is refused instead of slid. The zone
cases in the timers suite went 76ms → 3ms.

### The empty-turn quiesce probe — reverted (2026-08-27)

The 2026-08-26 fix (on an empty-batch release, probe the log and re-poke self if act-class
work landed under the lease) chased a test flake and overbuilt: production already holds
the invariant without it. A model turn always publishes — the `SILENCE` sentinel is the
terse close — so every real release re-fires whatever bounced off its lease; a poke lost
in the millisecond-wide `ignore` window is caught by main's clock tick (the liveness
floor, ≤`TICK_MS`), and a door script's sends land under a bash act turn whose
`tool_result` batch wakes them. The flake was the test environment lacking both defenses:
`scripted()` when dry closed with an empty batch (a model breaking the SILENCE
convention) and `TICK_MS` never fires inside a test. Root fix instead: `scripted()` now
closes with the sentinel like a compliant model. The quiesce closure, its two call sites,
its regression test, and the 20s `waitFor` caps (a diagnostic to tell stall from slow)
are gone.

### The attention ladder — six rules the principal can actually tune (2026-08-27) — LANDED

The rules were right but not legible, and a knob nobody can predict is a knob nobody tunes.
Restated as a LADDER over one baseline — every message deserves a reaction; these are the
rungs that cool it down — and three of them changed meaning in the restating.

**The interval now runs from the last look, not from the oldest unread.** `digestMinutes`
read as "let messages age fifteen minutes before reading them", so a line arriving fourteen
minutes in waited fifteen more, and an agent quiet since lunch made the next message wait
too. It now reads as "check the phone every fifteen minutes", counted from the stamp on the
last closing session message. Same knob, opposite behavior at the edges, and the human version
is the intuitive one.

**The depth counts the whole world, not one room.** `digestAfterMessages` was per
conversation, which made the wake rate depend on how the same volume happened to be spread.
It is now `news.length` — and nothing needs excluding from it, because the principal's news never
accumulates (answered on arrival, the horizon eats it), an engaged conversation wakes before
it piles, and a silenced one never becomes news.

**Which killed the conversations table** (`read_through`/`defer_until`), planned above as
"not optional". Its premise was that `consumed` answers *seen* while the digest needs
*handled* — but the turn reads a WHOLE window, so the conversations a turn left alone were
in front of the model too. Seen and handled are the same fact here; one global mark is
honest, and per-conversation bookkeeping was buying a distinction that does not exist.

Two renames for the same legibility reason: `settleMs` → `debounceMs` (it is a debounce),
and `tickMs` left the catalog to become the constant `TICK_MS` (60s) — it is the resolution
of the intervals, not one of them, and as a knob it silently added "give or take a tick" to
every other one. The debounce stays keyed per AGENT: keying it per conversation looks like
the fix for "a line landing 4.9s into somebody else's burst gets 0.1s of debounce", and
isn't — a timer fires trigger-less and the invoke sweeps the whole window, so the earliest
pending timer reads every room anyway and a second timer only adds wakes. The real fix is a
wake that knows what it has already read, which is per-conversation `consumed` marks; parked
until those exist. Rule 4 (the principal's floor) turned out to need no code at all: `engaged`
already requires the agent's own word to be the last one AND recent, and the principal's
line always lands after the agent's, so the two clocks can never disagree.

### `send` at the principal is refused, not asked (2026-08-27) — LANDED

Two live misfires in one morning, both the same root: the instructions said "never `send`
to your principal" and the model did it anyway. Once it reached them as a third-person
message about their own friend ("Gryngo pregunta si hay juntada… ¿le confirmás vos?"), once
as an approval card asking permission to send them a message they were already receiving.
An instruction that only the model enforces is a hope; this is the guard. `selfSend` runs at
the top of act's fresh batch — **before the gate** — and refuses any `send` naming the
agent's own id, its mind session `mind:<id>`, the principal's declared `email`/`phone`, or an alias
conversation bound to it. Before, because a call that can land nowhere is not a permission
question, and the card is the worse of the two failures: it spends the principal's attention
to tell them nothing.

The error carries the fix rather than just the refusal ("that address is your principal —
what you say to them is the assistant channel"), the `to` schema says it where the model
picks the value, and §9's send bullet now says enforced rather than forbidden. `xi`'s log
port gained `aliases` for the surface check.

Second fix, instructions and the tool schema: the agent QUOTES almost everything it answers
(`send(re: …)`), which on the wire is a visible quote block above an ordinary reply — the
loudest tell that a machine is typing. What it says is fine; that it says it as a
reply-to-a-message is not. There was already a `re`-is-for-disambiguation bullet and the
model read straight past it, because it was written as guidance between two reasonable
options. It now states the default outright — do not quote, bare `send(to:, text:)` almost
every time — and makes the exception carry a burden: reach for `re` only when you can name
the confusion it prevents, since "it is the message I am answering" is true of every reply
ever sent. Same wording in the `re` schema, where the model actually picks the value, with
the fact it hides made explicit: with plain `text` this QUOTES, it is not a bookkeeping
field. The distinction both places have to keep is that `re` is REQUIRED for `react` and
every `action` — those act on a specific message and have no object without it (xi already
throws "a reaction needs `re`"), so the don't-quote rule is about `text` alone. Instructions
only for now — a mechanical guard is available (an `re` naming the conversation's own last
message is redundant by construction) and unbuilt, pending whether the wording holds.

### One config to declare the org — root catalog, roster, `mu init`, the Docker shape (2026-08-29) — LANDED

The framework way completed its arc: **the org is a project, and `config.jsonc` at the
project root is both its marker and its whole declaration**. `findRoot` walks up from cwd
the way git finds `.git` (the `./data` constant is gone from every entry point — ~20 of
them now derive `<root>/data`), and the file carries five sections split by audience:
`system` (machinery tuning), `org` (deployment identity — timezone/locale/backlogHours,
one clock for the whole org, plus `org.agent` defaults), `processors`, `agents` (the
roster: sparse overrides + `identity` handles), `connections`. Per-agent
`data/agents/<a>/config.jsonc` died with the move, and so did every write the system made
to config: no materialize-on-boot, no heal-appends — `mu init` writes the full commented
catalog ONCE, git is its history, a key left out takes its default, an unknown key still
fails the boot loudly. Direction of truth flipped with it: **config → tables → folders** —
boot compiles the roster into registry rows and creates the missing homes; what the system
learns at runtime (grants, discovered handles, verdicts) lands in log.db tables, never in
the file. main stopped reading files altogether: the entry point resolves the catalog and
hands main the VALUE (`MainConfig.catalog`); `connectorConfig` replaced
`ensureConnectorConfig` (read-only, same specs, same checks).

`mu init <path> [agent…]` landed as the scaffolder (`deno task init` until `mu start`
exists): materialize the catalog, copy `src/scaffold/` (AGENTS.md · Dockerfile ·
entrypoint.sh · deno.jsonc · .env · .gitignore), interpolate the name, mkdir
connectors/·processors/·data/. The scaffold's Docker pieces are the settled shape written
down: one volume (`-v ./data:/data`, `/app/data` symlinked to it), the entrypoint turns
the roster into Linux users (uid pinned by name-hash so volume ownership survives
rebuilds), lays `/home/<a> → /data/agents/<a>` and the permission sweep (log/ 700 root ·
org/ 2775+ACL · system/ read-only · homes 700), then execs `mu start`. The harness's half
is live now: when the process runs as root and `/etc/passwd` knows the agent, every bash
spawn drops to that uid with HOME/USER/LOGNAME following (exec/bash.ts) — the kernel,
not the prompt, enforces the classification. Local dev keeps running as one user,
unchanged; the repo's own org migrated to the root catalog in the same landing.

Still open from this arc: `mu start` itself (the supervisor — roster the connector
processes from `connections.<name>`), and the JSR split that makes a scaffolded project's
`deno.jsonc` import `@mu/core` (local dev via Deno's `links`).

The seed template is now identical to what runs; it had drifted four blocks behind.

### `mu start` — the org as one command (2026-08-31) — LANDED

The supervisor (`src/start.ts`) is a keep-alive loop and nothing more, written from zero
because every off-the-shelf option (process-compose, supervisord, s6) is configured by its
own manifest — and ours must derive from config.jsonc, so the generator keeping a second
file in sync would outweigh the supervisor itself. The log-as-bus had already removed what
supervisors are big for: no dependency order, no readiness probes, no IPC, no launch
contract beyond `cwd: root`. What remains: spawn main + one child per `connections.<name>`
(`Deno.execPath() run -A <run.ts>`, env untouched), respawn on exit with doubling backoff
(1s → 60s, forgiven after a healthy minute), SIGTERM fan-out with `system.stopTimeoutMs`
then SIGKILL. Death is loud on stderr and nowhere else; the outer layer (docker restart,
`--init` for reaping, the terminal) supervises `mu start` itself.

Two decisions shaped it beyond the loop:

- **A connection is ONE process.** Ingest and dispatch merged into a per-connector
  `run.ts` (the files stay separate; the halves became exported `runIngest`/`runDispatch`).
  The mirror incident (2026-08-18) was a half-dead connection — one direction alive, cards
  not crossing, both ends waiting. One process per connection makes half-alive
  unrepresentable: either half dying takes the connection down, and the supervisor brings
  both back together. Discovery collapsed with it: `connections.<name>` declared → spawn
  the connector folder's `run.ts` (core's `src/connect/<name>/`, else the org's
  `connectors/<name>/`); a declared connection with no `run.ts` fails the boot loudly.
- **main gained a headless entry** (`import.meta.main` in main.ts): findRoot → readConfig →
  start, SIGTERM-clean. cli.ts stays the interactive wrapper hosting start() in-process.
  The egress proxy needs no seat of its own — main already hosts it (`installProxy`).

The parallel-boot crash from the pending list died in passing: all processes open log.db
at startup and the DDL takes the exclusive lock, but `PRAGMA busy_timeout` was set *after*
`journal_mode=WAL` — which itself takes that lock — so a simultaneous boot's loser threw
`database is locked` before the timeout applied. The pragma now comes first in both opens
(log.ts, credentials.ts); losers wait instead of dying.

Tasks renamed with the merge: `run:<name>` replaces each `ingest:`/`dispatch:` pair;
`deno task start` is the headless org. Still open: the JSR split (`@mu/core` + `links`)
that makes a scaffolded project's `mu start` real outside this repo.

Two DX follow-ups landed the same day, prompted by a test flake traced to parallel
harnesses fighting over ports (the suite's freePort() binds :0 and RELEASES it — a
window another org's run can steal):

- **`ingestPort: 0` = any free port, announced.** An ingest port is an address something
  dials, and the dialer sets the rule: a peer that holds the org's address (the WA
  bridge's URL, an Events API request URL) needs a declared port; a dialer that reads
  your terminal (`gh webhook forward`, a test) can take 0. `serveIngest`
  (src/connect/serve.ts) is the one front door: bind, announce the bound port, and on a
  taken port fail naming the knob to set (`connections.slack.ingestPort`). The xproc
  test now spawns on 0 and reads the announcement — the steal window is gone.
- **The supervisor stamps every child line** — `HH:MM:SS [name] …`, stdout/stderr split
  preserved — so attribution is the harness's property: panics and stack traces land
  tagged, greppable by process, by devs and agents alike. After the boot lines, silence
  from `mu start` means every process is up. Services stopped self-naming with it: the
  process tag is the supervisor's (standalone, the terminal is the tag), and inside a
  connection process a line carries at most a MODULE tag — `[ingest]`, `[dispatch]`,
  `[oauth]`, `[exec]`, `[proxy]` — so a supervised line reads `[whatsapp] [dispatch] …`.

### The system is a daemon, interfaces attach (2026-08-31) — LANDED

Headless main and the container split settle what the harness is: a daemon holding the
substrate, and interfaces that attach to it. Two axes, decided independently.

The RUN mode answers "do the agents run while nobody is attached?" — `mu start` (the
daemon: main plus a process per connection) against a run whose life is the command's.
The ATTACH mode is what a human or a script drives it through: `mu repl` (the TUI),
`mu task` (one input, streaming deltas and messages until the agent settles — a gate ends
the turn like any other stopping point, since the interface decides what to do with a
disclosed request), and whatever else. The illusion the user gets: `mu start` spins the
org up; `task` and `repl` attach to it, and when nothing is running they bring a daemon up
themselves and take it down when done. The REPL (`cli.ts`) holds no log handle and hosts
nothing — the attach path is the only path it has; `mu task` owes the same shape when it
is reconciled (below).

CONNECTIONS BELONG TO `mu start`. A daemon an interface raised is main alone: the world's
doors are the org's standing commitment, not a side effect of someone opening a REPL.

A daemon's life is its ATTACHMENTS, never an interface's exit. One raised for an
interface (`main.ts --ephemeral`, what a REPL that found nothing listening spawns and
unrefs) reaps itself once nothing is attached and stays that way for a linger
(`LINGER_MS`, 30s) — long enough that consecutive `mu task` runs reuse one org instead of
paying for seeding, exec planes and the proxy three times over; one `mu start` raised
never reads the count. The count (`main.attachments()`) is the door's live connections
rather than bookkeeping, so a killed interface and a clean one are the same event — a
hang-up — and the decision sits with the participant that is certainly still alive. "Is
one running?" is a `connect()` whose refusal means no: the socket file outlives a hard
kill, which is why `installDoors` unlinks a stale one before binding.

**A STOP WAITS FOR THE SERVICES TO BE IDLE.** An in-flight turn is covered already
(`system.stopTimeoutMs`), and a hard death leaves the lease recoverable — a `locks` row
with a steal-reporting TTL. A connection answers SIGTERM in the shape main does: each
half of every `run.ts` returns a stop — a dispatcher unsubscribes and settles the chain
of posts in flight, an ingest server refuses new deliveries and finishes the ones it
holds, the poller disarms and awaits its sweep — and `exitOnStop` (`connect/stop.ts`, on
the connector seam) drives them all off the signal before exiting, so the supervisor's
grace is a window the process actually uses.

What that leaves is bounded and accepted. `send` answers **queued**, to agents and humans
alike, and pending is simply the absence of a dispatch stamp — nothing claims delivery
before `dispatched_at`. The exposure is one request/response cycle: a dispatcher torn down
between its request and the bridge's answer restarts still holding queued work and asks
again, so the wire may carry the message twice. That is the right trade against inventing
a second source of truth for a state the log cannot observe, and nobody was ever promised
otherwise. SIGKILL and crashes are known to have side effects — the exec plane is another
of them: `stop()` reaps each agent's background jobs, and a hard death skips it, leaving
those jobs attributable by uid in the container and leaked locally.

The attach seam is the door (`door.ts`) — an interface never holds a log handle. The
container makes that a fact rather than a style: `/data/log` is root's at 700, so an
SSH'd principal reaches its agent only through the socket main serves. The door speaks
four ops: `call` (a `tool_use` in the agent's name, gated as ever), `message` (the
PRINCIPAL's half of the complex — no `turn_id`), `permission_response` (a gate answered),
and `tail` (the agent's scoped view pushed from a cursor, model deltas riding the same
wire). `onDelta` is a fan-out: zero tailers headless, N with three interfaces watching —
and the tailer registry lives on the same live connections the attachment count reads.

**The door discloses the whole session.** What to do with a permission request, with
`<|SILENCE|>`, with a deferred outcome, is the interface's decision, not the door's — the
REPL paints an approval card, an audio surface may refuse to carry approvals at all, a
one-turn CLI may exit on the first gate. The door owes them everything that happened and
no policy about it.

**One door per (principal, agent) pair, when we get there.** One agent, one principal is
the rule until then, and it is also what makes the pairing unbuildable today: the catalog
declares `agents` (each with an `identity`) and no principals at all, so the roster stands
in for both ends. Principals as declared things are the prerequisite, not the doors. The
socket's path is the
whole of a caller's identity and the filesystem is the enforcement, which holds exactly
while agent and principal coincide. Once an agent has no principal, or several share one,
the path still says which agent but no longer who is speaking — fine for `call` (the
script acts as the agent), wrong for a principal `message`. The fix is another socket, not
another field: a door per pair keeps identity in the path, so the protocol still has
nowhere to claim someone else's. Peer credentials cannot rescue the single socket —
Deno 2.7 exposes no socket options, no descriptor to reach `getsockopt` through FFI, and
an accepted unix connection's `remoteAddr.path` is null; a kernel check on directory
permissions at connect time is the same guarantee, one step earlier.

`task.ts` sits on the other run mode and will be reconciled when it gets attention: it
holds explicit principals, supplies its own exec plane, skips the seed, wants no
connectors, and is the one module where env still carries knobs that are not secrets.

### The CLI is an attach client; the daemon discloses the turn (2026-08-31) — LANDED

Task mode is gone. `src/task.ts` — the second harness: `start()` in-process, a hand-rolled
exec plane and shims, a temp org, the stall-repoke, the `MU_MODEL`/`MU_EFFORT`/
`MU_MAX_TOKENS`/`MU_TASK_TIMEOUT_S`/`MU_TASK_TRACE` env knobs, the compiled multi-call
binary (`compile:task`) — is deleted, and `mu cli` (`src/cli.ts`) replaces it as a pure
attach client: resolve the agent from the catalog like the REPL, connect (raising an
ephemeral daemon on refusal), `tail`, publish ONE `message`, stream the transcript, exit
when the daemon goes quiet over it. The old file's polling loop guessed at quiescence from
outside (`age > 3s`, five repokes, a wall clock) because the harness had the verdict and
wasn't saying; now it says.

**The turn's end is the harness's disclosure, not the client's calculation.** `decide()`
under the lease is the only honest source of "nothing is owed", so xi now returns the
verdict it acted on and reports it the moment it is made (`XiPorts.onDecision`); main
collapses the stream to edges (`disclose` — the ticker's steady ignores dedup away) and
the door pushes `{status: "busy"}` / `{status: "idle", after}` to tailers, beside `{event}`
and `{delta}` — a sibling line shape, not a `Delta` kind: `Delta` stays the model's
in-progress output. `after` is the last event the deciding read saw; a client that wrote
id M is done when `after >= M` (UUIDv7 order). The daemon discloses, the client decides:
no `reason` field (an error row already reaches the client on its own tail — a failed
command; the fix is running it again, and `nu` already retried transients before writing
it), no `waiting` count (an idle over an open approval is the interface's call), no exit-1
on empty output (whether the work succeeded is stdout's reader's judgment). CLI contract:
stdout = the transcript as the REPL paints it (thinking stays silent), stderr = error
rows and the CLI's own failures, exit 0 = idle arrived over our message, 1 = no daemon /
hang-up / `--timeout` (no default), 2 = usage.

**One painter, one wire.** `src/paint.ts` renders deltas and events for every attach
surface (the `<|SILENCE|>` hold-back included); what differs — the prompt redraw, where
errors land, whether thinking streams, the approval pile — arrives as surface hooks.
`src/attach.ts` holds the shared client half: `resolveAgent` (catalog roster), `attach`
(connect-or-raise), `wire` (requests answered in order; pushes demuxed by shape — a reply
always carries `ok`, a push never does). `cli.ts` → `repl.ts` carries the interactive
surface over it; `mu cli` is smaller than the REPL, as it should be. `MainConfig` lost the
seams only task mode used (`exec`, `ambient`, `seed`, `onDelta`): the proxy, the per-agent
exec planes and the doc seeding now install unconditionally.

Verified live against a scratch org: dummy key → three retry deltas and the terminal error
row on stderr, empty stdout, exit 0 on the idle that followed; real key → the closing
message alone on stdout, exit 0; the REPL attaches to the daemon the CLI raised. Still
open: `bench/tbench`'s Harbor adapter uploads the compiled `mu-task` binary that no longer
builds — re-point it at `mu cli` next time the bench gets attention.

### A fresh org is a coding agent; a grant declares its own process (2026-08-31) — LANDED

The default tool offer is `search · schedule · cancel · bash` — `send` is out. A reply to
one's own principal is the model's plain answer, never a call, so in a one-agent org with
no connections `send` addressed nothing; an org adds it where its agents have peers or a
world. The `rules` default keeps `send: ask` for when it comes back.

`mu connect <service>` now writes `connections.<name>: {}` into config.jsonc itself
(`declareConnection`, reported by `connect/declare.ts`'s `declared`, called by all four
doors when a grant lands). Until now a grant wrote the map and nothing ran: `mu start`
spawns per DECLARED connection, and the operator was never told the file needed a line.
The edit is surgical — the `connections` block gets one line, every other byte stays as
found (comments, layout, order), and the result is parsed before it lands, restoring the
original if it would not read back. The catalog's rule is now "only the setup doors write
it": `mu init` materializes it, `mu connect` declares what a grant earned, both at human
time with a human watching, both leaving a diff for git. The running system still never
writes it.

Open: where a coding agent STANDS. `mu start` gives each agent `data/agents/<name>/` as
its cwd, which is right for a resident agent whose instructions live there and wrong for
`mu cli "fix the test"` typed inside a repo — the hint the agent reads is its home, not
the work. Two shapes were named: (A) attaching in a directory makes that directory the
agent's working directory; (B) `mu repl` outside an org scaffolds one, harness files under
`.mu/` rather than scattered at the project root. A is wanted; B is acceptable at this
stage. Neither is built, and A's open question is whose cwd wins when several attachments
sit in different folders.

### Many sessions per agent (2026-09-01) — step 1 landed, 2–6 open

DESIGN §7 deferred subagents and settled for `session_id ≈ agent id`. This is the design
that lifts it: an agent runs MANY sessions, each its own window, lock, compaction and
timers, over one identity — one home, one docs cascade, one memory, one exec plane, one
permission table. `mu repl --session build` is the entry point; the session is born when
first named.

**A session is a conversation.** `mind@matias` is the default; `build@matias` is a session
of the same agent. The pair `(agent_id, session_id)` is the key — both columns already
exist on `events` and `timers` — and `session_id` holds the BARE name (`mind`, `build`),
the address being how the pair is written in an envelope, a prompt or a `send` target. `@`
because `:` is already the segment separator of world addresses (`slack:T0AB:C123`), so
`dm:mind@matias:build@matias` splits cleanly; and because a local address lands in paths
(`conversations/<address>/` is a doc scope walked as a directory) where `/` could not.

**A session is a mini mind.** Not a special shape: the same machine, minus the world. The
mind is distinguished by ONE thing — it is the session world traffic is routed to. So no
"non-mind sessions load only local" rule lives in the code: `connections` and credentials
stay AGENT-owned (tomorrow's routing criteria may be finer than per-agent), and a single
routing function answers "which session does this connection's traffic belong to" for both
purposes that need it — whose window may see those rows, and whose xi is woken. Today it
answers `mind`.

**Memberships key on (agent, session).** That is the whole enforcement: a session reads
and writes where it is enrolled. "Sessions don't mix" stops being etiquette and becomes
the WITH-CHECK — a session is not enrolled in a sibling's room, so it can neither read it
nor write into it. Sessions reach each other the way two agents do: a DM room both are in,
`dm:` + the sorted pair of session addresses, which makes today's agent-to-agent
`dm:<a>:<b>` a case of one rule rather than its own. A bare name in `send(to=…)` means an
AGENT, canonicalizing to its mind; a session must be addressed in full.

**Render.** `here` is already a parameter (`session.conversation`), so a session renders
by the same path the mind does: its own room bare, everything else a `<conv>` element —
its DMs included. A sibling's line reads `<msg from="build@matias">`; `<principal>` stays
the human's alone. A session's own sends stay visible after the tool pair collapses
because the window includes rows it authored, which is what `events.session_id` is for.

**Wakes and attention.** A session wakes on its own rooms' events only. World traffic and
mirrors reach the mind. Named sessions are reactive — no digest cadence, no sleep window;
the mind keeps the ambient ladder. Idle sessions are never poked: the trigger's own
address names the session to invoke, so main needs no session registry and a quiet session
costs nothing. Backlog applies at boot as it does for the mind.

**The knobs stay the agent's**: `compactAt`, `windowLimit`, `keepRecent`, the model, the
rules. A session that needs more window is a config edit on the agent.

#### The quirks this refactor has to survive

- **Session identity is a bare string, compared by `===`, in 33 places** (`ownVoice`,
  `ownComplex`, `isSelf`, xi's tool-ownership filters, main's debounce `own` check). Today
  that is safe because the value is the agent id, globally unique. Bare names COLLIDE —
  every agent has a `mind` — so ana's row would read as matias's own voice. The refactor
  must make the runtime identity the pair and let the type system enumerate the sites; a
  missed one mis-attributes voice silently, and only in a multi-agent org.
- **`timers(sessionId)` and `disarm(id, sessionId)` key on the session alone.** With bare
  names one agent could list and cancel another's wakes. They take the pair.
- **`selfSend`'s refusal set is `[agentId, mind, email, phone]`** — "that address is your
  principal". Per session it becomes "your own room": otherwise a session could never
  write to `mind@matias`, and the mind could never be reached at all.
- **`scoped()` reads filter-before-limit**: a `filter` disables the SQL `LIMIT` and scans
  the table backwards until N visible rows. One scan per agent today; one per SESSION per
  turn after. The fix is already in the query builder — pass the session's enrolled rooms
  as `q.conversations` (an IN clause) and keep `filter` only for the authored-rows leg.
- **Two escapes for one address.** The doc scope walks `conversations/<address>/` raw
  while media writes `conversations/<safe(address)>/`, where `safe` maps `@` to `_`. `@`
  is harmless in both; it is worth knowing they differ.
- **`agents.mind` and `mirror.ts`'s `mindOf`** parse the `mind:` prefix to recover an
  agent. They become an `@` split, and the registry column is derivable from the pair.
- **The fixtures.** 16 test files carry `mind:`/`session_id` literals, plus `dm:ana:bo`
  and `mind: "dm:ana"` — addresses that only work because nothing parses them today. After
  this, something does.
- **Prompt caches multiply.** Each session anchors its own window floor, so the cache
  prefix per session is its own. Cheaper per turn, more of them.

#### Sequence

Each step is a green-tests checkpoint: (1) **landed** — the address (`mind:<agent>` →
`mind@matias`), `session_id` to the bare name, `dm:` to the sorted pair of session
addresses, and every authorship comparison to the `(agent_id, session_id)` pair
(`SessionRef` — the predicates take the pair, so the compiler enumerated the sites); the
timers pair-keying (`timers`/`disarm` take agent + session) came forward from step 4
because bare names collide the moment they land. `src/session.ts` is the vocabulary:
`MIND`, `sessionAddress`, `parseSession`, `dmAddress` — one name grammar, checked at the
one door every construction passes through. Still open: (2) `config.mind` stops being a
per-agent constant, xi and nu anchor to the turn's session; (3) memberships on (agent,
session) + the routing function both visibility and waking consult; (4) the per-session
lock, window, compaction — the point of the whole thing; (5) the seam: `session` on the
door's `message`/`tail`, on `{status}`, `--session` on both clients; (6) render's
`<msg from="build@matias">`.

DESIGN §7 keeps describing one session per agent until step 4 lands — the architecture
doc describes what runs.

## The honest framing

After 2b, nothing structural remains — the machine is complete and every later item is
either a capability (bash, compaction), a connection (Slack/WA), or a substrate swap
(Postgres) behind ports that already exist. The riskiest unknown left is not code but
behavior: how the model actually drives the three channels (think/assistant/send) once
real traffic hits it — which is exactly what 2b + the live smoke will show.
