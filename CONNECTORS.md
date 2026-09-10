# CONNECTORS — the channel roadmap

*Companion to [DESIGN.md](DESIGN.md) (§3 ingest-as-classifier, §4 identity/credentials, §9
deployment tiers) and [PROJECT.md](PROJECT.md) (the arc). This file is the per-service map:
what each connector costs, what it reuses, and where it breaks the mould. Status
2026-08-06. Landed: GitHub (v0.1 preview), Slack (live smoke passed 2026-08-12).*

Services of interest, in scope: **WhatsApp** · **Slack** (done) · **Gmail** ·
**Google Calendar** · **Microsoft Teams** · **Outlook mail** · **Outlook Calendar**.

---

## 1. The shape a connector fills

GitHub and Slack established it. Five pieces, and every new service either fits or breaks
exactly one of them:

1. **Ingest** — one portable `(Request) => Response` function: verify → map → `publish`.
   Plus a **carrier** for the local tier (Slack's Socket Mode, `gh webhook forward`)
   feeding the SAME handler; the edge tier drops the carrier and serves the function.
2. **Dispatch** — a log subscriber picking the agent's outbound `send`s for its service →
   post → `setDelivery` backfills the platform id (§4 echo-dedup: the echo MERGES).
3. **A connect door** — a paste, or an OAuth handler the door serves for the length of one
   sign-in — writing the same three places: `connections` (the account anchor),
   `identities` (handle → registry name), and the vault (`credentials`).
4. **A stable `external_id`** so retries, edits, and our own loopback upsert instead of
   insert. This is the one mechanism (§4); there is no author-based skip anywhere.
5. **Classifier duties at ingest** (§3) — `conversation.kind` from platform facts (never
   from counting members), sender resolved through `identity()`, membership mirrored from
   the wire.

Nothing below needs a sixth piece. What some of them need is **new state**, which is §2.

### Where a connector lives — and the import contract

A connector is a **standalone process over the org's substrate**: it reaches liquen through
the shared `./data` root and imports only the seam module, **`src/connector.ts`** — the log (`openLog`,
`publish`, subscribe/`setDelivery`), the vault (`openCredentials`, the grant broker),
`connectorConfig`, the event types, the dispatch error contract, and `entry` — the rule
every liquen process ends by. A deep import from a connector is a contract violation, not
a convenience.

Run an `import.meta.main` body through `entry` and a custom connector fails the way a
shipped one does: `throw new Error("the bridge is not answering on :8081")` reaches the
operator as that sentence and nothing else, while a `TypeError` keeps the stack that
locates it. Whatever the body prints and exits on its own — a usage line, a missing
credential — is its own business; the rule is only for what throws.

Configuration follows the harness's own config rules: the connector ships a `config.ts`
declaring its DEFAULT_s and its `ConnectorSpec`; `connectorConfig` reads the
`connections.<name>` subsection of the root `config.jsonc` over the spec's defaults
(missing keys default, unknown keys a boot error, `check`s run at boot) and returns the
merged values — nothing is ever written back. Secrets never enter the file — they live in the vault (slack and github keep
their app, bot, and grants there) or, for a local bridge, in env (`WA_BRIDGE_TOKEN`).

A connector whose CLI should work from agent bash **fronts its grant through the egress
proxy by declaration, not by code**: the connect door writes two sidecar fields on the
credential row — `extra.env`, the env var the placeholder is issued under (what the tool
reads: `GH_TOKEN`, `GOOGLE_WORKSPACE_CLI_TOKEN`), and `extra.hosts`, the only origins the
token may be spent toward (exact hostnames or `*.suffix`). main fronts every row that
declares an env var (the org's own row wins; several contenders for one var → none is
fronted), and the proxy substitutes the handle wherever it appears in a header value —
no proxy or main change per tool. A handle a tool base64s or signs over (Basic, SigV4)
can't ride this path; such schemes belong broker-side.

A connector's subsection holds what is **that service's**: the addresses of its wire, the
scopes it asks for, the events it maps, the tenant it files the org under. A value that is
merely *arbitrary and fixed* is a constant at the top of the file that uses it, not a knob:
how often the pairing door polls the bridge is `POLL_MS` in `whatsapp/connect.ts`. And
liquen's own address is never a knob at all (below).

A door may **decide** a knob's value the way `liquen init` decides the org's clock — what a
human would otherwise type, typed once and written with the section, so the file says it
from then on. `connections.whatsapp.organizationId` is the case: the whatsmeow bridge is
multi-tenant, orgs sharing one sidecar each name their own, and the first
`liquen connect whatsapp` names the tenant after the org's folder. Set it beforehand to
choose otherwise; a declared section is the operator's and the door leaves it as found.

When a connector also **prints an app definition** — slack's manifest, the prefill link
`liquen connect slack` opens — that definition is filled from the same knobs at print time
(`withScopes`). The seed template holds the app's shape (name, events, redirect, socket
mode); what the app may do comes from `connections.slack`, so the consent the door asks
Slack for and the consent the app declares are one list, not two that drift.

