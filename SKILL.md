---
name: install-mu
description: Install and configure mu — an org-level agent harness where each person (principal) gets an agent acting for them over a shared event log. Follow this when a developer asks to install, set up, or customize mu.
---

# Install mu

You are a coding agent installing mu for a developer. Every step is idempotent and
non-destructive — re-running this skill is safe. Mechanical steps are exact commands;
judgment steps are marked **interview** — ask the developer, don't guess.

## 1. Create the org

Requires Deno ≥ 2 (`deno --version`; install via https://deno.com if missing).

```sh
deno run -A jsr:@liquen/liquen/init <org> && cd <org>   # the folder's name is the org's
deno task agent <username>                              # the developer's agent, on the roster
```

The org is a folder: `config.jsonc` declares it, `data/` fills at first boot, `.env`
carries secrets, and `deno.jsonc` names the package every task runs.

## 2. Credentials

One of, in the developer's preference order:

- `.env` with `ANTHROPIC_API_KEY=sk-ant-…` (a Console API key), or
- `ant auth login` (Anthropic platform OAuth) — then make sure NO `ANTHROPIC_API_KEY`
  line exists in `.env`, not even empty (blank ≠ absent; it shadows the OAuth chain).

Claude-Code/claude.ai subscription logins do NOT work for the API — only the two above.

## 3. First run

```sh
deno task repl      # talk to the agent; /quit to exit
```

The first run seeds `./data/` from the package's templates: the log, the agent's home
and its docs.

## 4. Customization — **interview**

The templates ship with the package; the live copies under `./data/` are this
deployment's. Edit the live copies; boot never overwrites. Ask the developer, then edit:

- **`org/instruction/org.md`** — org name, what it does, tone on its behalf, boundaries.
- **`agent/<id>/instruction/identity.md`** — who the principal is, how they write, what
  the agent may do autonomously vs. must ask about first.
- Optionally `harness/instruction/principal.md` — the machine contract; edit only if the
  org wants different channel/memory/conduct rules.

Every knob lives in `config.jsonc` at the project root: the model, effort, per-agent
`compactAt`/`keepRecent`, and the gate policy (default: only `send` is gated). The org is
where you run mu; `--dir <path>` names it from anywhere else.

## 5. Hand off

Show the developer: how to talk to their agent (`deno task repl`), where its memories
land (`./data/docs/agent/<id>/memory/`), and that the package's `DESIGN.md` +
`PROJECT.md` are the architecture and roadmap if they want to go deeper.
