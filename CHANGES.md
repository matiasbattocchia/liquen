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
