# Working in this repo

## What this repo is

The package `@liquen/liquen`: `src/`, the docs, the scaffold. An org is a folder somewhere
else — `config.jsonc`, `data/`, `.env`, its own `connectors/` and `processors/` — whose
`deno.jsonc` names the package and whose tasks run it; a checkout stands in for the
registry through `"links": ["../liquen"]`. No org file lives here.

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
- Agent-facing instructions are the templates in `src/seed/`. A running org holds its live
  copies under `data/system/instructions/`, seeded write-if-absent at boot, so a template
  edit reaches an existing org only through its live copy; verify the two agree with
  `diff -q`.

## Configuration

Knobs live in `config.jsonc`'s catalog or as named constants in source. The environment
carries only secrets. An unknown key or section in an org's `config.jsonc` is a boot error,
so the catalog and every org's `config.jsonc` change together.

## One path, no side doors

Never add a gateless fast lane beside a unified gated path — reads included. If a capability
exists for the model, a script reaching the same capability goes through the same permission
table, the same gate, and the same execution branch.

## Releasing

A release is a version tag: bump `version` in `deno.json`, commit, tag `v<version>`, push
the tag. The publish workflow refuses a tag that does not match the file, so a stale version
fails before anything is uploaded. Pushes to `main` publish nothing.