### Outbound media: the pull leg, signed and relative

Most services take a file by **push** — Slack's `files.uploadV2`, Gmail's MIME body: liquen
reads the bytes and sends them. Some take a **link** the service fetches instead (the
whatsmeow bridge, Twilio's `MediaUrl`, the Cloud API's `link`), and for a file in
`data/media` that link has to point back at liquen.

It points back **relatively**. `signMediaPath` (`store/media.ts`) mints `/m/<payload>.<mac>`
— the absolute path and an expiry, HMAC'd with a key in the vault — and the service
resolves it against the address it already delivers to. That address is the connector's
own ingest: the same door the service posts events at serves `/m/…`, so liquen never states
its own hostname anywhere, and a containerized bridge is configured once (its
`OPENBSP_URL`) instead of twice.

Three properties come from signing rather than remembering: verification holds no state,
so the ingest and the dispatch can be different processes; a restart doesn't invalidate a
path the service hasn't fetched yet; and a retry re-fetches freely, since serving one
doesn't consume it. The store's boundary is still checked on its own — a signature proves
who minted a path, never that the path is innocent.

Two homes, one shape (role-named files, each optional — `ingest.ts` · `dispatch.ts` ·
`oauth.ts` · `connect.ts`):

- **Shipped** — `src/connect/<service>/` (slack, google, whatsapp, github). Cross-service
  helpers (`flavor.ts`, `mentions.ts`, `mirror.ts`, `errors.ts`, `status.ts`) live at
  `src/connect/` root.
- **Custom** — `<org>/connectors/<name>/`, beside the org's `config.jsonc`. Connectors are
  code and ship with the org's image (`data/` is the volume — state only); an org's
  deployment is the package + `connectors/` + config, and a package upgrade is a version
  bump that never touches them. A custom connector imports the seam as
  `@liquen/liquen/connector` and nothing else — the bar the shipped ones meet too, by
  path. Its config lands under `connections.<name>` in the org catalog; its secrets in
  env/vault as ever.

The front door is **`liquen connect`** (`deno task connect`, `src/connect/connect.ts`): bare,
it prints the map (status); `liquen connect <name> [args...]` resolves the shipped services
first, then `<org>/connectors/<name>/connect.ts`, and runs the door as a child process
with the remaining args — a name with a slash is taken as a module path. `deno task start`
runs every declared connection the same way: `src/connect/<name>/run.ts` if it ships,
else `<org>/connectors/<name>/run.ts`.

## 2. The split that decides everything: pushed content vs. bare change signal

- **Slack · WhatsApp · Teams · GitHub push the CONTENT.** Ingest maps and publishes. This
  is the shape the harness already has, end to end.
- **Gmail · Google Calendar · Outlook mail · Outlook Calendar push "something changed"
  and nothing else.** Verified against the platform docs (2026-08-06):
  - Google Calendar `watch`: *"notification messages … do not include a message body …
    you will need to make another API call to see the full change details"* — headers only
    (`X-Goog-Resource-State`, `X-Goog-Resource-ID`). And explicitly: *"notifications are
    not 100% reliable. Expect a small percentage of messages to get dropped."*
  - Gmail `users.watch`: the Pub/Sub message carries `{emailAddress, historyId}`; you then
    call `history.list` from your last known `historyId`.
  - Microsoft Graph **basic** notifications carry the resource `id` only. **Rich**
    notifications (with resource data) exist but cost subscription lifetime — Outlook
    message/event drops from 10,080 min (~7d) to 1,440 min (~1d) — and require
    certificate-based payload encryption.

