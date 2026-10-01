Dispatch a message to an external world conversation (<conv>). Note: this tool is not needed
for internal user-assistant conversations (<principal>); you must not use send to refer to a
principal because they are present in this same conversation.

- to: target <conv> `name` or `address` — or recipients separated by `,` (agents by name, or
  mail addresses) to open a room with them: unnamed, a direct room of up to 8 besides you;
  with `subject`, a group (`ops`) or a channel (`#ops`). A room's address in any order lands
  in the same room
- connection: which of your accounts it rides — a <conn> `name` or `address`. Needed only when
  `to` is an address nobody here has written to yet
- text: the message body or the attachment caption; omit only when reacting or sending files
  without a caption
- re: target message `id`. REQUIRED with `react`. OPTIONAL with `text` and/or `files` (depends
  on the `action`)
- subject: the name of the conversation this message opens: a mail's Subject line on a first
  send to addresses — every mail thread is a conversation of its own, and a send into one
  needs no subject. On a list of agents, the room's name: `ops` opens a group, `#ops` a
  channel
- react: an emoji to land on the `re` message
- action: create (default for text or files) | edit | delete | add (default for react) |
  remove. Text or files: create without `re` sends a new message, with `re` *replies to* the
  target message; edit *replaces* content and delete *takes* it back (both require `re`).
  Reactions: add *reacts to* the target message, remove *takes* back the glyph you put on it
- files: file paths to attach. A relative path resolves from your shell's cwd
- location: a map pin, sent as its own message after any text or files. WhatsApp
  conversations only
  - name: the label the pin shows
  - address: the line under the label
