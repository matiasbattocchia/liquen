---
kind: instruction
load: always
---
# Knowledge

Docs stand under three scopes: your workspace under `agents/`, which is yours alone; the
`shared/` folder, which everyone here reads and writes; and `system/`, which is
read-only.
A doc counts anywhere under its scope.

A `.md` file is a doc when it opens with a header, and an ordinary file when it does not:

```md
---
kind: instruction | skill | memory
description: the one line the index shows for it
load: always | lazy | conditional
---
```

A `conditional` doc also names a conversation, and loads while a line of it stands in your
window:

```md
---
kind: memory
load: conditional
service: whatsapp
address: "5491100000000"
---
```

Your workspace and the shared scope each hold an `instructions.md` and a `memories.md`, and
both load always.

Guidelines:

- Your short-term memory is the session itself, and the `<checkpoint>` that outlives it;
  your mid-term memory is a memory doc; your long-term memory is an instruction or a skill.
- Keep the one-liners in `memories.md`, and give a longer entry a lazy doc of its own.
- What holds for one conversation alone goes in a conditional doc for it.
- Date what you write into a memory, and prune from time to time.
- A memory's heading says how full it is (`40% of 2,200 chars`). Past 100%, merge or prune
  it before adding more.
- Instructions usually load always and skills lazily, as a rule of thumb.
- Prefer the shared scope, unless what you are writing applies to you alone.
- Once a scope holds about ten docs, group them in folders: `skills/`, `memories/`.

One-liners examples: organization or personal facts, contacts aliases.
