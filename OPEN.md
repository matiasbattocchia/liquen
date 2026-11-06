# What is open

The items still under discussion, grounded against main at `f297308` (2026-11-06). Each says
what holds, shows it, and ends on the options and the one recommended. What is decided lives
in `CHANGES.md`, what is parked in `DESIGN.md` §10.

## Agents and surfaces

- [ ] **A steering room's writers all steer, principals or not.** A steering room is a
  Slack channel or Teams group chat named like an agent, on the org's bot. Its lines fan in
  to the mind signed by the wire's sender, and render as `<principal name="…">` whoever
  wrote them; `principals` does not reach it (DESIGN §4). The mind's lines fan out to it as
  to every surface. Another agent's line there comes in the same way, as a principal's,
  where in any other shared room it is a world line in the WUM. The org bot adopts a room
  only for an agent that owns no account, and the view never checks that again.
  *Example:* #sonar steers `sonar`. Pablo gives sonar a bot of its own and declares
  `principals: ["pablo"]`. In #sonar, Lucía writes "pausá el informe" and it reads as
  `<principal name="Lucía">`; `scout`'s bot posts "listo el scraping" and it reads as
  `<principal name="scout">`. Pablo's DMs to sonar, and sonar's answers, are copied into
  #sonar for all three to read.
  **The proposal:** the room stays, and `principals`, once declared, narrows who steers
  there. A writer the roster knows as one of them (by the email on their profile, as a DM
  resolves its member) steers; anyone else's line is a world line in the room's `<conv>`,
  in the WUM, which the agent answers with `send` as in any room. Declared nowhere, every
  writer steers, as today.
  **What it leaves open, fan-out:** (a) every mind line still goes to the room, Pablo's DMs
  included; (b) the room hears the turns its own steering lines opened, and the DMs keep
  theirs; (c) a room with declared principals gets no fan-out, only what the agent sends
  there. **Recommended:** the proposal, with (b): a principal who steers in the room reads
  the answer there, and what Pablo says in a DM stays in the DM.
- [ ] **A client raises main alone.** `liquen repl` or `liquen cli`, finding no agent's door
  answering, raises `main.ts --ephemeral` (`attach.ts:100`): main without the supervisor, so
  no connectors, edge or tunnel, ending 30 seconds after its last client. Only `liquen
  start`, attached or `-D`, runs the whole org.
  *Example:* with nothing running, you open the REPL and talk to `dubiku`. It answers, but
  Slack and WhatsApp stay silent, and a send to Ana waits in the log until a `liquen
  start`.
  **Options:** (a) keep it: a REPL is a desk, and the world comes in only when the org is
  started; (b) a client raises the supervisor, the whole org, detached as `-D` does;
  (c) as (b), asked first. **Recommended:** (a), with the REPL saying on entry that the
  world is not connected.

## Search

- [ ] **Search returns a call's answer, never what came of it later.** `calls: true` pairs
  each call with its first answer; a late word (a send's delivery failing, an approved call's
  result, a refusal, a lapse) is a `tool_result` flagged `update` or `gated`, which search
  skips. A failed send shows in message search as `status="failed"`, and no filter selects
  failures. `error` events are searchable nowhere.
  *Today*, the agent searches yesterday's calls:
  ```
  <call id="a1b2c3" at="5 Nov 2026 18:02" seen="checkpoint">send(to: Ana, text: call at 6) → sent · id d4e5f6 — the service delivers it; you are told only if it doesn't arrive</call>
  <call id="b7c8d9" at="5 Nov 2026 18:10" seen="checkpoint">send(to: Pablo, text: el presupuesto) → {"status":"pending_approval","id":"b7c8d9","note":"your principal was asked and has not answered yet — the call has NOT run. …</call>
  ```
  though the first never arrived and the second went out at 18:14. Message search shows the
  first as `<msg id="d4e5f6" self at="5 Nov 2026 18:02" status="failed" error="not_in_channel">call at 6</msg>`.
  *With (a)*, each line ends on its latest word:
  ```
  <call id="a1b2c3" at="5 Nov 2026 18:02" seen="checkpoint">send(to: Ana, text: call at 6) → sent · id d4e5f6 — the service delivers it; you are told only if it doesn't arrive · 19:05 — not delivered: not_in_channel</call>
  <call id="b7c8d9" at="5 Nov 2026 18:10" seen="checkpoint">send(to: Pablo, text: el presupuesto) → {"status":"pending_approval",…} · 18:14 → sent · id e1f2a3 — the service delivers it; you are told only if it doesn't arrive</call>
  ```
  *With (b)*, `search(calls: true, failed: true)` returns the first line alone: a call whose
  answer or latest word is an error.
  **Options:** (a) the latest late word on the call's line; (b) a `failed: true` filter;
  (c) `errors: true` over `error` events. **Recommended:** (a), with (b) if wanted; `error`
  events wait for a trace tool, since the agent can rarely act on them.

## Infrastructure

- [ ] **The proxy names no agent on a blind tunnel, nor on an org-wide grant.** For a host a
  grant fronts, the proxy learns the agent from the placeholder it swaps: an agent's own
  grant names it, an org grant names nobody. Any other host it only pipes, and logs
  `CONNECT host` with no one behind it. An agent's own grant works today:
  `liquen connect token parallel --env PARALLEL_API_KEY --hosts api.parallel.ai --agent
  sonar` gives sonar a placeholder of its own, and its egress rows read `agent_id=sonar`.
  Two agents may each hold one for the same host; an org grant on the same variable
  outranks both, so it goes first.
  *Example:* `[proxy] - CONNECT pypi.org:443 → 200` does not say who installed what. On
  `new`, all 98 egress rows name no agent, the 21 swapped ones included, since
  `token:parallel` is the org's.
  **Options:** (a) the agent rides in the proxy URL, `http://<agent>:<nonce>@127.0.0.1:port`,
  which curl, pip, git, npm, Go and node send on every request and tunnel; (b) a port per
  agent; (c) leave tunnels blind, and give an agent its own grant where a key's use must
  be traced. **Recommended:** (a): the agent comes from the connection, whatever the host.
