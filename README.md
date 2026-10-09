# liquen

*Liquen* is Spanish for lichen, a fungus and an alga that live as one, and an org works the
same way here: each person is paired with an agent of their own, and every pair grows on
shared ground.

- **One agent per person.** It speaks in your name and knows the org you work in.
- **It meets you where you talk.** The terminal, Slack, WhatsApp, Teams, mail and calendar.
- **Agents work together.** Yours can ask a teammate's agent, and theirs can ask yours.
- **You stay in charge.** A risky step waits for your yes, given from any of those apps.
- **Your keys stay out of reach.** The agent never holds a token. A proxy adds it on the
  way out.
- **You own the ground.** Settings, memory and history live in a folder on your machine.

## Install

On Linux or macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/matiasbattocchia/liquen/main/install.sh | sh -s -- myorg
cd myorg && liquen repl
```

The script installs Deno when it is missing, makes the org, adds you to its roster and asks
for your Anthropic API key. Leave the name off and it installs only the `liquen` command.
An agent on Gemini reads `GEMINI_API_KEY` from `.env` instead.

## Use

```sh
liquen repl              # talk to your agent
liquen agent ana         # add a teammate
liquen start -D          # keep the org running in the background
liquen connect           # list the services you can bring in
liquen status            # see who and what the org holds
liquen schedule --help   # wake an agent on a clock
liquen update            # move to the newest release
liquen stop              # end the run
```

In the REPL you type to your agent. `/y` and `/n` answer its approval cards, `/cancel`
stops a turn and `/quit` leaves.

Each service guides its own setup, and `--help` on any of them explains the rest. Slack,
WhatsApp, Teams, Google and Microsoft mail and calendar, GitHub, and any HTTP API by token
come in the box.

Your org is a folder. `config.jsonc` holds every setting, `.env` the secrets, `data/` the
living state. Tell your agent who it is in `data/agents/<you>/instructions/agent.md`. It
reads the file fresh on every turn.

## More

- [DESIGN.md](./DESIGN.md) explains how liquen works and why.
- [PROJECT.md](./PROJECT.md) records what landed and what is still open.
- [SKILL.md](./SKILL.md) lets a coding agent do the install for you.

This repo is the package. An org runs a checkout of it once its `deno.jsonc` says
`"links": ["../liquen"]`, and `deno task check` and `deno task test` gate every change.
