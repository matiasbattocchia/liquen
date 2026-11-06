# What is open

The items still under discussion, grounded against main at `51764a0` (2026-11-06). Each says
what holds, shows it, and ends on the options and the one recommended. What is decided lives
in `CHANGES.md`, what is parked in `DESIGN.md` §10.

## Agents and surfaces

- [ ] **A steering room outlives the agent's own account.** A steering room is a Slack
  channel or Teams group chat named like an agent: whoever writes there steers the agent's
  mind, `/y` settles its cards, and every line of the mind is copied out to it. The org bot
  adopts it only for an agent that owns no account, and checks that once, at adoption.
  *Example:* `sonar` runs with no account, and #sonar becomes its steering room. Later Pablo
  runs `liquen connect slack bot --agent sonar` and declares `principals: ["pablo"]`, meaning
  to steer sonar only by DM. Anyone in #sonar can still steer it and `/y` its cards, and
  Pablo's DMs to sonar are copied into #sonar for the whole channel to read.
  **Options:** (a) the view's rooms branch asks, every time, that the agent own no account,
  as adoption does once: nothing written, and removing the account brings the room back;
  (b) connecting an account releases the agent's rooms and says so; (c) leave it.
  **Recommended:** (a).
- [ ] **A connector that dies at boot never reads as down.** The supervisor sees every
  exit and restarts with backoff, but writes only to stderr. "Down" is a `heard_at` older
  than 120 seconds, so a connector that beat once and then crash-loops does show down; one
  that never beat has no `heard_at` at all.
  *Example:* a new Slack connector crashes 10 seconds after every start. The agent never
  sees "connector down", and its sends just wait.
  **Options:** (a) beat at boot: backfires, since a process that restarts within the window
  keeps itself fresh; (b) the supervisor stamps the exit and its code on the service's rows,
  which gives the reason but has the supervisor open the store; (c) a row with no
  `heard_at` whose `connected_at` is over 120 seconds old reads "connector down, never
  heard", a few lines on the read side. **Recommended:** (c), and (b) later if the reason
  turns out to matter.

## The run log

- [ ] **`liquen.log` has one writer, and nothing trims it.** It is the detached
  supervisor's terminal kept on disk: its own lines, and every child's output stamped
  `HH:MM:SS [name]` (the roster, the edge, connector failures, the proxy's audit, a line per
  turn). A foreground `liquen start` prints and writes nothing. A daemon the REPL or CLI
  raises runs with its output discarded, a crash at boot included. The truncation commits
  are about tool output and job spools; the file only grows.
  *Example:* `new`'s file holds 9 MB after 42 hours, 45,381 of its 61,865 lines a Teams
  subscription poll failing with its stack trace. Opened from the REPL with no org running,
  the same org writes nothing there while `liquen log turns` lists every turn.
  **Options:** who writes: (a) the REPL's daemon appends to the same file through the
  helper `start -D` uses; (b) as (a), and main stamps its own lines when it runs alone, so
  the file reads one format. Trimming: (c) roll it at `start -D`, no help to a long run;
  (d) the supervisor copies it to `liquen.log.1` past a cap (10 MB, a named constant) and
  truncates in place, the append redirect writing on; (e) logrotate, outside the product.
  **Recommended:** (b) and (d). The Teams failure is worth a look of its own.
- [ ] **`log turns` reads back a bounded window, for no recorded reason.** Plain
  `log turns` and a one-turn export walk back 20,000 rows; `--since`, `--turn` and
  `requests` 100,000. The likely reasons: each page reassembles every turn gathered so far,
  so the cost grows quadratically, and every row sits in memory with its payload. The full
  export already reads without bound.
  *Example:* after a flood of 30,000 photo rows, `log turns` shows nothing older than the
  last 20,000.
  **Options:** (a) raise the caps; (b) an `--all`; (c) walk an id cursor, keep only the turn
  being assembled, emit each finished one, stop at the limit, the `--since` or the turn
  asked for; (d) a query for turn boundaries alone. **Recommended:** (c): it makes the bound
  needless rather than larger.

## Search

