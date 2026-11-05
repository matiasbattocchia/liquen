# What is open

Grounded against main at `847667f` (2026-11-05). Each item says what holds today and how it
shows. Tick what matters.

## Before turtle's next release

- [ ] **Turtle's polls arm with a command that is gone.** `sync.ts` runs
  `@liquen/liquen/schedule --cron`, and the package no longer exports `schedule`: what is
  due lives in a doc's dated lines now. Turtle pins `^0.1.71`, which still has it.
  *Example:* after the bump, `sync acme` throws "arming the sonar wake failed", and no hare,
  lunar or report poll is armed until they move to a line like
  `every 90 minutes from 19:30 to 12:00`.
- [ ] **Turtle's config uses the old deployment words.** `"database": null` and
  `"docs": "files"` are boot errors on the next release; the new words are `"sqlite"` and
  `"filesystem"`.
  *Example:* turtle takes the release, and `liquen start` refuses with
  `deployment.database must be "sqlite" or a postgres:// URL`.
- [ ] **A stale tool name boots in silence.** Any string passes as a tool name, so an org
  that still lists `schedule` gets no such tool and no word about it.
  *Example:* `"tools": ["bash", "schedule"]` boots fine, and the agent has no tool by that
  name, with nothing saying why.

## Agents and surfaces

- [ ] **An agent's edit of its own line arrives as a new line.** A mirror points at the
  original only for a person's line; a raw surface gets `edit` with no reference.
  *Example:* the agent tells Ana "call at 5", then edits it to "call at 6". Her WhatsApp
  mirror shows a second line, "[agent] call at 6", and the first still says 5.
- [ ] **A lapsed approval shows only in the terminal.** The card stays on the phone, and a
  late answer is told it was already answered.
  *Example:* the agent asks Ana on Monday at 9:00 to approve an email. On Tuesday at 9:00 it
  lapses. At noon she answers `/y` to the card still on her phone and reads "that approval
  was already answered".
- [ ] **A steering room is never given back.** Slack and Teams adopt a room for any running
  agent that owns no account, and keep it when its person connects one later.
  *Example:* `#sonar` becomes the sonar agent's steering room. Pablo then connects his own
  Slack for sonar, and anyone in `#sonar` can still steer it.
- [ ] **A connector that dies at boot shows nowhere.** "Down" is read off a heartbeat, and
  the first beat waits 30 seconds.
  *Example:* a new Slack connector crashes 10 seconds after every start. The agent never
  sees "connector down", and its sends just wait.
- [ ] **Unsent messages are no list in the anchor.** The agent hears of one only when it
  stalls (15 minutes), fails, or lands after all.
  *Example:* the agent writes to Sam while the WhatsApp bridge is down. For 15 minutes
  nothing in its view says the message has not left.
- [ ] **Every line of a local group wakes every member.**
  *Example:* in a local group of five agents and two people, each line costs five model
  turns.

## Wakes and the run log

- [ ] **A reminder that finds nothing still costs a model call.** A check that skips the
  model is designed and not built.
  *Example:* "every 15 minutes check the hare poll" wakes the model all night, even when
  nothing changed.
- [ ] **A reminder missed while the host slept fires once, unmarked.** Each line fires at
  its latest due minute within a day's grace; the alarm does not say it is late, nor how
  many it skipped, and anything older than a day never fires.
  *Example:* the laptop sleeps from 7:00 to 11:00. "every day 08:00 pills" fires at 11:00
  as if on time, and an hourly line fires once, for 11:00. After two days asleep, the first
  day's reminders are gone.
- [ ] **A digest wake looks like a summons.** The wake carries no reason into the prompt.
  *Example:* a 30-minute digest of three Slack lines opens the turn exactly as Ana writing
  "are you there?" would.
- [ ] **A send that failed for good wakes nobody.** It is told as a quiet result in the
  session that sent it, read on that session's next turn.
  *Example:* a send to an archived Slack channel fails, and the note waits until something
  else opens a turn there.
- [ ] **A daemon the REPL raised writes nothing to `liquen.log`.** The REPL drops its
  stderr; the store keeps the turns.
  *Example:* you open the REPL with no org running. `liquen.log` stays empty while
  `liquen log turns` lists every turn.
- [ ] **`log turns` reads back a bounded window.** Plain `log turns` and a one-turn export
  read 20,000 rows; `--since`, `--turn` and `requests` read 100,000.
  *Example:* after a flood of 30,000 photo rows, `log turns` shows nothing older than the
  last 20,000.
- [ ] **`data/run/liquen.log` only grows.**
  *Example:* an org that runs for months fills its disk with one log file.

## Docs and memory

- [ ] **On the database, only the agent's own scope takes a write.** A shared conditional
  doc there is the operator's to write; on the filesystem, `shared/` is everyone's.
  *Example:* the agent decides "in the family group, always answer in Spanish" belongs in a
  shared doc. Its `write shared/familia.md` is refused.
- [ ] **Unload runs only when a checkpoint is due.** No size or daily trigger.
  *Example:* Gonza sends his new address on Monday, and the window reaches `compactAt` on
  Thursday. His profile lacks the address all week.
- [ ] **No scribe session.** Search marks lines never drawn, and nothing reads them on a
  daily wake.
  *Example:* of 300 WhatsApp chats the mind has drawn the 20 that spoke since it started.
  The other 280 people have no profile until they write.
