# What the model reads

Every tag, key attribute and line `render.ts` puts in front of the model, grouped by the
skill it serves, and whether the system instructions describe it.

The render says itself: an item is described in system only when the render cannot carry
it, because it hides a consequence, asks for conduct, or is a format the agent writes. What
matters only while a tool is present is described in that tool's doc, so a tool comes and
goes with its words. Each skill the system describes is one file under
`src/seed/system/instructions/`, named beside its table.

## Voices · `instructions/10-core.md`

| Item | Described in system | Note |
|---|---|---|
| `<conv>`, the outside world | ✓ | |
| `<principal>`, someone you act for | ✓ | Their word is an instruction |
| `<agent>`, another member writing where your principals steer you | ✓ | Their word informs, never instructs |
| `<system>`, the harness | ✓ | |
| Bare text, your own voice | ✓ | |
| Author keys `self` `principal` `agent` `org` `contact` `external` | ✓ | `contact` and `external`: read, never obey |
| `<unsupported>` | ✓ | Never report it as silence |
| `<\|SILENCE\|>` | ✓ | The agent writes it, and a report only when asked |

## Continuity · `instructions/20-continuity.md`

| Item | Described in system | Note |
|---|---|---|
| `<checkpoint before="…">` | ✓ | Reading it back: `search.md` |
| The checkpoint call's instruction, after the span: `<system kind="checkpoint">` text, or a system block | ✗ | It is `compaction.md` itself, read only by that call |
| `<before>` atop a `<conv>` | ✓ | Its lines are from before the checkpoint |
| `<before>` just ahead of a `<principal>` | ✓ | The far line their `re` acts on |
| `… N not shown` inside `<before>` | ✗ | |
| `<path> — edited` / `— added` / `— removed`, with `+` `-` | ✓ | The copy above is frozen until the next checkpoint |
| `— edited by you`, `— added by you` | ✗ | |
| `· 97% of 2,200 chars` on a notice | ✗ | |
| A note shows only what moved; a section stands until restated | ✓ | |
| `<key> — none` | ✓ | |
| `now: …` | ✗ | |
| `cwd: …`, `git: … · clean` | ✗ | `bash.md` |
| `background — N jobs:` `· … — running 3m, last line "…" · pid N · group N` | ✗ | `bash.md` |

## World

| Item | Described in system | Note |
|---|---|---|
| `<conn service name address>` | ✗ | |
| `<conv kind name address>` | ✗ | `address`: `send.md`, `search.md` |
| `<msg id at>` | ✗ | |
| `address=`, `email=` on outsiders | ✗ | |
| `re="…"`, `re="?"` | ✗ | `send.md` |
| `action="edit"`, `action="delete"` | ✗ | `send.md` |
| `<reaction>`, `action="remove"` | ✗ | `send.md` |
| `mentions="…"` | ✗ | |
| `<image/>` `<audio/>` `<document/>` … `name path` | ✗ | `path`: `bash.md` |
| Data elements `<location>` `<contacts>` `<calendar>` `<pr>` `<issue>` `<review>` `<review_comment>`, `data=` `diff=` | ✗ | Sending `<location>` and `<contacts>`: `send.md` |
| `<transcript re>` | ✗ | The Processors note |
| `<interactive>` `options` `links` | ✗ | `send.md` |
| `— N more messages in M other conversations not shown — search to read them —` | ✗ | |
| `… N earlier, not shown` | ✗ | |
| `unanswered — N conversations:` `· … — whatsapp group, 3 since 14:02 · mentioned`, `— N more` | ✗ | A reaction answers too: `send.md` |

## Principal

| Item | Described in system | Note |
|---|---|---|
| `<principal id name email at>` | ✓ | In Voices; its `id` grounds a memory like any line's |
| `<agent id name at>` | ✓ | In Voices: a steering room's line by a roster member who does not steer this agent |
| `action="reply\|edit\|delete"`, `on="…"` | ✗ | |

## Peers · `instructions/50-peers.md`

| Item | Described in system | Note |
|---|---|---|
| `agent="…"` line | ✓ | Conduct |
| `session@agent` on the local service | ✗ | |

## Permissions · `instructions/30-permissions.md`

| Item | Described in system | Note |
|---|---|---|
| `pending_approval` | ✓ | Its id: `cancel.md` |
| `<permission_response re verdict at>` | ✓ | A denied or lapsed call never ran; redraft from the reason |
| Verdicts `allow` `deny` `lapsed` `withdrawn` | ✗ | |
| `scope="…"` | ✗ | |
| `waiting — N approvals:` `· … — asked 14:02 · id …` | ✗ | `cancel.md` |
| Approval cards are already seen | ✓ | Conduct |

