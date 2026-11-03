# Next batch: storage and docs

Decided 2 and 3 Nov 2026. Conversation files become an object store the log guards, and the
docs drop their scaffolding and show their budget.

## 1. Storage

`data/conversations/` becomes `data/storage/`: the one folder that moves to R2, S3 or another
object store, as `config.jsonc` names. It holds blobs, never docs.

- **No docs in storage.** Discovery never walks it. A doc declares itself by its header, and
  a received file can open with one (`conversations/5491133585694/media/81f9b45f1f6d1f8e.md`
  does), so a contact could otherwise send in a doc.
- **Three schemes, and no host path in the log:**
  - `storage://media/<hash>.<ext>`: kept by the harness, resolved to the configured backend;
  - `file://`: the agent's workspace, such as a file about to go out;
  - `https://`: an outside link.

  Render prints the URI and `aread` takes it, the rule docs already follow. `aread <uri>`
  prints the text; `aread <uri> --to <path>` lands the bytes in the workspace, for a program
  that needs a file.
- **Content-addressed.** The hash is SHA-256 cut to 32 hex (128 bits), one namespace for the
  org: a file forwarded to three chats is kept once.
- **The extension is the bytes'.** When the wire says `application/octet-stream`,
  `saveMedia` sniffs the bytes (`sniffMime`). The WhatsApp bridge's `CreateFormFile` labels
  every upload octet-stream, which is why the org holds 4,276 `.bin` files that are ogg,
  webp and mpeg. The bridge sets the part's `Content-Type` too (`open-bsp-whatsmeow`,
  outside this repo).
- **The log guards it.** An agent reads an object when an event it can read references it.
  Publishing writes each URI an event carries into `refs(uri, event_id)`, and the check is an
  `EXISTS` over `refs` joined to the agent's view: the policy on `storage.objects` on
  Postgres, the door's own check on SQLite and files.
- **A reference grants nothing.** Every `storage://` URI an event carries must already be
  readable by its writer (`WITH CHECK`, and the publish path on SQLite). Bytes the agent
  uploads are its own.
- **References keep an object.** It goes when no event references it; an upload whose
  message never landed has none.
- **No mounts.** Bubbles and containers mount no storage: `aread` resolves `storage://`
  through the agent's door. A program that needs the bytes (ffmpeg, a transcriber) gets them
  through `--to`, the same door.
- **The transcript caches go.** A transcript is an event already. The `<hash>.txt` beside an
  audio only spared a forwarded audio a second pass, and `refs` answers that: an event that
  references the same URI and has its transcript.
- **The bridge keeps its order.** It uploads before the message, and the path names no
  conversation.
- **The org's files move.** `conversations/*/media/` goes into `storage/media/` under the new
  hashes, each `.bin` sniffed, and each `file://` URI in the log is rewritten to its
  `storage://media/` one. The log then holds one scheme for harness-kept bytes, and no old
  path needs resolving.

## 2. Docs

- **`load: conditional`.** A doc whose header names `service` and `address` loads when that
  conversation is in view: from the agent's folder, personal, or from `shared/`, everyone's.
  The `conversation` scope goes, and three remain: `system`, `shared`, `agent`.
- **One `instructions.md` per scope**, scoped by its folder:
  - `system/instructions/system.md` → `system/instructions.md`;
  - `shared/instructions/organization.md` → `shared/instructions.md`;
  - `agents/<agent>/instructions/agent.md` → `agents/<agent>/instructions.md`.

  `system/instructions/compaction.md` → `system/compaction.md`, and `system/` holds two files
  and two folders: `instructions.md`, `compaction.md`, `tools/`, `skills/`.
- **A `memories.md` in `shared/` and in each agent's folder**, seeded with `kind: memory`,
  `load: always` and an empty body.
- **No kind folders.** Seeding lays a scope's home and its two files, never `instructions/`,
  `skills/` or `memories/`. Folders are a convention, which `system.md` recommends once a scope
  holds about ten docs.
