# Artifacts: where they are weak

What agents publish (`src/artifacts.ts`, `src/artifact-servers.ts`, the `publish` tool) has
known weak spots. They are kept as they are for now; each says what it lets happen. DESIGN
§9 says how artifacts work.

## The login and the box

- **The box link opens for whoever holds it.** A view key names the visitor's phone and
  lasts up to 4 hours (`VIEW_MS`), but nothing checks who holds it: forwarded, it opens the
  artifact for anyone, and the server takes them for the visitor it names. The box can't
  carry the login cookie, since it runs in an origin of its own.
- **A group's roster is read at the door alone.** Someone who leaves the group keeps the
  view key they hold until it lapses.
- **An unspent link logs in whoever presses its button first,** as that chat's or
  principal's number, for 7 days.
- **A login opens every artifact its phone belongs to.** The cookie names a phone, not an
  artifact, for 7 days (`LOGIN_MS`).
- **Codes live in main's memory.** A restart drops every code in flight and resets the
  caps (one a minute and five an hour per number).
- **The caps are per number.** Someone cycling through numbers an artifact admits can send
  each of them five codes an hour, from the org's account.
- **Only WhatsApp logs anyone in.** A principal whose only WhatsApp account is the one the
  org rides gets no code, since it would land in their chat with themselves, which can
  steer an agent: their link is their one way in, and on another device the agent has to
  publish again to mint them a new one.
- **The visitor's phone is in the box's URL,** so it is in the browser's history and in any
  log of the path. `no-referrer` keeps it from leaving with a link.
- **The door speaks English** to every visitor.

## The server

- **`native` runs code outside Deno's checks.** It grants `--allow-ffi` on the npm cache
  and `--allow-sys`. Tested: native libsql, its reads and writes limited to its folder,
  wrote a file outside it through SQL (`ATTACH DATABASE '../outside.db'`); Deno's own
  `node:sqlite` refuses the same statement. So a server that builds SQL from a visitor's
  input can read any SQLite file the org's user can, the org's log under `data/log/`
  among them, and create files wherever that user writes. The FFI grant stops the
  server's JavaScript from loading libc itself, but any native addon already in the npm
  cache loads.
- **Without a sandbox the kernel fences nothing.** With `deployment.sandbox: null`, as on
  `~/new`, the server is the org's user, and Deno's flags are its only fence: they stop a
  visitor who exploits the server's code, not the agent that wrote it, which runs
  anything through its shell already. Under `bwrap` the bubble fences native code too:
  the agent's folder, `shared/` and `system/` are all it sees.
- **Every token the agent holds rides with the server.** It runs in the agent's
  environment, so every placeholder the proxy fronts for that agent is there, each limited
  only by its own hosts and the server's `hosts`.
- **The agent can put anything on the socket.** It sits in the agent's folder. Main speaks
  only to a socket with one name, so neither a link nor a hard link to main's sockets is
  followed; a server of the agent's own that relays to them is stopped only by the bubble,
  which shows no socket of main's.
- **No limit on memory, CPU or disk.** A server can fill the disk through its folder or
  take the machine's memory, and one that keeps ending is started again once a minute,
  for good.
- **The code is whatever the folder holds at each start.** A restart after a crash runs
  edits made since the last publish, never approved; the card shows the hosts and
  `native`, never the code.
- **A server rewrites its own log.** `.artifact.log` is in the folder it may write.
- **A request's body is read whole** by the edge and by main, with no cap of their own.
- **It runs on this machine alone.** An org whose shells run in a Cloudflare sandbox can't
  run one.

## Next

- Drop `native`. It is there for Lucas's buscador, whose vector search uses libsql's index
  (`vector_top_k`), for a few days; then the search moves off it and `publish` loses the
  flag.
- Bind the box to the visitor: short view keys renewed through the door, or a key tied to
  a secret the browser holds; tokens spent per device; codes and caps kept in the store,
  with a cap per caller; the door in the visitor's language.
