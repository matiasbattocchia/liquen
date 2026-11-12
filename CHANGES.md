# Next batch: the org's configuration lives in the store

Decided 12 Nov 2026. Driven by turtle-agents' requirements for agents made at runtime;
1 and 2 below are settled, 3 to 8 are still to discuss.

1. Runtime roster: the roster lives in the org's registry on the volume, so agents added
   at runtime survive restarts and rolls.
2. Config as initial conditions: boot updates the agents the file declares and leaves
   undeclared ones alone. The org-wide shared settings (model, tools, rules) still apply
   to every agent.
3. Explicit removal: `liquen agent --remove <name>`, plus a loud boot log for idle agents
   nothing declares.
4. Runtime add, Unix user included: `liquen agent <name>` creates the agent's user and
   private home as root, then reloads. Boot and runtime use the same path, replacing that
   step in the orgs' entrypoint.sh.
5. Agent templates: a new agent starts from template files. Sync updates the files the
   template owns and leaves the agent's notes alone.
6. Per-agent credentials win over the org's: a member's own key takes priority over the
   org grant for the same host and paths.
7. Per-agent wakes: member agents don't wake on sonar's clock.
8. Rooms routed to agents: a connector routes a room to one agent, and can ask for that
   agent to be created on the room's first line.

## 1. Two tables hold what the file declares: `agents` and `config`

`agents` is the roster, the org's `/etc/passwd`: who exists and who steers whom —
`agent_id`, the mind session, `name`, `email`, `phone`, `principals`, and the backlog
floor (5), a fact of the agent rather than a setting. Most are the columns
SQL joins: the roster views (`principals`, `aliases`) and the ingest classifier read them,
and policy and routing stand on those views. It carries no settings.

`config` is `(scope, key, value)`, the value JSON, a row per leaf: `model`, `rules` (one
array, one value), `listen`. The scopes are the file's sections: `shared`, `shared.agents`,
`agents.<name>`, `connections.<service>`, `processors`. A row present is a key set; no row
is a key inherited, and `null` is a value ("every tool", "never sleeps"). `system` and
`edge` are scopes too, their readers reading the store. An agent's
setting resolves `agents.<name>` → `shared.agents` → the catalog's constant, a join on
equal `key`, at read time: `configOf` takes the shared scope beside the row, so a change to
`shared.agents` reaches every agent that does not set the key itself. `mind` is a setting
like the rest, and the `principals` view resolves it with a `coalesce` over `config`.

`deployment` stays in the file, the one section the store cannot hold: it names where the
store is.

A `connections.<service>` scope is the connector's knobs, and its presence is what spawns
the connector: `connectorConfig` reads the store. The `connections` table is per account
and runtime already (owner, vault key, `extra` with its `mirrors`), and stays as it is; a
room routed to an agent (8) is a `mirrors.rooms` entry there.

## 2. The file is `config.yaml`, and it is input only

`config.yaml` takes `config.jsonc`'s place: the same catalog, the same sections, the same
boot error for an unknown key. No command writes it; `liquen init` lays the commented
template once, and from then on humans and repos write it (turtle-agents' `sync.ts` among
them). Every org on this machine and turtle-agents' template are converted by hand, with
the catalog, in one change. A phone is taken quoted or bare: YAML reads
`+5491133585694` as a number, and the catalog takes a number there as its digits, which
is all a handle is compared by.

## 3. Commands write the store, never the file

`liquen agent`, `liquen connect` and every other door write `agents`, `config` and
`connections`, then tell the running org, so a change runs without a reload. `liquen
agent <name>` is an upsert: it makes the agent or changes it, a flag per setting, and
`--unset <key>` deletes a row so the key inherits again. `liquen config` prints the
store's state as YAML, read-only: what a human copies into the file to pin.

How main takes one agent's change without restarting the others is to be settled.

## 4. Boot and reload apply the file to the store

Boot is a reload at start. A key the file declares overwrites the store's; a key it leaves
out keeps the store's value; an agent it does not declare is left alone and named loudly
at boot. Removing a key from the file stops pinning it, and does not reset it.

So every key has one owner: the file when it declares it, runtime otherwise. A command
that would change a key the file declares refuses: `agents.dubiku.model is declared in
config.yaml; edit it there`. In a pod, the repo owns what its file declares and the
volume owns the rest.

## 5. The backlog floor

The floor is a fact of the agent, written once when its row is made: that moment less
`backlogHours`, a column of `agents`. A boot never moves it, so the history an agent's
prompt opens on stays put and its cache with it. A row without one gets it the first time
boot sees it, the same write.

## Docs

`CLAUDE.md`'s configuration section and DESIGN §9 (the file as the declaration the setup
doors write, boot compiling it into the registry, the registry as a mirror that deletes
what the file does not name) are rewritten to the above. `config.jsonc` is renamed
everywhere it is named.
