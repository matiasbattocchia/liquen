# Next batch: the org's configuration lives in the store

Decided 12 Nov 2026. Driven by turtle-agents' requirements for agents made at runtime;
All eight are settled.

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
floor (5), a fact of the agent rather than a setting. `principals` stays a JSON column
(`jsonb` on Postgres), since its absence says something a list cannot: absent, who steers
is derived from ownership (§4); `[]`, nobody does; `"*"`, anyone writing in its steering
room does (13). Most are the columns SQL joins: the
roster views (`principals`, `aliases`) and the ingest classifier read them, and policy and
routing stand on those views. It carries no settings: `model`, `effort` and `provider`
leave it for `config`, `runs` becomes `config`'s `mind`, and the resolved `settings`
column goes.

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
room routed to an agent (requirement 8) is a `mirrors.rooms` entry there.

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

main takes the change for that one agent, the others running on (6).

## 4. Boot and reload apply the file to the store

Boot is a reload at start. A key the file declares overwrites the store's; a key it leaves
out keeps the store's value; an agent it does not declare is left alone, and named at
boot when idle (7). Removing a key from the file stops pinning it, and does not reset it.

So every key has one owner: the file when it declares it, runtime otherwise. A command
that would change a key the file declares refuses: `agents.dubiku.model is declared in
config.yaml; edit it there`. In a pod, the repo owns what its file declares and the
volume owns the rest.

## 5. The backlog floor

The floor is a fact of the agent, written once when its row is made: that moment less
`backlogHours`, a column of `agents`. A boot never moves it, so the history an agent's
prompt opens on stays put and its cache with it. A row without one gets it the first time
boot sees it, the same write.

## 6. main brings one agent up, down, or changes it, and boot is up for each row

main builds what an agent runs on from the roster it read at start, so today the only way
it takes a change is a restart, which cuts every agent's turn and ends every agent's
background jobs. Instead each agent's part is held by agent, and two steps make or undo it:

**Up** — the agent's entries, its writes, and its subscription:

- its metered transport in `stock`; its runner in a map keyed by agent, which the named
  sessions and `tune` look it up in, and which the clock and the presence handler already
  read on every call;
- its ground in the sandbox, through a new `add(agentId)`: on this machine its folder,
  `bin/`, its proxy nonce and its exports; on the gateway its sandbox;
- the provider check, the mind's membership, `seedAgent`, the folder and its Unix user
  (requirement 4), each a write that converges;
- its subscription to its own view of the log, its unsubscribe kept by agent, then the
  trigger-less look at what the log owes it.

**Down** — the same, undone: the unsubscribe, its debounce timer cleared, its turns in
flight waited out, its keeper stopped, its transport and named runners dropped, and
`remove(agentId)` on the sandbox, which ends that agent's shells and no one else's.

Boot is up for each row. A command that adds an agent brings it up; one that removes it,
or pauses it (`mind: false`), brings it down once no turn of it runs; unpausing brings it
up. A change of settings is neither: the runner's config and transport are read at every
invocation, so main replaces the agent's config and its `stock` transport, as `tune` does
for an attached CLI, and the next turn runs on them while the running one finishes as it
began. A change of `export` also tells the sandbox.

## 7. Removal is total, and the database enforces it

`liquen agent --remove <name>` brings the agent down (6), then deletes it in one
transaction, and its folder and Unix user after it commits. An agent the file declares
refuses: `agents.<name> is declared in config.yaml; remove it there first`; taken out of
the file, it is an undeclared agent, still running, until the command removes it.