- **The two orgs on this machine are reworked by hand**, with the code, no migration:
  - `new`: `organization.md` and each `agent.md` move to their `instructions.md`;
    `aliases.md` folds into `agents/matias/memories.md`; empty kind folders go, and those that
    hold docs (`shared/instructions/web-search.md`, `agents/matias/memories/grabaciones.md`)
    stay, by convention.
  - `vibes`: `shared/instructions/main.md` becomes `shared/instructions.md`; `chiche`'s empty
    `instructions/`, `memories/` and `skills/` go.
  - Links: both orgs swap the `data/system/instructions` folder link for two file links,
    `instructions.md` and `compaction.md`, at the checkout's `src/seed/system/`. `vibes` links
    `skills/` too, as `new` does, in place of its empty folder.

## 3. A memory shows its budget

- `MEMORY_CHARS = 2_200`, counted on the body, header excluded. Characters, as Hermes counts:
  a model can judge them, and the figure holds across models. It informs and never enforces.
- Every memory doc's reference shows how full it is: an inlined one on its heading, an
  on-demand one in its index line.
- A notice for an edited memory carries the new figure in its head. The heading's figure
  stays out of the `by you` test, since no call writes it.
- `system.md` says what it means: past 100%, merge or prune before adding.

The figures from the org on 3 Nov, `aliases.md` folded into the agent's `memories.md`:

```
[/home/matias/new/data/shared/memories.md] 0% of 2,200 chars

[/home/matias/new/data/agents/matias/memories.md] 20% of 2,200 chars
- "Mamá" = Vivian Sobisch (25 Sep 2026)
- (27 Oct) Mars (5491165565431): escribirle siempre en inglés.
…

[/home/matias/new/data/agents/matias/memories/grabaciones.md] 94% of 2,200 chars
- 5 Nov jue 17:30 Ringo Gustavo Obregón (5492615737049): set ~50 min de bandas 60/70s. …
…
```

A lazy memory in the index (an illustration: the org has none), and a notice after an edit:

```
- [/home/matias/new/data/agents/matias/memories/viajes.md] 31% of 2,200 chars · viajes y reservas

/home/matias/new/data/agents/matias/memories/grabaciones.md — edited by you · 97% of 2,200 chars
```

## Not in this batch

Cards, set aside. The `## Knowledge` rewrite in `system.md`. The nightly pass. A `path`
condition beside `service` and `address`, loading a doc while the agent's working directory
lies under it.

## Order

2 and 3 first, small and in the docs' own code; then 1.

# Event log and render (landed 1 and 2 Nov 2026)

Conclusions of the "mem" design discussion, 30 and 31 Oct 2026. This batch is the event log
and render: five changes. The next is memory: cards, compaction, memory instructions and memory
unloading need more discussion and are listed under [Out of this batch](#out-of-this-batch).

## 1. Permission events

The model sees the verdict as an event in its own room, the same on every surface.

- `<permission_response>` renders in the agent's conversation with its principal (the
  session room), and stays like any line until the checkpoint. The ask needs no line of its
  own: the `tool_use` shows the draft whole, and its `pending_approval` result says it
  waits. The response points back at the call with `re`, the handle the pending list shows:

  ```xml
  <permission_response re="5b0d1b" principal="Matías Battocchia" verdict="deny" at="29 Oct 17:41">a ver... recepción ya sabe donde vivo…</permission_response>
  ```

- Verdicts: `allow` (with `scope="once|conversation"`), `deny`, `lapsed`, `withdrawn`. A
  withdrawal is marked `self`, since the agent withdrew it.
- Turn shape: `tool_use`, then the `pending_approval` result; later the response; on
  `allow`, the errand's gated result reports what the call did.
- The anchor's pending list stays: it answers what is still open. The events are the record.
- **The errand's deny result goes away** (`xi.ts:1697`): the tool never ran, and the verdict
  is the event. The inline denies stay (`xi.ts:1680`, and `xi.ts:1633` for policy): there the
  `tool_use` has no answer yet, and "refused" is its result.
  - `owedOf` (`xi.ts:565`) and the store's `owed` skip deny verdicts, lapses included. Only
    `allow` makes an errand.
  - The principal's deny is news (`newsOf`) and wakes a turn, so the agent can redraft.
  - An allow wakes through its outcome: the errand's gated result leaves the chain without
    a closing (`unclosedChain`), unless its tool marks it quiet, as `send` does (change 5).
  - A standing deny (`/n conv|conn|always`) is remembered when that turn opens
    (`standingDenies`), since no errand runs to remember it.
