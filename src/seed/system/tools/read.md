---
kind: tool
---

Read a doc by its handle, frontmatter included, from line `offset` (1-indexed), `limit` lines
at most; head-truncated to {{max_lines}} lines / {{max_kb}}KB (override with limit/max_bytes),
the footer naming the line to continue from.

- handle: the doc's handle as the index prints it: scope/name — system, shared or agent
  (your own), then the doc's name
- offset: first line to show
- limit: lines to show
- max_bytes: byte cap
