---
name: install-mu
description: Install and configure mu — an org-level agent harness where each person (principal) gets an agent acting for them over a shared event log. Follow this when a developer asks to install, set up, or customize mu.
---

# Install mu

You are a coding agent installing mu for a developer. Every step is idempotent and
non-destructive — re-running this skill is safe. Mechanical steps are exact commands;
judgment steps are marked **interview** — ask the developer, don't guess.

## 1. Get the code

```sh
git clone <REPO_URL> mu && cd mu        # placeholder until the repo is published
```

Requires Deno ≥ 2 (`deno --version`; install via https://deno.com if missing).

## 2. Verify the machine

```sh
deno task check && deno task test
```

All tests must pass before continuing. (Two "smoke" tests report *ignored* without an
API key — that's expected.)

## 3. Credentials

One of, in the developer's preference order:

- `.env` with `ANTHROPIC_API_KEY=sk-ant-…` (a Console API key), or
- `ant auth login` (Anthropic platform OAuth) — then make sure NO `ANTHROPIC_API_KEY`
  line exists in `.env`, not even empty (blank ≠ absent; it shadows the OAuth chain).

Claude-Code/claude.ai subscription logins do NOT work for the API — only the two above.

## 4. First run

```sh
deno task smoke     # live transport round-trip (needs credentials)
deno task cli       # talk to the agent; /quit to exit
```

The first run seeds `./data/docs/` from the `src/seed/` templates and creates the
agent's workspace under `./data/workspace/`.

## 5. Customization — **interview**

The templates under `src/seed/` are the org's defaults; the live copies under
`./data/docs/` are this deployment's. Both are meant to be edited; boot never
overwrites. Ask the developer, then edit:

- **`org/instruction/org.md`** — org name, what it does, tone on its behalf, boundaries.
- **`agent/<id>/instruction/identity.md`** — who the principal is, how they write, what
  the agent may do autonomously vs. must ask about first.
- Optionally `harness/instruction/principal.md` — the machine contract; edit only if the
  org wants different channel/memory/conduct rules.

Config knobs (in `src/cli.ts` today, `MainConfig` when embedding): model (`MU_MODEL`,
default `claude-opus-4-8`), data dir (`MU_DIR`, default `./data`), per-agent
`compactAt`/`keepRecent`, and the gate policy (default: only `send` is gated).

## 6. Hand off

Show the developer: how to talk to their agent (`deno task cli`), where its memories
land (`./data/docs/agent/<id>/memory/`), and that `DESIGN.md` + `PROJECT.md` are the
architecture and roadmap if they want to go deeper.
