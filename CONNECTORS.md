# CONNECTORS — the channel roadmap

*Companion to [DESIGN.md](DESIGN.md) (§3 ingest-as-classifier, §4 identity/credentials, §9
deployment tiers) and [PROJECT.md](PROJECT.md) (the arc). This file is the per-service map:
what each connector costs, what it reuses, and where it breaks the mould. Status
2026-09-23. Landed: GitHub (v0.1 preview), Slack (live smoke passed
2026-08-12), Google (calendar poll + `gws` grant), Microsoft (the door + the Graph skill).*

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
every liquen process ends by. A deep
import from a connector is a contract violation, not a convenience.

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
no proxy or main change per tool. A service with no connector at all takes the same row
from the shipped `token` door (`liquen connect token <name> --env <VAR> --hosts <list>`,
`src/connect/token/connect.ts`): a pasted bearer under `token:<name>` (the org's) or
`token:<name>:<agent>` (an agent's own), and nothing else — no connection, no membership,
no event, because a tool credential is capability, not identity. A handle a tool base64s
or signs over (Basic, SigV4) can't ride this path; such schemes belong broker-side.

A connector's subsection holds what is **that service's**: the addresses of its wire, the
scopes it asks for, the events it maps, the tenant it files the org under. A value that is
merely *arbitrary and fixed* is a constant at the top of the file that uses it, not a knob:
how often the pairing door polls the bridge is `POLL_MS` in `whatsapp/connect.ts`. And
liquen's own address is stated once at most — to a service that keeps it, by the door
that hands it over (below).

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

### Presence: nothing to build

`[agent thinking...]` and `[agent compacting...]` reach a surface as ordinary log rows: the
mirror's CC of a `delta` event in the mind, carried by whatever dispatcher already serves
that surface, the way a gate's `[agent asks]` card is. A connector does nothing to get them
— no filter, no code at all, including a connector that is a serverless function. Your
service's echo of the send merges into the committed row by `external_id` the way every
echo does. The CC is marked `extra.delta`, and the one thing that mark means is that the
sweeper never re-offers it. See §9 in DESIGN.md.

### The address book: the service keeps it, the name carries it

A service that keeps an address book — the phone's, behind WhatsApp; Google Contacts —
keeps it, and what liquen holds of it is the names it already receives. The connector's
port (`XiPorts.contact`, one per service that keeps a book) has both legs, and each
answers within its call and keeps no queue behind it: the tool result is the whole
outcome, and a failed call is the model's to make again.

`write` is the `contact` tool's. Saving someone is a naming act, and a name reaches rows
from their next message on, the way every rename here does. `lookup` is `search`'s: a
`from` names a person, and a person is in two places — the rows they wrote and the books
they are saved in — so both are asked and the page has a place for each: the entries first,
as `<contact>` lines under the `<conn>` of the account holding them, then the rows. That is
what makes somebody saved and never heard from findable, and it puts the read on the same
port, the same gate and the same tool the write already goes through. A service may keep
one leg and not the other; the `contact` tool is offered where `write` is, and `search`
asks whichever accounts have `lookup`. A book that cannot be reached is named in a line of
its own rather than failing the search, because the log is the answer being asked for.

What the connector does report, on every message, is whose word the sender's name is:
`sender.saved` when it came from the account's address book, absent when it is the
sender's own (a pushname, a storefront). The line's hint reads it — `contact="…"` against
`external="…"`, the same outsider — and `contact(who, name)` is what moves a person from
one to the other. That hint is also how a change made elsewhere arrives: a save typed on
the phone shows up as the name and the hint on the next line from them. A service with no
address book stamps nothing: every outsider wears `external`, and the tool is not offered
on its accounts.

### Outbound media: the pull leg, signed and relative

Most services take a file by **push** — Slack's `files.uploadV2`, Gmail's MIME body: liquen
reads the bytes and sends them. Some take a **link** the service fetches instead (the
whatsmeow bridge, Twilio's `MediaUrl`, the Cloud API's `link`), and for a file in
`data/media` that link has to point back at liquen.

It points back **relatively**. `signMediaPath` (`store/media.ts`) mints `/m/<payload>.<mac>`
— the absolute path and an expiry, HMAC'd with a key in the vault — and the service
resolves it against the address it already delivers to. That address is the connector's
own ingest: the same door the service posts events at serves `/m/…`, so the ingest's
address is said once, not once per leg. Who says it is the pairing door: the whatsmeow
bridge is one sidecar for many orgs, and `liquen connect whatsapp` registers this org's
ingest as the session's `webhook_url`, which the bridge keeps with the session and dials
for everything about it — batches, media, lifecycle, and the relative media path. The
value is `connections.whatsapp.ingestUrl`, null ⇒ localhost on `ingestPort`, which holds
whenever the sidecar shares the host; a bridge in a container declares the one it can
reach.

Three properties come from signing rather than remembering: verification holds no state,
so the ingest and the dispatch can be different processes; a restart doesn't invalidate a
path the service hasn't fetched yet; and a retry re-fetches freely, since serving one
doesn't consume it. The store's boundary is still checked on its own — a signature proves
who minted a path, never that the path is innocent.

Two homes, one shape (role-named files, each optional — `ingest.ts` · `dispatch.ts` ·
`oauth.ts` · `connect.ts`):

- **Shipped** — `src/connect/<service>/` (slack, google, whatsapp, github, microsoft).
  Cross-service helpers (`flavor.ts`, `mentions.ts`, `mirror.ts`, `errors.ts`, `status.ts`)
  and the grammars a kind of connector shares (`poll.ts`, `calendar.ts`, `mail.ts`) live at
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
  delivery/read receipts in · read receipts + typing out · pushnames · the address book,
  both ways (`sender_saved` on every message it names, `POST /dispatch` `{type: "contact"}`
  to write an entry, `GET /contacts/{address}?q=…` to look one up — on a fork of
  whatsmeow carrying `tulir/whatsmeow#1247`)
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

## 5. Gmail — the mail connector, polled

Email is a **service, not a tool** (§4) and it is genuinely conversation-shaped, so it lands
in the log as one. The rows ride the GRANT — `service: google`, the account's connection —
the way calendar rows do, so one connection row and one process carry an account whole.
The conversation is the **other parties**: every address on From/To/Cc but the account's
own, lower-cased, sorted, comma-joined (`ana@x.com`; `a@x.com,b@y.com` for a group),
`kind: direct` — member-defined, the mpim rule — with the subject, its `Re:`/`Fwd:`
prefixes off, as `conversation.thread`; render breaks a run on a thread change, so each
subject prints as its own `<conv … thread="…">`. `external_id` is `mail:<Message-ID>`, the
one name a message has on every wire; an inbound `In-Reply-To` is the row's `reply`
reference. The body is the plain text with its quoted history cut (`stripQuotes`: the
`On … wrote:` attribution, Outlook's separator, a forwarded header block, a trailing `>`
block); an HTML-only body is read as words. Attachments are file parts on the media shelf;
inline images are not attachments. All of that is `src/connect/mail.ts`, shared with
Outlook: a mail connector is its wire, nothing more.

- **Ingest**: a poll on the mailbox's `historyId` (`history.list`, `messageAdded` records,
  a message in INBOX or SENT and not DRAFT), each listed message read in full; a first run
  takes the profile's id and publishes nothing; a `404` on the start id drops the cursor.
  Gmail's history is mailbox-wide, so a grant has one cursor. Pub/Sub **pull** is the edge
  tier's carrier for the same map/publish — a wake, not a payload (§2).
- **Dispatch**: `messages.send` with a MIME the harness authors (`raw`), its `Message-ID`
  minted in the account's domain, so the send stamps its own `external_id` and the SENT
  copy comes back through the poll as the echo that MERGES (§4). A reply carries
  `In-Reply-To`/`References` and the referent's `threadId` (`extra.google.thread`); a new
  thread is `send(subject:)`. Mail has no edit, delete or reaction: those sends fail with
  a 400 rather than vanish.
- **Scopes**: `gmail.readonly` + `gmail.send` in the defaults; the poll runs only on a grant
  whose recorded consent carries a read scope, so a grant from before mail keeps its
  calendar and takes mail on re-consent.
- **Shared inbox** (`hi@org`) = an ownerless grant every agent reads; personal = that
  principal's. Double-answer coordination is left to coexistence-yield (§4) until observed
  to fail.

**Cost/gating**: `gmail.readonly` is a **restricted** scope — a *public* app faces Google
verification plus an annual CASA security assessment. **The BYO-app-per-org pattern dodges
this**: an org-internal app in the org's own GCP project needs no verification — the same
shape as the Slack manifest prefill link (§4, "BYO-app per org"). Confirm the current
exemption wording before the org tier.

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

## 7. Microsoft — one Entra app, one Graph token, three surfaces

Google's shape at Microsoft's wire (`src/connect/microsoft/`): the `app` door pastes an
Entra app registration (client id, secret, the tenant it lives in) into the vault; the
`account` door serves one delegated sign-in at `login.microsoftonline.com/<tenant>` and
writes the grant — `microsoft:<upn>`, `refresh_token` + `access_token`, fronted to agent
bash as `MICROSOFT_GRAPH_TOKEN` toward `graph.microsoft.com` alone. The broker refreshes at
the tenant's token endpoint and keeps the rotated refresh token. The declared section
runs no process (`RUNNING` in `connect/connect.ts`): until an ingest exists, the connection
is a credential.

**The agent's tool is `fetch` and a skill** (`src/seed/system/skills/microsoft-graph.md`,
laid into `data/system/skills/` by `liquen connect microsoft app`, so an org carries it iff it
connected Microsoft).
Nothing from Microsoft plays `gws`'s part: the Graph CLI `mgc` is retired (2026-08-28);
the PnP `m365` CLI has no token-from-env mode — its only route through the proxy is a
seeded token cache, at ~360 MB of `node_modules` and a second of startup, and its escape
hatch `m365 request` is `fetch` again; Work IQ mints tokens for its own service, not Graph,
and is licensed apart. Graph is plain REST whose paging and delta hand back complete URLs,
so the discovery a CLI would add is a page of paths the skill carries. A `graph` shim
beside `fetch` is the upgrade if paging proves clumsy for the model.

