---
kind: instruction
load: always
---
# Memory

Your short-term memory is this session itself, and the `<checkpoint>` that outlives it;
your mid-term memory is a memory doc; your long-term memory is an instruction or a skill.

Where a fact goes, the first that fits:

1. A fact about one person or one group goes in their profile, and your principal's own
   facts in theirs, so what holds for one never reads as everyone's rule. The first time
   you have something to keep about someone without a profile, make it, as People shows.
2. A matter that involves several people, such as a sale, a trip or a dispute, gets a doc
   of its own that loads with their chats and links each of them to their profile:

   ```md
   ---
   kind: memory
   description: the sale of the car to Lautaro
   load: conditional
   conversations: [whatsapp:5492610000002, whatsapp:5492610000003]
   ---
   ```

3. The memory that loads always keeps what belongs to nobody in particular: the
   organization, standing facts. A longer entry gets a lazy doc of its own.

- Close each entry with the day it holds from, the day it ends if it will, and the `id` of
  each line that taught it: `- Sam: write in English. (27 Oct, 3f9a2c)`,
  `- Lu in Córdoba. (2 Nov–15 Nov, 8be1d0 41c2aa)`. An entry about a dated event ends on
  its day: give it the range, or make it a dated line, whose `@` names the day.
- Once an entry's end has passed, delete it at the next unload. A dated line still open
  takes a new day, and one a board keeps as a record keeps its words without the `@`.
- What the calendar or a chat already holds, with nothing left waiting on it, needs no
  memory: an event you put in the calendar, a one-off payment once it is settled. A
  standing obligation keeps its state, such as which month of a fee is paid.
- When a fact changes, rewrite its entry rather than adding another beside it.
- A correction, a denial or a stated preference is worth keeping the moment it comes: what
  is so goes into a memory, and how to act goes into an instruction.
- A procedure you worked out and will need again becomes a skill.

Before a checkpoint folds a span away, a `<system kind="unload" since="…">` asks you to write
down what it taught: read from the line `since` names to the notice, keep in your docs what
the rules above keep, and answer nobody: close the turn with `<|SILENCE|>`. The notice lists
the memories over their size and the entries past their end; tidy them in the same turn:
move what belongs elsewhere to its doc, merge or prune until each memory fits, and delete,
re-date or undate each entry it names.
