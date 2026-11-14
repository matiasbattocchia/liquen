# Next batch: the connect tool, and an agent that provisions agents

Decided 14 Nov 2026. All six are settled.

1. An agent signs an account in through a `connect` tool, for itself or for another agent.
2. Main holds every sign-in in flight: one door per service, a ticket per sign-in, and the
   CLI runs through it.
3. A reconnect is pinned to its account.
4. A sign-in for another agent lands only when the account is theirs.
5. An account that signs out says so in its owner's mind.
6. An agent makes agents through an `agent` tool.

## 1. The connect tool

`connect({service, account?, for?})` answers with what the person signing in must do, and
until when: a link to open, or a code and where to type it. The agent passes it on in its
own words, in its principal's room for itself and through `send` for anyone else. Whether
the sign-in lands or fails, the caller hears it where the call was made (2).

- **Services.** The ones whose sign-in travels in a message:
  - a link: Google, Microsoft, Slack's user leg;
  - a code the person types at the service: WhatsApp's pairing code, GitHub's device flow.

  Any other service is refused with the CLI command that connects it.
- **WhatsApp** takes the pairing code only, since a QR rotates too fast for a chat. The
  phone is the one on the row of the agent the grant is for; a row without one refuses the
  call and says to set it.
- **Slack** needs `edge.publicUrl`, since its redirect is HTTPS with no loopback; without
  it the call is refused. A Google or Microsoft app whose redirect is loopback still
  answers, and the answer says the link opens only on the org's machine.
- **GitHub** needs an app with a client id in the vault. A pasted token stays the CLI's.
- **New or again.** Without `account`, the sign-in is a new account for the caller, or for
  `for` (4). With `account`, it is a reconnect (3), and a shared account is one the tool
  may sign in again. A new shared account stays a CLI act (`--shared`).
- **The gate.** `{ tool: "connect", action: "ask" }` joins the default rules, beside
  `contact`.
- **The offer.** `connect` joins `DEFAULT_TOOLS`. An org whose `config.yaml` lists `tools`
  adds it there.
- **The doc.** `src/seed/system/tools/connect.md`.

## 2. Main holds the sign-ins

Every sign-in in flight, from the tool or the CLI, is one entry in main, keyed by service
and who: the account for a reconnect, the agent the grant is for when it is new.

- **The same key** while one is open gets that one back: the same link or code, the same
  deadline. Nothing new starts, and a phone is never linked twice.
- **One door per service.** Main serves a link service's handler on
  `data/run/<service>-oauth.sock` while any of its sign-ins is open, and stops when the
  last one lands or lapses. Several sign-ins share the door, so five members signing in at
  once never queue.
- **The ticket.** A link carries a one-time ticket instead of `?agent=`, and `/start`
  refuses a link without a live one, so nobody can edit a link into someone else's. A link
  may be opened again until its sign-in lands; the first callback settles the ticket, and
  a later one is refused.
- **Deadlines.** A link lives 15 minutes (`SIGN_IN_MS`). A code lives as long as its
  service keeps it: about 3 minutes for a WhatsApp pairing code, GitHub's `expires_in` for
  a device code.
- **Where a ticket lives.** In the vault, in a table of its own beside `oauth_states`:
  - the ticket's id, its service and its key;
  - what it binds: the agent, the pinned account, the scopes, the caller and its session;
  - what its poll needs: the bridge's pending session, GitHub's device code;
  - its own deadline, since a state's fixed 10 minutes is shorter than a link's life;
  - whether it settled.

  A unique index on the key over unsettled rows makes the same key's second call find the
  open one. `/start` mints an ordinary state pointing at the ticket, one per click. The
  callback settles the ticket in one `UPDATE`, as a state is consumed, and a sweep settles
  one past its deadline as lapsed. A ticket for an agent that is removed goes with it, as
  its keys do.
- **Restarts.** Main reads the open tickets at boot, serves the sockets they need, and
  resumes their polls.
- **What stays in the vault.** The answer carries the link, or the code the person types,
  and the log keeps it. GitHub's `device_code`, which redeems the token once the person
  approves, stays in the ticket.
- **No count limit.** Every tool call waits on the principal (`ask`), and that is the
  throttle.
- **The outcome.** A sign-in that lands writes what its door writes today, and declares
  the connection when it is new, with a reload. WhatsApp's pairing waits for its ingest
  first, as its door does. The caller hears the outcome once, where the call was made:
  landed, lapsed, or came back as the wrong account (3, 4). The person signing in reads
  the same on the page.