- A lapse is a deny with `lapsed: true`, settled by the harness, so it wears no author key.
  Like any deny it leaves no errand: a call that never ran owes no outcome. The mirror does
  not relay it. **It wakes nothing:** it is news, never a reason to wake. A running turn
  reads it at its next step, or else the next turn, whatever opens it. A permission rule,
  ours and bounded, apart from a tool's quiet late results (change 5).

  ```xml
  <permission_response re="5b0d1b" verdict="lapsed" at="30 Oct 17:40">unanswered for 24h</permission_response>
  ```
- **The window already holds no copies.** The mirror's outward copies (the card, the agent's
  lines in the principal's self-chat) live in the alias conversation, which policy hides from
  every agent (`policy.ts` `NOT_AN_ALIAS`), and a `/y` or `/n` enters the mind as its
  settlement, never as a line (`verdict.ts`). The copies seen during the discussion came from
  rendering the log unscoped.
- Events are immutable: render ignores their mutable `status`.

## 2. `<before>`

Each room in view gets the recent past the model has not seen drawn.

- `<before>` sits inside the WUM, at the top of a room's first drawn `<conv>` since the
  last checkpoint, when the room has earlier lines. A room drawn in an earlier WUM since
  then has its past in view already; one an earlier cap left out whole was never drawn,
  and gets its `<before>` when it next is. Its lines come from below the floor and from
  what that cap hid; no checkpoint is needed for the second.
- **X** is the last two full turns, as the contact saw them:
  - the sides are the account (principal, self, org merge) and them;
  - lines the contact never saw are excluded: mirror copies, permission events, internal lines;
  - cap of 12 messages: whole turns, newest first, while they fit; if the newest turn alone
    passes 12, its newest 12. Both are named constants.
- **One budget, new lines first.** A WUM weighs at most `compactAt`, `<before>` included:
  - pass 1 is `capRun` as it stands, over the run's new lines: shares, cuts and elision
    marks unchanged, so a tight budget renders the same bytes;
  - pass 2 gives what pass 1 left unused to `<before>`: the rooms it did not cut, lightest
    first, each taking whole turns, newest first, while they fit.

  A cut room gets no `<before>`, since a room is cut only when the budget ran out. In a flood
  the past gives way first. The session's own room gets none: its past is the checkpoint's
  and the `keepRecent` turns'. The window's read is untouched: `<before>` reads below the
  floor on its own bound (`BEFORE_READ` rows per room).
- **References are always pulled,** outside the budget: any `re` target not drawn in a WUM
  since the checkpoint — one the cap hid, one below the floor, one anywhere the log holds it
  — deduped across the period. A target drawn already is pointed at. It lands in the
  `<before>` of the `<conv>` the referring line stands in, so no earlier block ever changes.
  `re="?"` means only an event that cannot be found.
- Gap mark: `… N not shown`.
- `<before>` is recomputed every step, so it must be a pure function of (floor, log):
  - rows are chosen by id below the floor, in append order;
  - status filters read only write-once stamps against the floor's moment: a row is left out
    when `withdrawn_at` precedes it, or when `reported_at` precedes it and `corrected_at`
    does not.
- `search` takes a line id for `before` and `after`. Both stay strict, as paging needs.
- The checkpoint names where the archive ends with the first line it does not cover:
  `<checkpoint before="<short id>">`. The model copies `search before=<id>` as it reads and
  gets exactly what the checkpoint summarizes. `system.md` says so where it introduces the
  checkpoint: its summary of what scrolled out of the window, the lines before the one it
  names.

## 3. `compactAt` and `keepRecent` per agent

A social agent and a coding agent need different windows.

- Move both from the SYSTEM catalog (`config.ts:~271-282`) to the AGENT catalog
  (`config.ts:366`), falling back to the org value like `engagedMinutes`.
- Drop the pin at `main.ts:801`; the profile already carries both (`store/agents.ts:44`).
- Check `keepRecent < compactAt` per agent (`config.ts:1063`).
- The catalog and every org's `config.jsonc` change together.
- `compactAt` also caps a WUM's weight, so a larger window means larger WUMs too. With change 4,
  tool results and thinking count toward it, so checkpoints come sooner at the same value.

## 4. Sticky tools and thinking

