---
kind: tool
---

Read a doc by its handle, frontmatter included, from line `offset` (1-indexed), `limit` lines
at most; head-truncated to {{max_lines}} lines / {{max_kb}}KB (override with limit/max_bytes),
the footer naming the line to continue from.

- handle: the doc's handle as the index prints it: scope/name — system, organization, agent
  (your own) or conversation (this one's), then the doc's name
- offset: first line to show (optional; default 1)
- limit: lines to show (optional)
- max_bytes: byte cap (optional; default {{max_bytes}})
