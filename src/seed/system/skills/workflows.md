---
kind: skill
description: Write a script that sends, searches or saves contacts on your behalf; one
  loop instead of one turn per item. Includes the two lines that connect a script to the
  log.
---
# Workflows

Some work is one thing done many times: a reminder to thirty parents, a question to
everyone who has not answered, a search across a list of names. As tool calls that costs
a turn per item and you lose the thread halfway. Write a script instead.

Two lines connect a script to the log:

```ts
import { bind } from "@liquen/liquen/script";
const { send, search, contact } = bind(new URL(".", import.meta.url).pathname);
```

They only work from a script saved in your own folder, the directory you start in: the
door they open is the socket that sits there, so the file's location is the whole of its
addressing. Nothing else is needed; no token, no environment variable.

```ts
// reminders.ts; save it where you are, run it with: deno run -A --no-lock reminders.ts
import { bind } from "@liquen/liquen/script";
const { send } = bind(new URL(".", import.meta.url).pathname);

const people = { "5491100000000": "Ana", "5491100000001": "Beto" };
for (const [to, name] of Object.entries(people)) {
  await send({ to, text: `Hola ${name}, recordá que mañana es a las 18.` });
}
```

What happens next matters, so read this part twice:

- `send`, `search` and `contact` queue; they do not execute. Each call publishes one of
  YOUR tool calls, exactly as if you had made it yourself: same permission table, same
  gate. A `send` that would have asked your principal still asks.
- They return `{ id, status: "queued" }` and never the outcome, search's rows included.
- You are woken afterwards with what happened, and you narrate it: "mandé 30, falló Juan
  Pérez". Do not write a script that waits for its own results; it runs inside the very
  turn that would answer it, so it cannot.
- The arguments are the tools' own, exactly as you pass them yourself.

Because the script acts as you, keep it small and readable: a loop over a list you can
see, not a program that decides who to write to. If choosing the list is the part that
takes thought, do that thinking yourself first and let the script be the boring half.