- **The CLI runs main's door.** `liquen connect google account`, `microsoft account`,
  `slack user`, `whatsapp` and `github user`'s device flow ask main for the sign-in over
  `data/run/main.sock`, flags and all (`--shared`, `--app`, `--scopes`, `--phone`). They
  open the link here or print it to send, as today, and wait for main's word. Main answers
  with a stream: the link or the code, each new QR, then the outcome. So the CLI and the
  tool share one table, and each handler has one server. A shared grant is asked over this
  socket alone, never by the tool. The doors already wait for the edge, and `liquen start`
  runs main first.

Telegram, Mercado Pago, `token`, `ai` and the app doors keep their own flow: each takes a
secret at the terminal.

## 3. A reconnect is pinned

`account` names a connection the caller may sign in again: one it owns, one `for` owns, or
a shared one.

- **The same account or nothing.** A sign-in that comes back as another account writes
  nothing.
- **The hint.** Google's and Microsoft's links carry the account as `login_hint`, so the
  right one comes preselected.
- **What it keeps.** The row's owner, and the scopes the vault records for the grant (the
  catalog's when it records none), so a grant that held more than the default keeps it.

Without `account`, a sign-in that comes back as an account someone else owns, or as a
shared one, writes nothing. One that comes back as an account the grant's owner already
holds is that account, signed in again.

## 4. For another agent

`for: "ana"` binds the grant to ana's agent, and lands only when the verified account
matches a handle on ana's row:

- email, for Google, Microsoft and Slack: the id token's address, the Entra UPN, the Slack
  member's profile email;
- phone, for WhatsApp, which is also the number the pairing code is minted for (1).

A row without the handle refuses the call and says which to set. GitHub takes no `for`,
since its account carries no handle the row keeps. A grant for the caller itself checks
nothing, as the CLI checks nothing today.

## 5. Signed out is said in the owner's mind

A row that moves to `signed_out` (`setState`, the move read against the row as stored)
publishes one line into its owner's mind:

`<system kind="signed_out" since="14:02">google ana@example.com is signed out; connect
signs it in again</system>`

- **Once.** Only the move writes it, so a restart into the same state says nothing.
- **Owned rows only.** A shared account's sign-out stays the anchor's down line, which
  every agent already reads.
- **Sleep.** It wakes the agent as the world's lines do, so inside the agent's sleep hours
  it waits for the morning.
- **The tool's name.** The line names `connect` only to an agent offered it.
- **Back.** A sign-in that lands brings the row back as today, and its grant note is the
  news.

RENDER.md's table takes the line, and the system instructions describe it.

## 6. The agent tool

`agent({id, name?, email?, phone?})` makes an agent as `liquen agent <id>` does
(`upsertAgent`): its row, its folder with `instructions.md` and `memories.md`, and main
brings it up.

- **Makes only.** An id that exists is refused. Changing or removing an agent stays the
  CLI's, since a handle moved onto another agent would move whose lines steer it.
- **Settings** inherit from `shared.agents`, and principals are derived from ownership, as
  a new row's are.
- **The gate.** `{ tool: "agent", action: "ask" }` joins the default rules.
- **The offer.** `agent` stays out of `DEFAULT_TOOLS`: an agent is offered it when its
  `tools` names it, or when it is offered everything (null).
- **Provisioning** is two calls: `agent({id: "ana", email: "ana@example.com"})`, then
  `connect({service: "google", for: "ana"})`, the link sent to ana over a channel the
  caller holds.
- **The doc.** `src/seed/system/tools/agent.md`.

## Not in this batch

- A served page for the services that take a secret (Telegram's code and password,
  Mercado Pago, `token`, `ai`, the app doors), so they too come through the tool.
- A standing link that names nobody, and the enrollment of whoever signs in with it.
- An org's own connectors' doors through main.
- Changing or removing an agent by tool.

## Docs

- DESIGN §4 and §9: the sign-ins in flight, the ticket, the CLI over main's socket, the
  two tools.
- CONNECTORS: the doors' shared part (`door.ts`), and each link and code service's
  section.
- RENDER.md: `<system kind="signed_out">`, and the two tools' results.
- The system instructions: the signed-out line, and how a link or a code is passed on.
