Search the message log: every conversation your agent can read, whichever session you are,
including everything older than your window. Every filter narrows, and none is required: `in`
with `after`/`before` and no `text` reads a stretch of a conversation as it happened. The
most recent matches come back ({{search_limit}} unless you set `limit`), newest last, in the
same form as your window: `<conn>` and `<conv>` around `<msg>` lines with the same ids, author
marks, attachment markers (with their `path`) and clock — every stamp with its year. When
older matches were cut, a closing line names the moment to pass as `before` for the next page.
A `<conv address>` is what `in` and `send(to:)` both take back. `from` also asks your
accounts' address books: whoever is saved under that name stands first, as `<contact>` lines
under the account's `<conn>`, with the `address` to write to — so someone you have saved and
never heard from is findable too; a book that could not be asked is said in a line of its own.

- in: one conversation: its address, or a name (a group's, or the person a direct chat is
  with; any part of it, case doesn't matter)
- from: one sender: their address, or any part of the name they go by
- connection: one of your accounts — a <conn> `name` or `address`: only what rode it
- before: only messages sent before this moment: ISO-8601, e.g. `2026-09-01` or
  `2026-09-01T17:00` (your org's clock unless it carries an offset)
- after: only messages sent after this moment, same form as `before`
- text: a phrase the message contains (in its words, an attachment's caption or its
  filename), matched literally as one contiguous string, case-insensitive: no word splitting,
  no fuzziness, no wildcards. Keep it short and distinctive: one word or a fragment you are
  sure of beats a whole sentence
- limit: how many of the most recent matches to return (optional; default {{search_limit}})
- around: lines of the conversation to show either side of each match (0–{{around_max}};
  optional, default 0). With it, each match wears `match` after its stamp, and a `…` line
  stands where lines between two stretches are not shown
