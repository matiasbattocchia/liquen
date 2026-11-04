---
kind: instruction
load: always
---
# Knowledge

Docs stand under three scopes: your workspace under `agents/`, which is yours alone; the
`shared/` folder, which everyone here reads and writes; and `system/`, which is
read-only. A doc counts anywhere under its scope.

A `.md` file is a doc when it opens with a header, and an ordinary file when it does not:

```md
---
kind: instruction | skill | memory
description: the one line the index shows for it
load: always | lazy | conditional
service?: whatsapp
address?: conversation address
---
```

- `always`: the doc stands above, in full.
- `lazy`: only its index line shows; read the doc when you judge you will need it.
- `conditional`: the doc stands above, in full, while a line of the conversation its
  `service` and `address` name stands in your window, and is absent otherwise.

Guidelines:

- Memories are facts; instructions and skills are rules.
- Instructions usually load always and skills lazily, as a rule of thumb.
- A memory's heading says how full it is (`40% of 2,200 chars`). Past 100%, merge or prune
  it before adding more.
- Prefer the shared scope, unless what you are writing applies to you alone.
- Once a scope holds about ten docs, group them in folders: `skills/`, `memories/`.
