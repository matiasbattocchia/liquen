# Next batch: Telegram forum topics, and a removal that ends the session

Decided 14 Nov 2026. Both are settled.

1. A forum's topics are conversations of their own, as a WhatsApp community's groups are.
2. Removing a Telegram account ends its session on Telegram.

## 1. A forum topic is a conversation

A forum is one supergroup holding many topics, which share its id and its numbering; each
message names its topic. A WhatsApp community is already split, each group its own jid, so
only Telegram needs this.

- **Address.** A topic is `<chat>/<topic>`, the topic being its opening message's id:
  `-1009000/45`. General is topic 1, `-1009000/1`, and takes every line that names no
  topic. A supergroup that is no forum keeps its plain address.
- **Kind and name.** A topic is the kind its supergroup is (`group`, or `channel` with a
  public handle), named `<forum> / <topic>`: "Obra / Ventas". The titles are read with the
  dialogs and kept current by the topics' own service messages.
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
- **The reconcile** ends an open session only when its row and its vault key are both gone.
  A row gone with its key still in the vault is closed as it is today, so a read that
  comes back short never costs an account its session.

A new sign-in after a removal starts with an empty cache: nothing from the time the account
was removed is replayed.

## Docs

CONNECTORS §10 ("Addresses", "The accounts follow the store", "Room lines"), and PROJECT's
open items on forum topics and on a removal taken up by the tick.

# Next batch: every installation a Slack delivery reached, and a DM with the bot kept private

Decided 14 Nov 2026, driven by turtle: the shared bot steers sonar from `#sonar`, and each
member's DM with the bot is their augmented self's. All four below are settled.

1. A live delivery carries every installation that sees it, as a catch-up read already
   does, so a line the bot saw anchors to the bot.
2. A DM with the shared bot never reaches the shared inbox: it is its sender's own agent's
   surface, or nobody's.
3. A member's DM is recorded on the workspace stub, whichever installation Slack named, so
   the whole conversation lives there: their lines, the agent's copies out, the echoes.
4. `liquen connect slack app` lists the scopes the app-level token needs.

## 1. The delivery's installations, completed

Slack sends one event per app and names one installation in `authorizations`. When that
one is not the bot and the event carries an `event_context`, the ingest asks
`apps.event.authorizations.list` for the whole list, following the cursor, before any
branch reads it. Messages, reactions, room lines, adoption and the membership mirror then
read the list as they do: the row anchors to the bot when the bot is in it, and every
member grant in it is enrolled.

- The call uses the delivering app's own app-level token: `api_app_id` → the vault's
  `slack:socket:<app id>`. The envelope type gains `api_app_id` and `event_context`.
- A delivery that names the bot already anchors right, and its rows are shared, so it makes
  no call; a workspace with the bot alone never does. An `im` anchors to the stub whoever
  saw it (2), and the list still says whether the bot is in it, which decides whether it
  is recorded (3).
- No app-level token, a refusal (`missing_scope`, `ratelimited`) or a network failure leaves
  the delivered entry standing, said once per app and reason. The call is bounded short,
  since the socket acks on the handler's answer and HTTP has Slack's three seconds.
- No new column: a row the bot saw is read by every agent, and a room without the bot is
  read through the memberships the list enrolls.

## 2. A DM with the shared bot is nobody's but its sender's agent

An `im` with the bot anchors to the workspace stub (`<team>`), which grants nothing of
itself, live, in the catch-up and on its echoes alike. No agent reads it through the shared
inbox, so sonar never sees, nor answers, a DM meant for someone's own agent.

- A member's DM is their own agent's surface when that agent runs and counts them, as now:
  hidden from every agent, copied into their mind, and answered through the bot, since a
  crossing onto a shared row speaks with the bot's token.
- A DM from someone with no agent, a paused one, or a guest is read by nobody until an agent
  of theirs runs, and from then on only its new lines reach it.
- A group DM with the bot (`mpim`) is a room, and stays on the bot.

## 3. Recorded on the stub, whoever Slack named

`recordDm` writes `mirrors.dms` on the workspace stub, the row every `im` with the bot
anchors to, when the bot is among the delivery's installations, so a DM Slack attributed to
a member's own grant is recorded all the same, and a member's DM with a colleague, seen by
their grant alone, never is. The
alias then names the stub, and the mirror's copies out ride it too: when the alias drops,
the agent paused or no longer counting them, the agent's own lines there stay out of the
shared inbox with the rest. The view's shared-row branch reads the stub as it reads the
bot's row; the bot's row records no DM.

## 4. The door lists the scopes

When `liquen connect slack app` asks for the app-level token, it lists the scopes that
token needs, `connections:write` and `authorizations:read`, since the console asks for them
by hand; the bot and user scopes come from the manifest it opened.

## Docs

DESIGN §4: the "a workspace runs in ONE mode" assumption goes, since a bot beside member
grants is the shape now, and "`is_bot` in `authorizations` names it per event" becomes the
completed list; "A member's DM with the shared bot" says a stranger's DM is nobody's.
CONNECTORS' Slack section takes the scope and the fallback. PROJECT closes the open notes in
the steering and witnesses entries, and notes what stays open: two Slack apps in one
workspace each complete only their own list, and calling on a bot-named delivery would
enroll members nothing reads today, which revisits if shared rows stop being read by all.