**Consequence — the one genuinely new piece of state.** That family needs a per-connection
**cursor**: `historyId` (Gmail) / `syncToken` (Google Calendar) / `deltaLink` (Graph), plus
the watch-channel id and its expiry. A small table beside `connections`:

```
subscriptions(service, connection_address, resource, cursor, channel_id, expires_at)
```

The notification becomes **a wake, not a payload**; the truth comes from the delta query.
That is the same logic as §9's *"an alarm only re-derives what's owed"* — it fits the
grain, and it makes dropped notifications a non-event (the next sync catches up). It is
built ONCE and shared by all four.

**Consequence — the scheduler is a prerequisite, not a peer.** PROJECT #10 (alarms) must
land BEFORE the Google/Microsoft family: every subscription expires and must be renewed on
a timer.

| subscription | max lifetime | renewal |
|---|---|---|
| Gmail `watch` | 7 days | Google recommends calling it **daily** |
| Google Calendar channel | per-channel TTL | no auto-renew — re-`watch` before expiry |
| Graph Outlook message/event | 10,080 min (~7d); **1,440 min if rich** | renew before expiry |
| Graph Teams chatMessage/chat/channel | 4,320 min (3 days) | renew before expiry |

Net new machinery across the WHOLE remaining list: **one table, one renewal job, one
delta-sync helper.** Everything else is the Slack/GitHub shape repeated.

---

## 3. WhatsApp — reuse the bridge, don't rewrite it

`~/open-bsp-whatsmeow` (Go, ~1.5kloc + whatsmeow) is the asset, and it is further along
than a rewrite would reach in months:

- text · media (image/audio/video/document/sticker, encrypt+upload / fetch+decrypt) ·
  reactions · locations · vCards · replies (quote ↔ `re_message_id`) · edits · revokes ·
  delivery/read receipts in · read receipts + typing out · pushnames
- **QR *and* phone-code pairing** with rotation polling, logout, session-death notification
- history sync import (chunked), group subjects → conversation names, **LID → phone
  canonicalization**

Its contract is already liquen-shaped:

- **Inbound**: it POSTs webhook batches to an OpenBSP-side endpoint.
- **Outbound**: `POST /dispatch` `{type, record, media_url?}` → `{external_id, status}`;
  4xx = permanent, 5xx = transient.
- **Pairing**: `POST /sessions` → `{session_id, status: "pending", qr_code?|pairing_code?}`,
  `GET /sessions/pending/{id}` to poll, `GET|DELETE /sessions/{address}`. This is exactly
  §4's *"the pairing CODE is 8 chars of text and flows through the mind conversation"* —
  no dedicated UI needed.
- **`external_id = wmw.<own>.<chat>.<sender>.<id>`** — the sender segment encodes direction
  (sender == own) and the group participant, so reactions and quotes reconstruct the full
  WhatsApp MessageKey with no lookup. Our upsert-on-`external_id` absorbs it unchanged.
- *"Phone-sent messages become outgoing rows"* **is** §4's coexistence case, already solved
  on their side.

**Decision: run it as a sidecar; write `connect/whatsapp/ingest.ts` to satisfy its three
contracts.** The webhook batch → map → `publish` (the ingest half); liquen's dispatch subscriber
→ `POST /dispatch` (the dispatch half); `liquen connect whatsapp` → the session endpoints (the
door). Ports work, not a rewrite. A Baileys/TS reimplementation trades the asset for
cosmetic homogeneity and re-earns every edge case above.

Frictions, all small:

