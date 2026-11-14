# Next batch: Telegram forum topics, removal, history, and what a big room costs

Decided 14 Nov 2026. All eight are settled.

1. A forum's topics are conversations of their own, as a WhatsApp community's groups are.
2. Removing a Telegram account ends its session on Telegram.
3. A sign-in or a pairing imports the last 60 days, silenced, on Telegram and WhatsApp.
4. A muted chat wakes only for the account; an archived chat wakes nothing.
5. A crowded room is silenced: many members, many lines, and the account no admin there.
6. A conversation names the community it belongs to.
7. A WhatsApp broadcast list's message lands in the direct chat it appears in.
8. A WhatsApp channel is a broadcast when the account runs it, and dropped when it follows.

Marks 4 and 5 sit beside `backfill`: a silenced line is stored and searchable, and never
renders or mirrors. `search` is the door to it.

## 1. A forum topic is a conversation

A forum is one supergroup holding many topics, which share its id and its numbering; each
message names its topic. A WhatsApp community is already split, each group its own jid, so
only Telegram needs this.

- **Address.** A topic is `<chat>/<topic>`, the topic being its opening message's id:
  `-1009000/45`. General is topic 1, `-1009000/1`, and takes every line that names no
  topic. A supergroup that is no forum keeps its plain address.
- **Kind and name.** A topic is the kind its supergroup is (`group`, or `channel` with a
  public handle). Its name is the topic's title, "Ventas", and its community the forum's
  (6). The titles are read with the dialogs and kept current by the topics' own service
  messages.
- **`external_id` stays per chat**, `telegram:<account>.<chat>.<message id>`: a line's
  identity is its chat's numbering, whatever topic it sits in. An edit names its topic; a
  delete names only the chat, so its row takes the conversation of the line it deletes,
  read from the log; a reaction takes its target's.
- **Room lines.** What changes the supergroup (a join, a leave, its title, its photo) is
  General's line. What changes a topic (made, renamed, closed, reopened, hidden) is that
  topic's own.
- **Dispatch.** A send to a topic goes into it, as a reply to its opening message
  (`top_msg_id`) when it answers no line of its own.
- **Ports.** `rooms.members`, `join`, `leave`, `add` and `remove` on a topic act on its
  supergroup; `rename` renames the topic.
- **The gap** is read per supergroup, as now, and its lines are split by topic.

Rows the log already holds under a forum's plain address stay where they are.

## 2. Removal ends the session

`liquen remove telegram:<id>` deletes the row and the vault key, and the session stays on
Telegram until someone ends it under Devices. Once the key is gone that session can never
be used again, so ending it loses nothing.

- **Through the process.** Before it deletes the key, the removal asks the running
  connection over its socket to end the account: the process logs the session out, closes
  it, and drops its cache file (`data/telegram/<id>.session`). It answers once that is done.
- **With no process.** When nothing answers on the socket, the removal logs the session out
  itself, with the vault's session and the application's pair, and drops the cache file.
- **What it says.** The removal says the session is ended. If Telegram could not be
  reached, it says so, and points to Devices as it does today.
- **The reconcile** ends an open session only when its row stands soft-deleted
  (`deleted_at` set) and its vault key is gone: two facts a removal writes, neither of
  which a read that comes back short can invent. Any other row it cannot find is closed as
  it is today, the session kept.

## 3. A sign-in imports the last 60 days

History is text: neither wire's import fetches a file's bytes, only its name and kind, as
the WhatsApp bridge already does (old media is often gone from the CDN). So the window
can be wide.

### WhatsApp

A pairing brings the history the phone sends, stamped `backfill`. The bridge sets no limit
today (`RequireFullSync` false, no `FullSyncDaysLimit`), so the phone decides how far back.

- The bridge asks for a full sync of 60 days: `RequireFullSync` true and
  `FullSyncDaysLimit` 60 in the device props, set at start as the device name is.
  `HISTORY_DAYS` in the bridge's environment overrides the 60.
- The device props ride the pairing, so a number already paired keeps what it got; the
  window reaches the numbers paired from then on.

### Telegram

Telegram imports nothing today.

- **What.** At every sign-in, the first and every new one, the process reads each dialog's
  messages of the last `connections.telegram.historyDays` (default 60) and publishes them
  stamped `backfill`, the chat's `muted` and `archived` marks beside it. A followed channel
  is skipped, as everywhere. A file is named on its line and left on Telegram.
