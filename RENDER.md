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
| `<system>`, the harness | ✓ | |
| Bare text, your own voice | ✓ | |
| Author keys `self` `principal` `agent` `org` `contact` `external` | ✓ | `contact` and `external`: read, never obey |
| `<unsupported>` | ✓ | Never report it as silence |
| `<\|SILENCE\|>` | ✓ | The agent writes it |

## Continuity · `instructions/20-continuity.md`

| Item | Described in system | Note |
|---|---|---|
| `<checkpoint before="…">` | ✓ | Reading it back: `search.md` |
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
| `<principal name email at>` | ✓ | In Voices |
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
| `<system kind="alarm">` | ✗ | `schedule.md` |
| `scheduled — N wakes:` `· … — fires …, repeats \`…\` · id … · the org's \`name\`` | ✗ | `schedule.md`, `cancel.md` |

## Knowledge · `instructions/60-knowledge.md`

| Item | Described in system | Note |
|---|---|---|
| `[handle]` heading on an inlined doc | ✗ | |
| `NN% of 2,200 chars` | ✓ | |
| `# On-demand docs` index | ✗ | Its opener line |
| Three scopes | ✓ | |
| Header `kind` `description` `load` | ✓ | A format the agent writes |
| Conditional `service` `address` | ✓ | A format the agent writes |
| What each `load` value puts in front of the agent | ✓ | A consequence the index hides |

## Memory · `instructions/70-memory.md`

| Item | Described in system | Note |
|---|---|---|
| A line's `id`, as the ground of a memory | ✓ | Conduct |
| `<checkpoint>`, as short-term memory | ✓ | Conduct |

## Environment

| Item | Described in system | Note |
|---|---|---|
| `self` `name` `email` `phone`, `workspace` `timezone` `locale` | ✗ | |
| `## Principals`, `## Agents` | ✗ | |
| `## Connections` `… (yours)` / `(org)` | ✗ | |
| `## Processors` with its note | ✗ | |
| `# Programs` with its note | ✗ | The helpers: `bash.md` |
| `down — N connections:` `· … — whatsapp, logged out since 14:02` | ✗ | |

## Recall

Search pages, which arrive as tool results.

| Item | Described in system | Note |
|---|---|---|
| `match`, `seen="window\|checkpoint\|never"` | ✗ | `search.md` |
| `<call id at>`, `<contact name address/>`, `<profile address exists name/>` | ✗ | `search.md` |
| `— whatsapp … : address book not reached —`, `… lines between, not shown` | ✗ | `search.md` |