- [ ] **A profile has no manners section.** `80-people.md` asks for a few of the
  principal's own lines to the person instead.
  *Example:* a profile can hold "che, ¿venís?" as a sample line, and has no place for
  "never voice notes to him".
- [ ] **A doc loads by conversation only, never by path.**
  *Example:* a coding agent cannot have a doc load because it works inside `~/proj/api`.
- [ ] **A comment names a tool that is gone.** `src/xi.ts:3682` says search bounds read
  "the way `schedule.at` is".
  *Example:* a reader looks for `schedule.at` and finds nothing.

## Scripts calling tools

- [ ] **A script's call runs to the end once it starts.** Hanging up or cancelling does not
  stop it, and a crash between a send and its use row leaves the send unrecorded as a call.
  Which of two fixes to take is undecided.
  *Example:* you Ctrl-C a script mid-call and the send still goes out. If the process dies
  right after, the message exists with no record of the call that made it.
- [ ] **No `trace` tool reads what an error's turn read.**
  *Example:* the agent cannot ask "what did my turn at 14:02 read?".

## Window, prefix and search

- [ ] **New templates reach the model as notices until the next checkpoint.** Tool docs are
  sent live, so a changed one misses the cache.
  *Example:* after an upgrade, a new `90-agenda` rule arrives as a notice, and an edit to
  `send.md` costs a cache miss on the next request.
- [ ] **Whether the API keeps every anchor and thinking block through a long day is still
  measured.**
  *Example:* a day-long session may log `thinking_dropped` lines on stderr; how often is the
  open question.
- [ ] **No index serves text search.** Every search scans.
  *Example:* searching "factura" reads every row in scope.

## Config and accounts

- [ ] **Listening is one switch per connection.** No mailbox per member, no threads-only.
  *Example:* turning mail on brings in both info@ and Ana's whole inbox, not only the
  threads the agent took part in.
- [ ] **Removing an account leaves the platform side.** The Slack install, the Google grant
  and the WhatsApp device are yours to revoke.
  *Example:* after `connect --remove` for Slack, the app stays installed in the workspace.
- [ ] **Some old rows need a reconnect, by design.** Mirror rows written with
  `self_conversation`, `dms` or `extra.agent`, grants from before `--paths`, and tool docs
  an org edited, which stay as they are.
  *Example:* an org that edited `send.md` never learns of its `contacts` parameter.

## Infrastructure

- [ ] **The Cloudflare sandbox's phase 2 is unbuilt.** No outbound handler: no fronted
  credentials and no egress audit there. Its fifth step, closing the sandbox's internet,
  runs against the rule that every mode reaches the world directly, and needs a call.
  *Example:* a `curl` in a Cloudflare sandbox goes straight out, leaves no audit row, and
  carries no fronted token.
- [ ] **The proxy's CA key ships with the package.** It wants minting per install.
  *Example:* anyone holding the package's `ca.key` can sign certificates every install's
  agents trust.
- [ ] **A blind tunnel's audit line names no agent.**
  *Example:* the line `CONNECT pypi.org:443` does not say who dialed.
- [ ] **A bubble reaches loopback, the LAN and abstract sockets.** By choice: it shares the
  machine's network.
  *Example:* a bubbled script reaches `localhost:5432` and the office printer.
- [ ] **Shells get the org's `TZ`, and neither Dockerfile installs tzdata.**
  *Example:* with the org on Buenos Aires time, `date` in the container prints UTC.
- [ ] **The SQLite poll runs whether anything changed or not.** It is not gated on
  `PRAGMA data_version`.
  *Example:* an idle org at 3 a.m. still runs several queries a second.
- [ ] **`install.sh` has never run on macOS, and no CI runs it.**
  *Example:* the first Mac user is the one who finds its break.
- [ ] **Gemini inlines no audio and caches nothing explicitly.**
  *Example:* on Gemini a voice note reaches the model as an `<audio/>` marker, and each step
  resends the whole window, with 18 to 36% of it cached now and then.
- [ ] **The edge host is deferred.** A `pg_net` trigger delivering each row, a `pg_cron`
  job running the clock, doors over HTTP.
  *Example:* an org on Supabase still needs its own long-running process; nothing in the
  database runs a turn.

## On a live account

- [ ] **Teams: the self-chat and group removal are untested.** Whether `getAllMessages`
  delivers the self-chat, whether `$expand=members` lists the account alone, whether the org
  hears its own removal from a group.
  *Example:* if the self-chat is skipped, Ana's notes to herself in Teams never reach the
  agent.
- [ ] **Slack: which leave and archive events reach the bot.** The code handles all five;
  only the join side was seen live.
  *Example:* if Slack does not tell the bot `#sonar` was archived, the room stays held, and a
  new `#sonar` is never adopted.

## Outside this repo

- [ ] **Contact cards from the bridge are not unescaped.** `parseVcard` in
  `open-bsp-whatsmeow` copies `FN` and `TEL` raw.
  *Example:* a card for "Pérez, Juan" with no display name reaches the agent as
  `Pérez\, Juan`.

## Parked

- [ ] **Switching docs from filesystem to database carries nothing across.**
  *Example:* an org switches, and its agents' memories under `agents/<name>/` stay behind
  on disk while the agents start empty.
- [ ] **Media in an object store**, and **sandbox workspace backups**: the ground is being
  laid by the storage work.
  *Example:* a gateway sandbox that restarts loses the files its agent made there.