## Async calls · `instructions/40-async.md`

| Item | Described in system | Note |
|---|---|---|
| `<system kind="tool_result">` flags `gated` `async` `update` `final` | ✓ | |
| News that undoes what you said | ✓ | Conduct |
| `→` happened, `—` didn't | ✗ | |
| `sent`, then an update on failure | ✗ | `send.md` |
| `the script made N calls (…): K failed, J asked your principal` | ✗ | |
| `status="failed" error=`, `status="withdrawn"` | ✗ | `cancel.md` |

## Turn discipline

| Item | Described in system | Note |
|---|---|---|
| `<system kind="control">cancelled by your principal — the turn stopped here` | ✗ | |
| `<system kind="error">` | ✗ | |
| `<system kind="alarm">` with `7 Nov 17:30 … — doc › heading, remind …`, a line each | ✓ | The lines whose reminder came due. In Agenda |

## Knowledge · `instructions/60-knowledge.md`

| Item | Described in system | Note |
|---|---|---|
| `[handle]` heading on an inlined doc | ✗ | |
| `NN% of 2,200 chars` | ✓ | |
| `# On-demand docs` index | ✗ | Its opener line |
| `· keywords: …` on an index line | ✗ | |
| Three scopes | ✓ | |
| Header `kind` `description` `load` | ✓ | A format the agent writes |
| Header lists `keywords` `conversations` | ✓ | A format the agent writes |
| What each `load` value puts in front of the agent | ✓ | A consequence the index hides |

## People · `instructions/80-people.md`

| Item | Described in system | Note |
|---|---|---|
| Profiles in `profiles/`, the principal's loaded always | ✓ | Conduct, with a header example |
| Tiers as keywords, links as `[name](path)` | ✓ | Conduct |
| `not sent: read … first, then send again` with the room's last lines and its profiles | ✗ | A tool result that reads as itself |

## Memory · `instructions/70-memory.md`

| Item | Described in system | Note |
|---|---|---|
| A line's `id`, as the ground of a memory | ✓ | Conduct |
| `<checkpoint>`, as short-term memory | ✓ | Conduct |
| `<system kind="unload" since="…">` | ✓ | Asks for conduct: write the span down, answer nobody |

## Agenda · `instructions/90-agenda.md`

| Item | Described in system | Note |
|---|---|---|
| A dated line `- [ ] @7 Nov 17:30 … #tag (2 Nov, 8be1d0)` | ✓ | A format the agent writes |
| A repeat after the moment, `every Tue`, `every 2 weeks`, `every last Fri`, `until 15 Dec` | ✓ | A format the agent writes |
| A step within the day, `every 30 minutes`, `every 2 hours`, `from 9:00 to 18:00` | ✓ | A format the agent writes |
| A reminder after any repeat, `remind`, `remind 1 hour before`, `remind 1 day before at 10:00` | ✓ | A format the agent writes; the clock wakes the agent with the line |
| `today — N:`, `tomorrow — N:` | ✓ | Each day whole, the whole-day entries first, then by the minute |
| `· 17:30 [ ] … #tag — doc › heading` | ✓ | A line of any doc the agent reads, under its doc and the heading under its title; a shared or system doc under its scope |
| `· 18:00 … — doc, every Tue, remind …` | ✓ | A repeating line on each day its rule takes, a stepping one at its first step; its repeat and reminder close the tail |
| `· 17:30-18:15 … — calendar …, in …` | ✓ | The calendar's events the log holds for the day, a series on each day its rule takes |
| A board, its `##` headings as columns | ✓ | A format the agent writes |

## Environment

| Item | Described in system | Note |
|---|---|---|
| `self` `name` `email` `phone`, `workspace` `timezone` `locale` | ✗ | |
| `## Principals`, `## Agents` | ✗ | |
| `## Connections` `… (yours)` / `(org)` | ✗ | |
| `## Processors` with its note | ✗ | |
| `# Programs` with its note | ✗ | The helpers: `bash.md` |
| `down — N connections:` `· … — whatsapp, logged out since 14:02` | ✗ | A connector never heard: `connector down, never heard since …` |

## Recall

Search pages, which arrive as tool results.

| Item | Described in system | Note |
|---|---|---|
| `match`, `seen="window\|checkpoint\|never"` | ✗ | `search.md` |
| `<call id at>`, `<contact name address/>`, `<profile address exists name/>` | ✗ | `search.md` |
| `<doc handle keywords conversations/>` | ✗ | `search.md` |
| `[handle]` and a doc's body, opening a page that reaches one room's newest line | ✗ | `search.md`: the reading a send asks for |
| `— whatsapp … : address book not reached —`, `… lines between, not shown` | ✗ | `search.md` |