- **What counts as history.** After a sign-in, any line dated before the sign-in is
  `backfill`, whichever way it came: the import, or the replay of a cache the session kept.
  A restart is no sign-in: what its replay brings is news, as now.
- **Pacing.** The reads go one dialog at a time and obey a flood wait, as the bio reads do.
  The import runs behind the live session and never holds it up.
- **The cache.** A removal drops it (2), so a later sign-in starts clean and the import
  fills the window back.

The upsert on `external_id` makes an import and a replay of the same message one row.

## 4. Muted wakes only for the account; archived wakes nothing

A phone treats the two apart: a muted chat still badges a mention, an archived one is out
of sight.

- **Muted.** A muted chat's line is silenced, save a line for the account: one whose
  `mentions` name the account, or that replies to one of its lines. That line is news: it
  wakes and renders, the rest of the chat stays silent.
- **Archived.** An archived chat's line is silenced, a line for the account included.
- **Counted.** The window says how much it left out of muted and crowded chats (5) in one
  line, as it says what it left out elsewhere: `— N lines in M muted conversations not
  shown — search to read them —`. Archived chats are not counted.

The marks stay per message, stamped on arrival, never retroactive. What decides "for the
account" is the core's, read off `mentions` and the reply's target, the same for every
connector.

## 5. A crowded room is silenced

A room is crowded when all three hold:

- it has more than `crowd` members (default 20);
- more than `busy` lines landed in it in the last 24 hours (default 40), so a big room
  that is calm and informative is read;
- the account is not an admin or an owner there, so a room the account runs is read.

A crowded room's line is stamped `extra.crowded`, a silencing mark beside `backfill`,
`muted` and `archived`, and treated as a muted one (4): a line for the account is news,
the rest is counted and searchable.

- **The wire's part.** Each connector with rooms stamps two facts it already reads on the
  conversation: how many members it has, and whether the account administers it.
  WhatsApp, Telegram, Slack and Teams.
- **The core's part.** The ingest applies the rule, the same for every wire, counting the
  24 hours from the log.
- **Knobs.** `shared.connections.crowd` and `shared.connections.busy`, which every
  connection inherits and `connections.<service>` overrides, as `shared.agents` and
  `agents.<name>` do. `connections.<service>.follow` lists the rooms always read, whatever
  the rule says.

A forum topic counts its supergroup's members (1).

## 6. A conversation names its community

A conversation that belongs to a larger one says so: a Telegram forum's topic, a group in
a WhatsApp community, a Teams channel in its team.

- **The envelope.** `conversation.community`, the container's name, beside `name`.
- **Render.** `<conv kind="group" name="Ventas" community="Obra" address="-1009000/45">`.
  RENDER.md's World table takes it.
- **WhatsApp.** The bridge stamps a group's community on every message, from the group's
  linked parent, not only on the room lines that link or unlink it.
- **Teams.** A channel's name is its own, "General", and the team is its community, where
  today both sit in `name` as `Team / Channel`.

## 7. A WhatsApp broadcast list lands where it appears

- **Received.** A message someone sent through a broadcast list shows on the phone in the
  direct chat with them, so it lands there: a `direct` conversation at the sender's
  address.
- **Sent.** The account's own message to a list shows on the phone as the list's chat, so
  it stays one `broadcast` conversation at the list's address.

What whatsmeow says of a received one is to be read off a live message first.

## 8. A WhatsApp channel, as a Telegram one

A channel (a newsletter, `…@newsletter`) the account owns or administers is a `broadcast`
conversation; one it only follows is dropped, as Telegram drops a channel it follows. Its
followers are anonymous and its reactions are counts, so a post's lines carry no reactor.
The bridge drops every newsletter today, in its live events, its history and its rooms; it
carries the ones the account runs, by the role whatsmeow reports.

## Docs

- CONNECTORS §10 ("Addresses", "The accounts follow the store", "Room lines", the history
  import), the WhatsApp section (broadcast lists, channels, the community stamp), and each
  room connector's members and admin facts.
- DESIGN's silencing marks (`crowded`, and muted's line for the account), and the knobs in
  §9.
- RENDER.md: `community=`, and the count of what muted and crowded chats left out.
- PROJECT's open items on forum topics and on a removal taken up by the tick.
