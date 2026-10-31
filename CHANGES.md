# Next batch

Conclusions of the "mem" design discussion, 30 and 31 Oct 2026. This batch is the event log
and render: five changes. The next is memory: cards, compaction, memory instructions and memory
unloading need more discussion and are listed under [Out of this batch](#out-of-this-batch).

## 1. Permission events

The model sees the ask and the verdict as events in its own room, the same on every surface.

- `<permission_request>` and `<permission_response>` render in the agent's conversation with
  its principal (the session room), and stay like any line until the checkpoint:

  ```xml
  <permission_request id="5b0d1b" tool="send" at="29 Oct 17:40">send(to: Recepción Torres, text: "Hola, a las 18 llega Tete…")</permission_request>
  <permission_response re="5b0d1b" principal="Matías Battocchia" verdict="deny" at="29 Oct 17:41">a ver... recepción ya sabe donde vivo…</permission_response>
  ```

- Verdicts: `allow` (with `scope="once|conversation"`), `deny`, `lapsed`, `withdrawn`. A
  withdrawal is marked `self`, since the agent withdrew it.
- The request shows a `send` in full, because the draft is half of every correction. Other
  tools keep the clipped call the card already uses.
- Turn shape: `tool_use`, then the `pending_approval` result with the request beside it; later
  the response; on `allow`, the errand's gated result reports what the call did.
- The anchor's pending list stays: it answers what is still open. The events are the record.
- **The errand's deny result goes away** (`xi.ts:1697`): the tool never ran, and the verdict
  is the event. The inline denies stay (`xi.ts:1680`, and `xi.ts:1633` for policy): there the
  `tool_use` has no answer yet, and "refused" is its result.
  - `owedOf` (`xi.ts:565`) and the store's `owed` skip deny verdicts, lapses included. Only
    `allow` makes an errand.
  - A deny response is news (`newsOf`) and wakes a turn, so the agent can redraft.
  - A standing deny (`/n conv|conn|always`) is remembered when that turn opens
    (`standingDenies`), since no errand runs to remember it.
- A lapse is a deny with `lapsed: true`, settled by the harness, so it wears no author key.
  Like any deny it leaves no errand: a call that never ran owes no outcome. The mirror does
  not relay it.

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

After a checkpoint, each room in view gets its recent past back.

- `<before>` sits inside the WUM, at the top of the room's first `<conv>` after the floor.
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
  and the `keepRecent` turns'. The read cap (`compactAt` × `FLOOD_FACTOR`) is untouched:
  `<before>` reads below the floor on its own bound.
- **References are always pulled,** outside the budget: any `re` target not rendered, however
  far back, deduped across the period. This also settles the `re="?"` of a reply to a line below the floor.
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
  pairs, late results and step anchors. Nothing is collapsed at close: the region is
  append-only.
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
- **At close,** a turn whose rendering changes drops its thinking: inlined media becoming
  markers (`shed` of `extra.media`, world images). This is allowed, since no later block exists
  yet.
- **At a checkpoint,** the turns `keepRecent` retains keep their tool pairs and lose their
  thinking. A block's signature binds everything before it, and the summary replaced that
  prefix, so the API would drop each block on every request (or refuse it, on enforced
  accounts). Tool pairs carry no signature: they stay valid after any prefix.
- Accepted as rare, each costing one turn of dropped thinking: an echo absorbed after it
  rendered, an upsert re-statement, Teams `relabel`, the mail thread move.
- Keep `prefix_mismatch_behavior: "drop_block"` (`transport/anthropic.ts:24`). Each drop the
  response reports is stamped on `liquen start`'s stderr as `[anthropic] turn …`; that is
  where the change is measured.

## 5. Send late updates and `cancel`

Every send ends with a `final` word: out in its result, or delivered after all, undelivered,
or withdrawn.

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
- **A send's row in the WUM:** never in the turn of its `tool_use` (the welded-send skip at
  `render.ts:938` stays); from the next turn on it shows. With the region append-only, the row
  cannot slip back into its closed turn, so it renders in the first WUM after that turn closes.
  Seeing it twice, as the kept pair and as the line, is accepted.
  - `capRun` and the elision counts count the row only where it is drawn, so every render of
    a WUM keeps its bytes.

## Templates and docs

- `src/seed/system/`: `cancel.md` (scope), `search.md` (`before`/`after` take a line id),
  `system.md` where it describes the window (permission events, `<before>`, kept tool
  results). The running org's live copies follow; check with `diff -q`.
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