Tool pairs and thinking stay until the floor, as in pi and Claude Code. The context is already
cached, and reasoning carries across turns.

- Until the floor, the closed region keeps what the trailing region welds: thinking, tool
  pairs, late results, anchors and inlined media. Nothing is collapsed at close: every
  request is the previous one plus new rows.
- Preserved thinking binds every block to everything before it, so **nothing in the closed
  region may re-render.** The prerequisites:
  - permission events ignore `status` (change 1);
  - `<before>` is stable (change 2);
  - `roomNames` takes the latest name at or before the row, not the latest in the window;
    rename events carry the change;
  - `msgLine` draws no `failed` and no `withdrawn`: both change late (a failure can land
    hours later, after the ladder). The sending session hears of both through late updates
    (change 5); other sessions of the agent see the line plain. `search` keeps both marks:
    its hits share `msgLine`, but a tool result is written once, a snapshot of the moment it
    was asked, so a mark there never re-renders. A search reads every message row, unsent
    ones included, and without the mark a withdrawn line would read as said.
- **The anchor is an event.** nu writes it, in the session room, with a step's first event
  and stamped just before it, so a failed call leaves none and a retry reads afresh. It
  replaces `extra.anchor` (`nu.ts:368`) and render's replay map.
  - It is written when its text differs from the session's last anchor, with `now` at
    minute precision. Every line counts, a job's last line included. Closing steps too:
    kept thinking binds them as well. A turn's first step nearly always writes one, since
    time has passed.
  - Anchors are written only at steps, so a job printing a hundred lines a second still
    adds at most one per step. A quiet job shows once a minute, when its age moves.
  - The event holds the whole snapshot. Render shows the sections that changed since the
    previous anchor in the window; the first anchor in the window shows whole. A section
    that empties says so (`background — nothing running`), or the last listing would stand.
  - It is a `mid_conv_system` block where it was written, the last block of that step's
    request. Not a message: search and the WUM caps do not see it.
  - A job's age rounds to the minute, `running 0m` in its first (`took`, `exec/jobs.ts:192`,
    shows seconds there). A job's end needs nothing new: it already arrives as a late update
    against its call, and wakes the session.

  ```
  ── user
  [tool_result] started in the background · pid 48211
  [system] background — 1 job:
  · vite — running 0m, last line "ready in 412 ms" · pid 48211
  ── assistant
  [tool_use read] {"path":"src/Login.tsx"}
  ── user
  [tool_result] …the file…
  [system] background — 1 job:
  · vite — running 0m, last line "hmr update /src/Login.tsx" · pid 48211
  ── assistant
  [tool_use edit] {"path":"src/Login.tsx", …}
  ── user
  [tool_result] edited
  [system] now: Thursday 29 October, 2026 - 15:41
  background — 1 job:
  · vite — running 1m, last line "GET /login 200" · pid 48211
  ```

- **Inlined media stays** until the checkpoint, like thinking. Turning it into a marker at
  close would rewrite a block mid-history: the cache misses from there and every later
  thinking block drops.
  - `MEDIA_BUDGET` (`render.ts:242`) becomes a window budget, newest first. When the
    window's media would pass it, the oldest falls back to its marker: one rewrite,
    accepted as rare. Holding back the newest picture would be worse.
  - The window's size estimate counts media, so a window heavy with it reaches `compactAt`
    sooner. The weights are the API's: an image costs a token per 28×28 patch, capped at
    4,784 on the high-resolution tier the current models read at; a PDF page costs its text
    (1,500 to 3,000) and an image of the page. A part carries neither dimensions nor page
    count, so an image weighs the cap and a PDF's pages are guessed from its size.
- **Every cache mark is 1h.** The tail's five minutes (`render.ts:966`) suited an entry that
  died at close; now the tail is what the next turn reads back, often more than five minutes
  later. The marks: tools and the system prefix, the previous request's tail, the new tail.
  A 1h write costs 2x input against 1.25x, paid only on each step's new rows.
- **At a checkpoint,** the turns `keepRecent` retains keep their tool pairs and lose their
  thinking. A block's signature binds everything before it, and the summary replaced that
  prefix, so the API would drop each block on every request (or refuse it, on enforced
  accounts). Tool pairs carry no signature: they stay valid after any prefix.