The store's references to an agent are foreign keys and one trigger, the same on both
engines (SQLite's `PRAGMA foreign_keys = ON` on every connection `openLog` opens):

- a trigger on deleting from `agents`, one per engine, raises when another row's
  `principals` names the agent: it is refused removal, and the refusal names who. A key
  cannot point into a JSON array, so the trigger is the `RESTRICT`; that a principal
  named exists is the store function's check (8). An agent naming itself, and `"*"`,
  name no one it waits on;
- `memberships`, `connections`, `credentials`, `rules` and `locks` reference `agents`
  `ON DELETE CASCADE`: what the agent owns goes with its row, its keys and its grants
  included;
- `config`'s `agents.<name>` scope and, under `docs: database`, the agent's docs are
  deleted in the same transaction: a scope is a string, no key;
- `events`, `usage` and `egress` are history and reference nothing: their `agent_id`
  stamps stay.

Nothing the agent saw leaks by it: with its connection rows and memberships gone, its
traffic is visible through no branch of the law, and other agents' memberships in shared
rooms are their own. A `mirrors.rooms` entry naming it drops out of `aliases` by the join.

A name added again is the agent coming back: its mind room is `mind@<name>`, the log keeps
it, and the new membership grants it whole, so the agent reads its history again. Its
folder, its keys, its verdicts and its grants are gone; an account granted again brings
that account's history back with it.

Boot's mirror deletes leave an agent's memberships, connections, keys and verdicts behind
when it leaves the roster, and a constraint is not added over such rows: the change that
adds the keys deletes them first, on both engines.

**Idle.** An undeclared agent with no turn for 30 days (`IDLE_DAYS`, its last `usage`
row) is named at boot, one line for all of them. `liquen agent` with no name lists every
agent: declared or not, running or paused, its last turn.

## 8. A caller writes the rows and pokes main's socket

The connector and the command take the same steps, so they are one path:

1. **One store function** (`upsertAgent`, and `removeAgent` for 7) checks and writes: the
   name a folder and a Unix user can be, the provider able to run the model at its effort,
   no key the file declares (4), every principal named a member. Then `agents` and the
   `config` scope `agents.<name>` in one transaction, the backlog floor when the row is
   new. The agent's docs are seeded beside it, write-if-absent, so its instructions can be
   written before it runs.
2. **The poke**: `POST {agent: "<name>"}` on `data/run/main.sock`, which main serves the
   way the supervisor serves `liquen.sock`. main reconciles that one agent from its row,
   up, down or a tune (6), and answers with which, or with the sentence it refused on (a
   `useradd` that failed). The socket is root's, 0600, in a container: an agent's own
   user cannot connect to it.
3. **main down**: the poke finds no socket, and the caller says the change runs at the
   next start; the rows are written, and boot reconciles every row.

Up makes the agent's Unix user when main runs as root, the container's case, and boot is
up for each row: a container's `/etc/passwd` is made anew at every start, so the users
are made from the rows every boot, and the entrypoints' user loop goes. Off root (a
laptop, bare or in bubbles) there is no user to make. Removal asks main over the same
socket to bring the agent down first, then deletes, the folder and the user included.

A tool an agent calls to make an agent runs inside main: it calls the store function and
the reconcile directly, through the permission table like any call.

**The data classification is boot's too**, when it runs as root. Up gives the agent its
folder (`<name>:agents`, 0700); boot, after seeding, gives the floors theirs:

    log/      root:root 0700
    shared/   root:agents; its folders 2775, its files g+rw; a default ACL giving the
              group rwX
    system/   read-only to all, but ca.key: the egress CA's key, root's alone, 0600

The order is boot's to keep: the group, then the users, then the owners; the seeding,
then `system/` made read-only. The sweeps stay recursive, as the entrypoints run them, so
a boot also mends ownership that drifted.

A root deployment needs `groupadd`, `useradd`, `userdel`, `chown`, `chmod` and `setfacl`
(the `acl` package) in its image; boot refuses, naming the tool, when one is missing. The
entrypoints keep what is the org's own (turtle's sync, its vault puts, `chmod 700
/repo/tenants`) and end in `exec liquen start`.

## 9. An agent starts from the default seed, and no org has templates

Requirement 5 is answered by what exists: a new agent gets `instructions.md` and
`memories.md` at its folder's root, laid where missing, and its principal shapes it from
there. What every agent of the org shares is `shared/`'s.

## 10. Scaffolding lays the org's files; updating brings `data/system/`

**Scaffolds** are the org's from the moment they are laid, and no release touches them
again: `shared/instructions.md` and `shared/memories.md`, each agent's two, `config.yaml`.

**System docs** are the release's words, kept as files in `data/system/` where agents read
them: `instructions/`, `tools/`, `compaction.md`, the skills shipped and the ones a
connector's door lays. Each is brought one by one, so a file a release adds reaches every
org; the folder rule (a folder the org has is never laid into again) goes.

**The manifest** is in the database, whatever `docs` says, in one table of what the org has
taken from releases: the schema's version (in place of Postgres's `schema_version` and
SQLite's `user_version`), the release it last booted, and per system doc the hash of the
release text it last took or acknowledged.

**The rules**, per doc; the release's text against the file and the manifest's row:

| Release | File | Who | Action |
|---|---|---|---|
| ships it, no row | missing | boot | lay it: new in this release |
| ships it | as the release's | boot | record it |
| changed it | unedited (as the row) | boot | replace |
| dropped it | unedited | boot | delete |
| changed it | edited | update | replace, keep, or the release's beside it as `.md.new` |
| ships it, a row | missing: the org deleted it | update | lay it again, or keep it deleted |
| dropped it | edited | update | delete, or keep |
| did not change it | edited or missing | none | the org's choice stands |

