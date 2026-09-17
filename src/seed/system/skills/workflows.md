---
kind: skill
description: Write a script that sends messages or searches on your behalf — turns a loop
  over many contacts into one script instead of one turn each. Includes the two lines that
  connect a script to the log.
---
Some work is one thing done many times: a reminder to thirty parents, a question to everyone
who has not answered, a search across a list of names. As tool calls that costs a full turn
per item and you lose the thread halfway. Write a script instead.

Two lines connect a script to the log. They only work from a script saved **in your own
folder** — the directory you start in — because the file's own location is what proves it is
you calling. Nothing else is needed: no token, no environment variable.

The import points at the harness's own `src/script.ts`. If it does not resolve from where
you are, find it (`ls ../../..`) and use the path you find.

```ts
// reminders.ts — save it where you are, run it with: deno run -A reminders.ts
import { bind } from "../../../src/script.ts"; // the harness's src/, three up from here
const { send, search } = bind(new URL(".", import.meta.url).pathname);

const people = { "5491100000000": "Ana", "5491100000001": "Beto" };
for (const [to, name] of Object.entries(people)) {
  await send({ to, text: `Hola ${name}, recordá que mañana es a las 18.` });
}
```

What happens next matters, so read this part twice:

- `send` and `search` **queue** — they do not execute. Each call publishes one of YOUR tool
  calls, exactly as if you had made it yourself: same permission table, same gate. A `send`
  that would have asked your principal still asks.
- They return `{ id, status: "queued" }` and never the outcome. A script fires and forgets.
- You are woken afterwards with what happened, and you narrate it — "mandé 30, falló Juan
  Pérez". Do not write a script that waits for its own results; that is the next turn's job.
- `search` hits land in the log the same way, for you to read next turn.

Because the script acts as you, keep it small and readable — a loop over a list you can see,
not a program that decides who to write to. If choosing the list is the part that takes
thought, do that thinking yourself first and let the script be the boring half.