- [ ] **Search returns a call's answer, never what came of it later.** `calls: true`
  returns the agent's own calls, failed answers marked `—`. A late word is left out: a send
  that failed to arrive still reads "sent", an asked call reads `pending_approval` whatever
  the principal said. Failed sends show in message search as `status="failed"`, and no
  filter selects them. `error` events (a provider down, a checkpoint that failed) are
  searchable nowhere.
  *Example:* the agent searches its calls of yesterday and reads
  `send to Ana "call at 6" → sent`, though the send failed for good an hour later.
  **Options:** (a) a call's line carries its latest late word (`· later: not delivered:
  not_in_channel`); (b) a `failed: true` filter for calls; (c) `errors: true` over `error`
  events. **Recommended:** (a), with (b) if wanted; `error` events wait for a trace tool,
  since the agent can rarely act on them.

## Scripts calling tools

- [ ] **A script's call runs to the end once it starts.** The door answers with a signal
  nothing aborts, and writes the call's row after the answer. A send's work is one row in
  the log, so a call lasts milliseconds: Ctrl-C finishes at most the call already sent, and
  a crash must land between two local writes. The message still goes and shows in search;
  only its call row is missing. Nothing retries a door call, so nothing sends twice.
  *Example:* you Ctrl-C a script in a loop of ten sends during the fourth. The fourth
  still goes, the last six do not.
  **Options:** (a) the door writes the call row first, and main answers at boot any it
  finds unanswered; (b) a lock per call, worth it only once xi runs off main; (c) park
  until scripts see real use. **Recommended:** (c).

## The model's window

- [ ] **Thinking drops come from upgrades, not from a long day.** A replayed thinking block
  is tied to every byte before it; when one renders differently, the API drops the block,
  and stderr logs a line. On `new` from 4 to 6 November, 57 drops over 70 mind turns sat
  at five positions. Each streak began at the first turn after a restart onto new code, and
  each ended at the next unload or checkpoint; none started mid-run.
  *Example:* main restarts on a commit that changes how an old line renders. The next turns
  answer without their earlier reasoning until the checkpoint folds that line.
  **Options:** (a) close it and record the finding in `DESIGN.md`; (b) a drop count on the
  turn's line; (c) a `liquen log` view of drops; (d) a checkpoint on upgrade.
  **Recommended:** (a), the stderr line kept as the canary; (d) if upgrades grow frequent.

## Config and accounts

- [ ] **Listening switches a whole service on, every account under it.** `listen` sits on
  `connections.google` or `connections.microsoft`, and each ingest it names runs for every
  grant there: the org's mailbox and each member's alike. The Gmail poll reads the whole
  inbox and sent folder of every grant that consented to read mail, and the default scopes
  include it.
  *Example:* the org signs in `info@acme.com`, and Ana signs in `ana@acme.com` only so her
  agent sees her calendar. Every message of both mailboxes lands in the log; Ana's stays
  visible only to her agent, but all of it is stored. There is no way to say "mail for
  info@, calendar alone for Ana", nor "only the threads the agent took part in".
  **Options:** (a) document the route that exists: Ana's sign-in link carries `?scopes=`
  without `gmail.readonly`, so her mailbox is never polled, nor readable on demand; (b) a
  `listen` per grant, set at sign-in; (c) a filter to the agent's threads, costly.
  **Recommended:** (a) now, (b) when a member asks.

## Infrastructure

- [ ] **The proxy names no agent on a blind tunnel, nor on an org-wide grant.** Every shell
  dials one proxy port. For a host a grant fronts, the proxy opens TLS, swaps the
  placeholder token for the real one, and learns the agent from the placeholder. Any other
  host it only pipes, and logs `CONNECT host` with no one behind it. A grant the whole org
  shares carries no agent either.
  *Example:* `[proxy] - CONNECT pypi.org:443 → 200` does not say who installed what. On
  `new`, all 98 rows of the egress table name no agent, the 21 swapped ones included, since
  `token:parallel` is the org's.
  **Options:** (a) the agent rides in the proxy URL, `http://<agent>:<nonce>@127.0.0.1:port`,
  which curl, pip, git, npm, Go and node send on every request and tunnel; (b) a port per
  agent; (c) leave it. **Recommended:** (a): the agent comes from the connection, not the
  token.