**One path.** `bringSystemDocs` (`bringToolDocs` grown) plans, sorting each doc into a
row, then applies: the unambiguous rows always, each ambiguous one through a `decide` its
caller gives. Boot's decides nothing: the doc stays as the org left it, and every boot names
the ones unresolved. `liquen update` moves the lock, then runs the same function through
the org's import map, so the text it weighs is the new release's; its `decide` asks at a
terminal and reads flags without one, printing the command to re-run with:

- `--restore [<doc>…]` lays again what the org deleted;
- `--replace [<doc>…]` takes the release's words over the org's, and deletes what the
  release dropped;
- `--beside [<doc>…]` lays the release's text as `<doc>.md.new`, not loaded: no `.md`;
- `--keep [<doc>…]` takes the org's as acknowledged: the row records the release's hash,
  and the doc is quiet until a release changes it again.

No name means every doc of its kind. The plan is idempotent, so the order of boot and
update is free, and `update` without flags at a terminal answered "none" is a dry run.

**Adopting it.** An org with no manifest records each doc that matches the release as
taken, and treats every other doc, a missing one included, as the org's choice: turtle's
deleted skills stay deleted.

Tool docs carry no `load`. Linked checkouts (`data/system/` folders symlinked at a liquen
checkout) go: an org takes the harness's words from a release, so ~/new and vibes take
this batch by a release and `liquen update`.

## 11. An agent's own credential wins over the org's

`frontedFor` (`src/proxy/grants.ts`) picks, per env var, the agent's own row when it holds
exactly one, and the org's when the agent holds none and the org exactly one; a var
several rows contend for at the winning level stays unset. That is the order the model
keys already take (`vaultKeys`, `src/transport/mod.ts`): a member who connects a key of
their own spends it, and one who has not spends the org's.

## 12. Wakes follow the scope they are written in

Requirement 7 asks nothing of liquen. The clock reminds every agent that reads a doc of
the lines due in it (`remindDue`, `src/tick.ts`): a line in `shared/` or `system/`
reminds the org, one in an agent's folder reminds that agent. turtle's `sync.ts --arm`
lays sonar's poll and report wakes in `data/agents/sonar/wakes.md`, so only sonar wakes on
them.

## 13. A connector routes a room to an agent, making it on the room's first line

A room is routed to an agent by what exists: `extra.mirrors.rooms.<agent>` on an org
account's connection row, which main's mirror reads through `aliases` on every event and
copies the room's lines by into the agent's mind. `extra` merges by RFC 7396 on both
engines (SQLite's `json_patch`, Postgres's own), at every depth: a route is one upsert,
`{mirrors: {rooms: {ana: "<room>"}}}`, every other agent's left as it was, and
`{mirrors: {rooms: {ana: null}}}` takes it out. One room per agent per connection.

**`ensureRoute(service, connection, room, agent, entry)`**, exported from
`src/connector.ts` beside the store function and the poke (8), takes the steps in the
order the first line needs: the agent made if missing (`entry` its identity and settings,
`principals: []` unless the connector names someone), the route, the poke. The connector
then publishes the line: `aliases` joins `agents`, so the route holds once the row does,
and the mirror's copy into `mind@<agent>` is owed to the agent from its backlog floor, its
creation, whether main has brought it up yet or not. When a room earns an agent and what
it is called are the connector's; the name passes the store function's rule.

**The person behind it.** The connector gives every handle it knows (`name`, `email`,
`phone`): the agent is its person in the roster, as `matias` is in ~/new, and the person
has no Unix login: they reach the agent through its room. A line in the room the
classifier stamps as the agent itself is its person's, which steers, and whose `/y`
settles a card (`src/connect/mirror.ts`, the writer check).

**`"principals": "*"`.** Everyone writing in the agent's steering room steers, a roster
member the classifier stamped included: the mirror's check on who steers takes `"*"`, and
a writer it lets steer that way is recorded as a person, with no `via.agent`. A list keeps
the rule as it stands: a stamped member not on it is another agent among us. `"*"` lives
in the mirror alone: the `principals` view gives it no rows, so the aliases and the policy
built on the view are as a list of none leaves them. turtle declares it on sonar, so a
member with an agent of their own still steers sonar as a person.

## Docs

`CLAUDE.md`'s configuration section and DESIGN §9 (the file as the declaration the setup
doors write, boot compiling it into the registry, the registry as a mirror that deletes
what the file does not name) are rewritten to the above. `config.jsonc` is renamed
everywhere it is named. `CLAUDE.md`'s note on live copies (seeded write-if-absent, verified
with `diff -q`, or symlinked at the checkout) is rewritten to 10, and the seed's folder
rule leaves `src/store/seed.ts`. `src/store/connections.ts`'s header says `extra` merges
by RFC 7396 at every depth, where it says shallow and field-wise. DESIGN §4's steering
room takes `"*"` beside `[]`.
