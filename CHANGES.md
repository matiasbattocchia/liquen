# Next batch: reload applies, and every process reads the store

Decided 15 Nov 2026. All seven are settled.

1. Reload applies the file to the store, and does nothing else.
2. The apply is three-way: the file's edit lands, a command's write survives, and a
   conflict warns.
3. Whoever spawns main applies the file first, and main only reads.
4. Main and the connectors read the store on each use.
5. A connection can be disabled and keep its knobs.
6. The supervisor runs the connections the store enables, and reload pokes it.
7. `liquen restart` takes up what only a start can.

## 1. Reload applies

`liquen reload` applies `config.yaml` to the store, then pokes the supervisor (6). It
takes no process names and restarts nothing: a process takes up a new value by reading it
(4). A change only a start takes up (7) is named in reload's answer, with the command that
takes it up: `edge.port changed: liquen restart edge`.

- **A key deleted from the file** stops being applied, and the store keeps its value.
- **`deployment`** stays the file's own and is read at start, since it says where the
  store is.

## 2. The three-way apply

The store keeps a base for each key: what the file said at the last apply. Every apply
weighs three values per key, the base, the file and the store:

| File vs base | Store vs base | The apply |
|---|---|---|
| same | anything | leaves the key alone, so a command's write survives |
| changed | same | takes the file's value |
| changed | changed | warns and keeps the store's value |

- **The warning** names each conflicting key with both values, then the two ways out:
  `--overwrite`, which takes the file's value, and `liquen config`, whose output the file
  can take to match the store.
- **`--overwrite`** takes the file's value for every conflict of that apply.
- **An apply at start** follows the same rule and prints the same warning. It never stops
  to ask.
- **A key with no base** compares as absent. Where the file and the store agree, the
  apply only records the base, so the first apply after this lands changes nothing.
- **Agents** are rows like any key. One the file declares and a command removed stays
  removed until `--overwrite`.
- **Commands write freely.** `liquen agent`, `liquen connect` and the `agent` and
  `connect` tools stop refusing keys the file declares (`declaredPaths` and `pinned` in
  `roster.ts`).

## 3. Whoever spawns main applies

The file is applied by whoever raises main, before it does: the supervisor at
`liquen start`, `attach` before it raises the ephemeral main, and an embedder through
`mod.ts`'s `start`. Main reads the store and never applies (`main.ts:206` goes).

## 4. Read on each use

A process reads the store's config as a unit of work starts, and holds that snapshot
until the work ends. For main the unit is a turn, a sign-in or a tick. For a connector it
is a delivery, a poll or a send. On the Supabase tier it is an invocation, which already
builds itself from the store.

- **A config version** keeps the read cheap. A trigger on the config table bumps it on
  every write, hand edits included. A unit of work reads the version, and reads the config
  again only when it moved.
- **Main reads** the machinery's knobs, the shared clock, the policy, the processors, the
  edge for the links a sign-in hands out, and `connections.whatsapp.bridgeUrl` for
  `contact`, `search` and the rooms. Agents it already reconciles from their rows.
- **A client built from a value**, such as the bridge's, is built again when the value
  moves.
- **`reads`** (`start.ts`) keeps only what a start takes up (7), so nothing restarts over
  a value a process reads live.

## 5. A connection can be disabled

`connections.<service>.enabled`, a boolean that defaults to true, joins every service's
section in the catalog. Set to false, the service is off and keeps its knobs, accounts
and secrets. Setting it back runs the service as it was.

- **The supervisor** runs nothing for a disabled service (6).
- **A sign-in** for it fails, and says the service is disabled.
- **Main's ports** for it refuse with an error that says the same.
- **`liquen connect --remove`** of a service's last account sets `enabled: false`, and
  leaves the section in the store.

## 6. The supervisor runs what the store enables

On a poke, the supervisor reads the store's connections. It starts each one that is
declared, enabled and not running, and stops each one that is running and no longer
declared or enabled.

- **Who pokes it:** reload, and every command that declares, disables or removes a
  connection (`connect/declare.ts`, `connect/connect.ts`).
- **A hand edit to the table** is taken up at the next reload. A reload over an unchanged
  file is the poke alone.

## 7. `liquen restart`

`liquen restart [<process>…]` stops and starts the processes it names, or the whole run
when it names none. It takes up what a process reads only at start: `edge.port`,
`edge.tunnel`, `deployment`, `.env`, and code, a processor module included, since Deno
caches an import.
