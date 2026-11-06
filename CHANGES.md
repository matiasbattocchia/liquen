# Next batch: storage

Decided 2 and 3 Nov 2026. Conversation files become an object store the log guards.

## 1. Storage

`data/conversations/` becomes `data/storage/`: the one folder that moves to R2, S3 or another
object store, as `config.jsonc` names. It holds blobs, never docs.

- **No docs in storage.** Discovery never walks it. A doc declares itself by its header, and
  a received file can open with one (`conversations/5491133585694/media/81f9b45f1f6d1f8e.md`
  does), so a contact could otherwise send in a doc.
- **Three schemes, and no host path in the log:**
  - `storage://media/<hash>.<ext>`: kept by the harness, resolved to the configured backend;
  - `file://`: the agent's workspace, such as a file about to go out;
  - `https://`: an outside link.

  Render prints the URI and `aread` takes it, the rule docs already follow. `aread <uri>`
  prints the text; `aread <uri> --to <path>` lands the bytes in the workspace, for a program
  that needs a file.
- **Content-addressed.** The hash is SHA-256 cut to 32 hex (128 bits), one namespace for the
  org: a file forwarded to three chats is kept once.
- **The extension is the bytes'.** When the wire says `application/octet-stream`,
  `saveMedia` sniffs the bytes (`sniffMime`). The WhatsApp bridge's `CreateFormFile` labels
  every upload octet-stream, which is why the org holds 4,276 `.bin` files that are ogg,
  webp and mpeg. The bridge sets the part's `Content-Type` too (`open-bsp-whatsmeow`,
  outside this repo).
- **The log guards it.** An agent reads an object when an event it can read references it.
  Publishing writes each URI an event carries into `refs(uri, event_id)`, and the check is an
  `EXISTS` over `refs` joined to the agent's view: the policy on `storage.objects` on
  Postgres, the door's own check on SQLite and files.
- **A reference grants nothing.** Every `storage://` URI an event carries must already be
  readable by its writer (`WITH CHECK`, and the publish path on SQLite). Bytes the agent
  uploads are its own.
- **References keep an object.** It goes when no event references it; an upload whose
  message never landed has none.
- **No mounts.** Bubbles and containers mount no storage: `aread` resolves `storage://`
  through the agent's door. A program that needs the bytes (ffmpeg, a transcriber) gets them
  through `--to`, the same door.
- **The transcript caches go.** A transcript is an event already. The `<hash>.txt` beside an
  audio only spared a forwarded audio a second pass, and `refs` answers that: an event that
  references the same URI and has its transcript.
- **The bridge keeps its order.** It uploads before the message, and the path names no
  conversation.
- **The org's files move.** `conversations/*/media/` goes into `storage/media/` under the new
  hashes, each `.bin` sniffed, and each `file://` URI in the log is rewritten to its
  `storage://media/` one. The log then holds one scheme for harness-kept bytes, and no old
  path needs resolving.
- **A trial on R2.** An org runs on R2 for a while once the store is in. Moving it there
  carries what is on disk into the bucket, the step a docs switch from `filesystem` to
  `database` does not take.

# Then: small fixes

Decided 6 Nov 2026, from the review of `OPEN.md`.

## 1. A reminder's grace is the backlog

A reminder missed while the host slept fires within the agent's `backlogHours`, the backlog
it inherits at boot (24 by default), in place of `REMIND_GRACE_MINUTES` (`tick.ts:32`). One
number says how far back a waking agent looks, for lines and for reminders alike.

## 2. Removing an account says where to finish

`liquen connect --remove` names, per service, where the platform side is revoked, in place
of the one line it prints for all (`remove.ts:56`): the workspace's installed apps for
Slack, the account's third-party access for Google, the account's app permissions for
Microsoft, the phone's linked devices for WhatsApp.

## 3. The proxy's CA is minted per install

`openCA` makes the key and the certificate with openssl where none is laid under
`data/system/`, and the package ships neither (`src/proxy/ca.pem` and `ca.key` go). An org
that has its pair keeps it.

## 4. Containers carry tzdata

`src/scaffold/Dockerfile` and `sandbox/cloudflare/Dockerfile` install `tzdata`, so `date` in
a shell honors the org's `TZ`.

## 5. The bridge unescapes incoming cards

`parseVcard` in `open-bsp-whatsmeow` (outside this repo) reverses the escaping of `\`, `,`,
`;` and line breaks in `FN` and `TEL`, as the writer escapes them, so "Pérez, Juan" arrives
whole.

## 6. A connector never heard reads as down

`downOn` (`xi.ts:1582`) reads a row with no `heard_at`, whose `connected_at` is older than
`SILENT_AFTER_MS`, as `connector down, never heard`. A connector that crashes before its
first beat then shows down as one that stopped beating does. The read side alone changes.

## 7. `log turns` walks a cursor

`readTurns` (`turns.ts:368`) walks back by id, keeps only the turn it is assembling, and
emits each one it finishes; it stops at the limit, at `--since`, or at the turn asked for.
`PAGES` and the `pages: 50` of the views go, as does `ROWS` in `export.ts`: no window bounds
what a read reaches, and memory holds one turn.

## 8. One run log, bounded

Whatever runs the org writes `data/run/liquen.log`, through one function: the supervisor
attached or detached, and main raised alone by the REPL or the CLI. Each line is stamped
`HH:MM:SS [name]`; attached, the same lines print to the terminal too. The append redirect
in `detach` goes. The file is bounded as a background job's output is: past a cap, a hole is
punched up to the newer half's first line (`readLog` in `exec/bash.ts`, `fallocate
--punch-hole`), so the offsets stay and a `tail -f` reads on. The cap is a named constant.

## 9. A member's sign-in can leave mail out

`CONNECTORS.md`, beside `listen`, says how one account stays out of an ingest the service
runs: its sign-in link carries `?scopes=` without the mail scope (`gmail.readonly`,
`Mail.ReadWrite`), so its mailbox is neither polled nor readable on demand, while the org's
mailbox is.

## 10. The REPL says when the world is not connected

A REPL that raised main alone (`attach.ts:100`) says so on entry: no connectors, edge or
tunnel run, a send waits in the log, and `liquen start -D` brings the org up. Main raised
alone stays as it is, a desk that ends 30 seconds after its last client.

## 11. A steering room's lines name their writer

A steering room stays a surface of the mind: whoever writes there steers, its lines fan in
and the mind's fan out, as now. Fan-in keeps the writer's roster id on the copy
(`extra.via`): the agent the surface row is stamped with, or the member the email on their
profile names. Render marks the line by it, as `authorKeyOf` marks a world line: one of the
agent's principals `principal`, another roster agent `agent`, anyone else nothing.

```
<principal name="Pablo" principal>pausá el informe</principal>
<principal name="scout" agent>listo el scraping</principal>
<principal name="Lucía">¿cuándo sale?</principal>
```

The system instructions say what each mark means, and `RENDER.md` lists them. A room the
org bot adopted stays a steering room when its agent later gets an account of its own.