**One token, one audience.** A Graph token is spendable at Graph only; SharePoint and
Exchange Web Services would each be another token from the same sign-in, and a grant row
fronts one. Everything below stays inside Graph.

**Consent.** Per-permission and cumulative: a later ask for `Mail.Send` adds to a grant
that began as calendar. `Chat.ReadWrite`, `ChatMessage.Send`, `ChannelMessage.Send`,
`Mail.*`, `Calendars.*` need no admin in Graph's own table, but Microsoft's managed
default consent policy withholds most of them from a member's own consent, so a BYO app
per org should expect its admin to grant them on the registration once.
`ChannelMessage.Read.All` is admin-only outright. Personal accounts (outlook.com) reach
mail and calendar, never Teams, and only through a registration whose audience includes
them.

### Outlook mail + Outlook Calendar — the cursor connector, Graph flavour

Delta queries and polling are within Outlook's terms. **Mail** is `/me/mailFolders/<folder>
/messages/delta` on Inbox and Sent Items — the two sides of every conversation — one
deltaLink per folder on the grant, asked for ids alone and each id read back in full with
`internetMessageHeaders` (the `In-Reply-To` a reply threads by comes only on a single
message's read) and the body as text (`Prefer: outlook.body-content-type`); a first run
asks `$filter=receivedDateTime ge now` and publishes nothing; an `@removed` is a message
leaving the folder, not one unsaid, and publishes nothing; attachments come with their
bytes in the folder's `attachments` listing, `isInline` ones left out. Sending is `POST
/me/sendMail` with the MIME itself as the base64 body: Exchange threads by the `References`
header and keeps its copy in Sent Items, where the poll finds it under the Message-ID the
MIME already wore. The mapping is `src/connect/mail.ts`, shared with Gmail (§5).

For the **calendar** the feed is the events delta — `/beta/me/calendar/events/delta
?startDateTime=now`, the one Graph feed that runs from a point forward, unbounded, and
lists series masters and single events, which is Google's `syncToken` shape. Its rows carry
only `id`/`type`/`start`/`end`, so each change is one `GET /v1.0/me/events/<id>` for its
content, asked in UTC as text; a removal is `{id, "@removed"}` and needs none. The `/beta`
prefix is the feed's address; the resource read back is v1.0's. (v1.0's own
`/me/calendarView/delta` is bound to a fixed window for the life of its token, expands
series into instances, and reports an event created *outside* the window as `@removed` —
a create indistinguishable from a delete.) The cursor is the `@odata.deltaLink`, kept on
the grant; a `410` re-bootstraps. The mapping is shared with Google in
`src/connect/calendar.ts` — the row grammar — over the poller both kinds share
(`src/connect/poll.ts`: the cursor, the sweep, the resident loop), so a connector is its
wire and its pruning, nothing more. Push (subscriptions on `/me/messages`, `/me/events`,
~7-day lifetime, basic notifications) is the edge tier's carrier for the same map/publish.
Ceilings: 10,000 requests per 10 minutes and 4 concurrent per mailbox.

### Teams — delegated Graph, pushed

The member's own leg, on the same grant as mail and the calendar (`src/connect/microsoft/
teams.ts`): a delegated subscription reads what the member sees and the member's token
posts as them. The Teams APIs are unmetered (no Azure billing, no payment model, nothing to
register beyond the app), and their terms allow a poll **once a day**, so the ingest is a
Graph **change notification** or nothing.

**The subscriptions.** One per grant over every chat the member is in
(`/users/<oid>/chats/getAllMessages`, `Chat.ReadWrite`) and one per channel of every team
they are in (`/teams/<team>/channels/<channel>/messages`, `ChannelMessage.Read.All` — a
permission a tenant's admin grants on the registration). A channel subscription is one per
channel for the whole app: the first grant to reach it holds it, the others meet a 409 and
leave it. Each lives 4,320 minutes at most; the shared sweep (`connect/poll.ts`) creates
the missing ones, renews those inside their last day, lists teams and channels again once
an hour for new ones, and records each on the grant (`extra.teams_sub`, by resource path:
id, expiry, and the `clientState` secret its notices must echo). Lifecycle notices ride
the same endpoint: `reauthorizationRequired` renews, `subscriptionRemoved` drops the record
so the sweep recreates, `missed` is said on stderr.

**The carrier.** Graph pushes to a public HTTPS endpoint only — it validates it at
subscription time (`POST ?validationToken=…`, answered plain within ten seconds) and
expects a 2xx within three seconds on every notice. So `connections.microsoft.notificationUrl`
is where Graph dials — the org's tunnel (cloudflared, Tailscale Funnel) or its edge — and
the ingest serves `ingestPort` behind it: a webhook `(Request) => Response` that echoes
the handshake, checks each notice's `clientState` against the record, acks 202 and reads
the message back behind the ack. No URL declared ⇒ nothing is subscribed, the dispatch
still sends, and the boot says so once. Event Grid is not this carrier: its delivery has
no `created` change type, and it needs an Azure subscription and a second token audience.

**The rows.** A notice carries the resource path and nothing else (the rich form needs a
certificate and shortens the lifetime), so each is one `GET` of the message. A chat is a
conversation addressed by its id — `direct` when Teams calls it oneOnOne or group, `group`
when it is a meeting's — named for the other member, the topic, or the other members; a
channel is `<team id>/<channel id>`, `channel`, named `Team / Channel`. A channel reply is
a `reply` to its root; a chat is flat, and a quoted reply there (`messageReference`) names
the message it answers. `external_id = teams:<address>:<id>`, so the same message reaching
two members' subscriptions merges, as does the member's own send with its echo. An edit is
its own event keyed by the edit's time, a delete marks the row and adds a delete event, a
reaction (an `updated` that edited nothing) is one `add` per reactor keyed by who and
what — a notice repeated lands once. The sender is the Teams user id; one that is a grant's
`oid` is that member (`agent.id`), and the member whose subscription delivered a chat is a
member of it. The body is HTML: `<at>` becomes `@Name` and `payload.mentions`, `<emoji>`
its glyph, a hosted image (a pasted screenshot) its bytes on the media shelf, a `reference`
attachment its bytes through `/shares/<encoded url>/driveItem/content` (`Files.ReadWrite`),
or a link in the words when the grant cannot read it.

**The dispatch.** Common markdown becomes Teams' HTML (`<b>`, `<i>`, `<s>`, `<code>`,
`<pre>`, `<a>`, `<br>`), a claimed `@Name` an `<at id>` with its `mentions` entry. A channel
reply posts under the referent's root; an edit is a `PATCH`, a delete a `softDelete`, a
reaction `setReaction`/`unsetReaction` with the glyph. A local file is uploaded first — to
the channel's own folder (`filesFolder`), or to the account's OneDrive under `liquen/` with
an organization view link — and rides as a `reference` attachment whose id is the item's
eTag GUID; an external link joins the words. The response's `id` and `from.user.id` stamp
the row.

Ceilings: reading is 1 rps per chat or channel; 10,000 Teams subscriptions per tenant
across all apps.

## 8. Order of work

1. **WhatsApp via the bridge** — biggest reuse, **no new mechanism**, and it closes the
   steering-from-anywhere story (PROJECT v0.2 #10). Pure ports work.
2. **Scheduler / alarms** — PROJECT #10, promoted: a prerequisite for everything below,
   not a peer item. Its first job stays the liveness floor (§2).
3. **Gmail** — landed as a poll on `historyId` with the send as an authored MIME; the
   pull carrier remains the edge tier's.
4. **Google Calendar** — reuses (3)'s cursor; adds the tool-plus-stream shape and the
   poll-vs-watch tier asymmetry; converges with (2).
5. **Microsoft trio** — the door, the Graph skill, the Outlook calendar poll and Outlook
   mail landed on the grammars (3) and (4) share; Teams landed on delegated Graph, pushed
   to a declared public URL and kept alive by the same sweep.

## 9. Sources (checked 2026-08-06)

- Google Calendar push notifications — https://developers.google.com/workspace/calendar/api/guides/push
- Gmail push notifications — https://developers.google.com/workspace/gmail/api/guides/push
- Microsoft Graph change notifications (supported resources, lifetimes, latency) —
  https://learn.microsoft.com/en-us/graph/change-notifications-overview
- Teams API payment models and licensing — https://learn.microsoft.com/en-us/graph/teams-licenses
- Graph permissions reference — https://learn.microsoft.com/en-us/graph/permissions-reference
- Graph CLI retirement — https://devblogs.microsoft.com/microsoft365dev/microsoft-graph-cli-retirement/
- CLI for Microsoft 365 — https://github.com/pnp/cli-microsoft365 (`src/Auth.ts`, `src/request.ts`)
- Graph notifications via Event Grid — https://learn.microsoft.com/en-us/azure/event-grid/subscribe-to-graph-api-events
- `open-bsp-whatsmeow` README + source (`~/open-bsp-whatsmeow`)