- Accepted as rare, each costing one turn of dropped thinking: an echo absorbed after it
  rendered, an upsert re-statement, Teams `relabel`, the mail thread move, media past the
  window budget.
- **The world waits for the closing.** A turn is its opener (the WUM, the principal's
  lines, the session's news, the anchor), then its steps, then its closing: an assistant
  message, always. A WUM renders once per turn, at its opening. Between steps the turn
  reads everything but world lines: the principal's lines and verdicts, shell and send
  updates, lapses, alarms. A world line is any message in a world room, the agent's own
  send rows included (`message`, `ref_id` → the send's `tool_use`). One that lands while a
  turn is open, past its first step's horizon (`extra.consumed`) and before its closing,
  renders after that closing, in the next turn's WUM. Today `weldOrder` floats such a line past the step it interrupted, and the turn's
  next step reads it. `deferredInput` already moves what lands while the closing's call is
  in flight; this widens it to the whole turn, and does it before `byEventTime`, so the line
  never joins the run the turn read: a run forms only between turns, and each WUM is capped
  once. A gated send's row needs no rule of its own: the errand writes it between turns,
  its outcome is quiet and opens none, so it opens the next turn's WUM like any world line.
- **One WUM per turn, its narration first.** Late results, like rulings, are transparent to
  runs: they stand before the WUM and explain what it then shows (`→ sent`, then the line
  as it went out), instead of cutting it in two.
- **A silent closing renders verbatim:** the assistant's `<|SILENCE|>`, with its thinking.
  Today render draws nothing for it (`render.ts:536`, the `silent` skip in the weld), and
  keeps thinking only for steps that called a tool, so the opener before it and the one after
  run together in one user message. It was a response like any other, and every request
  replays the last one. The mirror still carries nothing to any surface.
- Keep `prefix_mismatch_behavior: "drop_block"` (`transport/anthropic.ts:24`). Each drop the
  response reports is stamped on `liquen start`'s stderr as `[anthropic] turn …`; that is
  where the change is measured.

## 5. Send late updates and `cancel`

Every send ends with a `final` word: out in its result, or delivered after all, undelivered,
or withdrawn.

- **A send's late results wake nothing,** like world news: its gated outcome, and its
  updates (stalled, undelivered, withdrawn, delivered after all). Quiet is the tool's own
  word on what it tells late (`ExecOutcome.quiet`, carried onto the late result as
  `Payload.quiet`): any other tool's late result is a result like any other, and opens a
  turn, a shell's updates among them. Each quiet one is news: a running turn reads it at its
  next step, or else the next turn, whatever opens it.
- **A withdrawal writes a late update** against the send, to the session that sent it,
  `final`: "taken back before it went out, by <who>". Without it, the stalled update's promise
  ("you are told when it goes out or is given up") is broken.
  - The withdrawal stamps `withdrawn_by` (agent and session) beside `withdrawn_at`.
  - The claim widens the undelivered one (`sweep.ts` `claim`) to withdrawn rows that are not
    out, whatever a post in flight stamped after, with the same `reported_at` stamp; the
    update's text follows `withdrawn_at`.
  - The race needs nothing new: `correct` already fires when a withdrawn send went out, and
    says "it was already on its way when you took it back" (`late.ts:145`).
  - The same session gets it too: the `cancel` result is the canceller's news, the update
    closes the send.
- **Who may withdraw is set by membership:** an agent that can write to the room may cancel
  any unsent message there, whoever sent it. `mine` (`xi.ts:2815`) changes from "this agent's"
  to "a room this session can write to". Can write means what a `send` to that room would
  meet, through the same gate: `allow` or `ask` may withdraw, `deny` may not. A withdrawal
  puts nothing on the wire, so `ask` waits on no one. Gates and timers stay session-bound:
  they belong to a session's own calls.
- `cancel.md` says: a message not yet out, in a room you can write to. `referent`'s hint
  ("to take it back: cancel <re>") is right for any session that can write, and stays.
- **A send's row in the WUM:** never in the turn that reads its result, since the
  `tool_use` already shows the text (the welded-send skip at `render.ts:938` stays). It
  renders in the WUM after that turn's closing. An ungated send's result is read in the turn
  of its `tool_use`. A gated send's outcome comes from the errand and opens a turn of its
  own, so its row waits for that turn's closing: the row the errand writes is a mid-turn
  arrival like any other. Seeing it twice, as the kept pair and as the line, is accepted.
  - `capRun` and the elision counts count the row only where it is drawn, so every render of
    a WUM keeps its bytes.

## 6. The prefix holds between checkpoints

Decided 1 and 2 Nov 2026, after a day of the growing window on Matías' org: an edit to a
`load: always` memory rewrote the system prefix, and the API dropped every thinking block
the window held.

- `prefix` is an event, the anchor's shape: nu writes it with a step's first row, whole,
  when the live prefix differs from the window's last since the checkpoint, or none is
  there. Its data is the sections: each always-doc's body under its handle, then
  `On-demand docs`, `Programs`, `Environment` (`systemSections`, `systemBlocks`).
- The first since the checkpoint is the request's `system` (`systemOf`), the checkpoint
  call's too. Each later one renders where its step read it, in the anchor's block, as
  what changed:

  ```
  /home/matias/new/data/agents/matias/memories/grabaciones.md — edited
    - (Mars no es grabación: es el profe de inglés de Matías, clase martes 18:00 desde la semana que viene.)
  + - 5 Nov jue 17:30 Ringo Gustavo Obregón (5492615737049): set ~50 min de bandas 60/70s. …
    - 3 Nov mar 15:00 Franco Giudice (DGB): reprogramado (29/10 no pudo, Galileo con alergia). …
  ```

  `— added` shows the section whole, `— removed` its key alone. A change whose every
  line, blanks aside, stands as a line in the input of one of the agent's own calls that
  ran since the prefix before is its head alone, `— edited by you` or `— added by you`:
  an `aedit` heredoc, an `edit` spec, a `write`'s content. Whatever else changed, or a
  call that failed, draws the diff. A notice and an anchor
  share the tail block, notice first; the emit guard turns the whole trailing run to text
  when more content follows.
- One written before the checkpoint renders nothing. A `prefix` weighs nothing toward
  `compactAt`.
- Tool definitions stay live. A version upgrade is no special case: its templates reach
  an org through the live copies, so they arrive as notices too.

## 7. A picture weighs its pixels

- `FilePart.file` carries `width` and `height`, read off the header (`imageSize`: PNG, GIF,
  WebP, JPEG) where the bytes land: `saveMedia`, `filePartOf`, and the WhatsApp webhook,
  which reads the files the bridge landed through `/media` before their batch.
- `mediaTokens` weighs an image its patches, `ceil(w/28) × ceil(h/28)`, capped at 4,784; a
  sticker without a size 512×512; any other image the cap.

## 8. The turn's opener

- The step's first row, whichever it is (a `prefix`, an anchor, a word, a call), carries
  `extra.consumed`, so `turnsOf` names what opened the turn. The step's first word or call
  keeps its own, where xi reads the closing's horizon.

## Templates and docs

- `src/seed/system/`: `cancel.md` (scope), `search.md` (`before`/`after` take a line id),
  `system.md` where it describes the window (permission responses, no requests, `<before>`,
  kept tool results, and the anchor: a section stands until a later anchor restates it).
  The running org's live copies follow; check with `diff -q`.
- `DESIGN.md` (regions and collapse, 1500-1545) and a `PROJECT.md` entry when it lands.

## Out of this batch

- **Cards:** per-contact docs, derived signals, nu's prediction, the send fallback,
  `extra.cards` on the step, the docs index family line and the fourth scope in `system.md`,
  per-class defaults in `conversations.md`.
- **Compaction:** the principal's corrections kept verbatim, cards rendered for the previous
  checkpoint's addresses, `CHECKPOINT_STALE_DAYS`, keeping each denial with its draft and reason.
- **Memory instructions:** the `system.md` memory rewrite.
- **Memory unloading:** the nightly pass, address-set diffs between checkpoints, the three
  destinations, approval counters.
- **Not decided:** model routing (Jev) or outcome classification.
- **Deferred, wire facts that land late:** Teams lookup retry (keep `stampKind`), the mail
  thread move as it is, an `external_id` for conversations.

## Order

Change 4 rests on parts of 1, 2 and 5, so the batch lands as 3, 5, 1, 2, then 4.
