The conversation above is being archived. Write a checkpoint that a later step of the same
agent reads in its place. The log stays searchable, and the instructions, memories and
templates in your system prompt stay in the agent's: the checkpoint carries only what the
agent would otherwise have to rediscover to make its next move.

The archive ends at the line <archived-through> quotes; what follows that line stays in view
and is not the checkpoint's to carry. When the conversation comes as a <conversation> block
instead, the block is the whole of what is archived.

If the conversation opens on a <checkpoint> block, or a <previous-summary> block is present,
rewrite it with the archived span folded in: keep what is still open, update what moved,
and drop the rest.

Use these headings; omit a heading with nothing under it.

## Open
- [who, by the name and address the conversation shows: what is pending and whose move it
  is, in one line, with the ids, dates and amounts that move needs, verbatim]

## Said here
- [a preference or a boundary a principal stated that your system prompt does not already
  say]

Leave out:
- whatever is closed: confirmed, answered, delivered or declined
- whatever your system prompt already says: addresses, prices, payment details, phone
  numbers, policies, procedures
- a thread that only waits on the other side and did not move in this span
- a second mention of anyone: each person or conversation is one entry

Write only what the conversation shows; never fill a gap with a guess. Keep every name,
address, path and figure exactly as it appears. Short is right: a checkpoint is a list of
open ends, not a record of the span.
