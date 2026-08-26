---
kind: instruction
load: lazy
description: How conversation history is checkpointed when the window grows — the prompt the harness sends to summarize the archived region.
---
The conversation above is being archived. Write a structured checkpoint summary that a
later step of the same agent will rely on to continue seamlessly.

If a <previous-summary> block is present, fold it in: PRESERVE everything still relevant
from it, ADD the new threads/facts/commitments, UPDATE state that moved on, and drop only
what is clearly obsolete.

## Ongoing threads
[Per conversation: who it is, what is being discussed, current state]

## Constraints & preferences
- [How the principal wants things done — or "(none)"]

## Commitments
- [Things promised or pending, with owner and any deadline — or "(none)"]

## Key facts & decisions
- **[Fact/decision]**: [brief context]

## Critical context
- [Exact names, ids, paths, and figures needed to continue — or "(none)"]

Keep each section concise. Preserve exact names, paths and figures.
