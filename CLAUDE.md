# Working in this repo

## Comments and docs state what IS

A comment earns its place by explaining something non-obvious about the code as it stands: a
wire fact, an invariant, a constraint the code cannot show for itself. Nothing else.

**No tombstones.** Never memorialize the old way, the incident that motivated a change, or
work in progress. No dates, no "used to", no "fixed", no "this replaces". The moment a change
lands, a note about what came before is talking to a reviewer who is gone; the next reader
needs the invariant, not the history. This holds in source, in tests, and in the design docs.

**The road not taken is also a tombstone.** Naming a rejected alternative is the same failure
pointed forwards — the reader has never heard of the thing being denied, so the sentence
teaches a nonexistent concept in order to negate it:

```
✗ …so there is no MU_DOOR variable and nothing to discover.
✓ The script's location is the whole of its addressing: it needs no configuration to find
  the socket, and it can only ever find its own.
```

Write the positive property. If the rejected design is genuinely worth recording, it is a
`PROJECT.md` entry, not a comment.

## Where things are written down

- `DESIGN.md` — architecture only: what the system is and why it holds together.
- `PROJECT.md` — dated entries: what landed, what an incident showed, what is still open.
  Connector minutiae and incident reports live here, never in `DESIGN.md`.
- Agent-facing instructions live in `data/system/instructions/`; `src/seed/` carries the
  copy shipped to a fresh deployment. Edit the live doc first, then copy out, and verify
  with `diff -q` so a restart cannot revert the change.

## Configuration

Knobs live in `config.jsonc`'s catalog or as named constants in source. The environment
carries only secrets and pointers like `MU_DIR`. An unknown key or section in the catalog is
a boot error, so `data/config.jsonc` and the catalog must change together.

## One path, no side doors

Never add a gateless fast lane beside a unified gated path — reads included. If a capability
exists for the model, a script reaching the same capability goes through the same permission
table, the same gate, and the same execution branch.
