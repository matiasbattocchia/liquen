---
kind: tool
---

Edit a doc in place by its handle with conflict-marker blocks (each marker on a line of its
own: <<<<<<<, the old text, =======, the new text, >>>>>>>): every old text must match the doc
once, exactly or ignoring trailing whitespace, and blocks must not overlap.

- handle: the doc's handle as the index prints it: scope/name — system, organization, agent
  (your own) or conversation (this one's), then the doc's name
- spec: one or more conflict-marker blocks