- **Postgres is hard-wired** (`pgx`, `search_path=whatsmeow`,
  `sqlstore.NewWithDB(db, "postgres")`). whatsmeow's `sqlstore` speaks the `sqlite3`
  dialect too, so the local tier is a driver swap — and the keys then ride the **data
  volume**, which is what §4 already prescribes for Docker ("credentials ride the DATA
  VOLUME, never the image").
- **Key custody**: §4 says session keys land in the vault (`kind: "session"`); whatsmeow
  wants to own its own store. Resolution: the bridge owns the key store on the data volume,
  the vault holds a **reference**. The frontier is intact either way — the agent touches
  neither.
- `organization_id` (theirs) ↔ the connection address (ours).
- **One replica by design** — a WhatsApp session is a single WebSocket. Not horizontally
  scalable; fine for Docker-per-org, a constraint to remember on edge.
- Unofficial protocol: ban risk, no templates, no business features. Status/stories and
  newsletters are dropped (not conversations). History media imports as metadata only.

Inherits one open item from Slack, in WA clothing: **principal's personal number →
`mind:<agent>` alias AT INGEST**, before routing (§4) — the agent must never treat its own
principal as a peer.

`conversation.kind` from the jid shape (§4): individual → `direct`, group jid → `group`.

## 4. Slack — landed; two threads dangling

Live smoke passed 2026-08-12 (paste door, alter-ego dispatch, echo merge). Remaining:

- **The mind-alias at ingest** — aliasing the principal's Slack self-DM onto `mind:<agent>`
  requires knowing WHICH `im` is the self-DM. A management step, not derivable from message
  events.
- **Connect options** — `liquen connect slack bot` (xoxb → the workspace anchor) and
  `liquen connect slack socket` (xapp → `slack:socket:<app id>`) are separate doors: an
  identity is workspace-scoped, a carrier is app-scoped, and the ingest opens one socket
  per vaulted app token. Still open: `--agent <name>` / `--shared` — per-agent apps for
  per-agent bots (one bot per app × workspace).

## 5. Gmail — the cursor connector, and it has a "Socket Mode"

Email is a **service, not a tool** (§4) and it is genuinely conversation-shaped: thread =
conversation, message = event, attachments = FileParts, `kind: direct|group` from the
recipient set. It lands in the log honestly.

- **Ingest**: Pub/Sub notification → `history.list` since the cursor → map → `publish`.
- **Dispatch**: `messages.send` with `threadId`; `external_id` = the RFC822 `Message-ID`
  (stable across the loopback — our own sends come back through history and MERGE).
- **The local tier has a pull carrier.** Pub/Sub **pull** subscriptions are Gmail's exact
  analogue of Slack's Socket Mode: push-quality latency with **zero public surface**. The
  edge tier swaps to a push subscription hitting the same handler. One pipeline, two
  transports — the §9 story unchanged.
- **Cursor**: `historyId`, in `subscriptions`. Renewal: `watch` daily (7-day ceiling).
- **Shared inbox** (`hi@org`) = a shared connection every agent reads; personal = that
  principal's. Double-answer coordination is left to coexistence-yield (§4) until observed
  to fail.

**Cost/gating**: a GCP project + a Pub/Sub topic per deployment. `gmail.modify` is a
**restricted** scope — a *public* app faces Google verification plus an annual CASA security
assessment. **The BYO-app-per-org pattern dodges this**: an org-internal app in the org's own
GCP project needs no verification — the same shape as the Slack manifest prefill link
(§4, "BYO-app per org"). Confirm the current exemption wording before the org tier.

## 6. Google Calendar — a tool with an event STREAM, not a conversation

This is the one that does not fit the conversation mould, and it should not be forced into
it. A calendar event has no sender, no thread, no reply — it is not a message.

**Shape: tool + stream.**

- **Tool** (§8 domain tools / the exec plane): list, create, update, find-free-time.
  Principal-owned OAuth — the `principal × tool` cell of the §4 credential grid.
- **Stream**: changes publish into the mind conversation as system-shaped events —
  "meeting moved", "double-booked", "standup in 10 minutes".

**Can we subscribe to changes as events? Yes — with two caveats.**

1. The notification carries **no data** → re-sync with `syncToken` (incremental sync).
   Same cursor machinery as Gmail (§2).
2. **Calendar has NO pull carrier.** Unlike Gmail, `events.watch` requires a publicly
   reachable HTTPS endpoint with a valid CA cert — self-signed, untrusted, revoked, or
   hostname-mismatched certs are explicitly rejected. So: **the local tier POLLS with
   `syncToken`** (cheap — a sync-token query returns nothing when nothing changed) and
   **the edge tier uses `watch`**. A real tier asymmetry, unlike every other connector, and
   worth writing into the deployment table (§9).

**A calendar is an alarm clock.** This item and PROJECT #10 are the same feature seen from
two sides: "meeting in 10 min" is precisely the open question there — *"what event type
carries a wake that must INFORM, since an alarm only re-derives what's owed"*. Build them
together.

## 7. Microsoft — one OAuth, three surfaces, one of them metered

Do the trio as one unit: one Entra app registration, one delegated-OAuth door, three
consumers.

### Outlook mail + Outlook Calendar — cheap, and they reuse everything

Graph subscriptions on `/me/messages` and `/me/events` (also
`/mailFolders('inbox')/messages`), ~7-day lifetime, basic notifications + `delta` queries.
Identical cursor machinery to §5/§6, different API surface. Latency: message <1 min avg
(3 min max), calendar <1 min (3 min max). Ceiling: 1,000 active subscriptions per mailbox
across all apps — irrelevant at our scale. Stay on **basic** notifications: rich would cut
the lifetime to a day and drag in payload-encryption certs, buying only a round trip.

### Teams — v0 is bot-only, and the reason is billing, not capability

§4's call ("Teams v0: bot scope only; agents degrade to signed-bot mode") is **confirmed
correct**:

- **The free door** is a Bot Framework / Azure Bot registration whose messaging endpoint
  receives Activities. A bot sees only what it is in, and there is **no alter-ego leg** —
  delegated posting *as the principal* needs Graph.
- **The Graph door** — change notifications on `chatMessage` (`/chats/{id}/messages`,
  `/teams/{id}/channels/{id}/messages`, `/users/{id}/chats/getAllMessages`) — is a
  **metered / protected API**: it requires the Teams Protected API registration form
  associating the Graph app id with an **active Azure subscription for billing**, and is
  charged per notification.
- Ceilings: 4,320 min (3-day) lifetime, 1 subscription per app × chat, 10 per user for
  all-chats subscriptions, and a **shared per-tenant cap of 10,000 across ALL Teams
  resources** (chats, messages, channels, members, transcripts — one quota; exceeding it
  is a hard `403`).

So Teams is the single connector where the alter-ego model degrades to *signed bot*.
Everything else in the design survives: the bot is a connection credential, the signature
is the agent's identity, the frontier holds.

`conversation.kind`: 1:1 chat → `direct`, group chat → `direct` (member-defined, like
Slack's mpim), channel → `channel`.

---

## 8. Order of work

1. **WhatsApp via the bridge** — biggest reuse, **no new mechanism**, and it closes the
   steering-from-anywhere story (PROJECT v0.2 #10). Pure ports work.
2. **Scheduler / alarms** — PROJECT #10, promoted: a prerequisite for everything below,
   not a peer item. Its first job stays the liveness floor (§2).
3. **Gmail** — introduces `subscriptions` (the cursor) and the pull carrier. Email is
   already a first-class service in the design.
4. **Google Calendar** — reuses (3)'s cursor; adds the tool-plus-stream shape and the
   poll-vs-watch tier asymmetry; converges with (2).
5. **Microsoft trio** — one door; Outlook mail/calendar reuse (3)+(4) wholesale; Teams
   lands bot-only.

## 9. Sources (checked 2026-08-06)

- Google Calendar push notifications — https://developers.google.com/workspace/calendar/api/guides/push
- Gmail push notifications — https://developers.google.com/workspace/gmail/api/guides/push
- Microsoft Graph change notifications (supported resources, lifetimes, latency) —
  https://learn.microsoft.com/en-us/graph/change-notifications-overview
- Teams API payment models and licensing — https://learn.microsoft.com/en-us/graph/teams-licenses
- `open-bsp-whatsmeow` README + source (`~/open-bsp-whatsmeow`)
