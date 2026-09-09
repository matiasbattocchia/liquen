/**
 * github_xproc.test.ts — the cross-PROCESS functional test.
 *
 * The connection architecture is multi-process: the ingest runs in one process, the harness
 * (`main`) tails the log in another, both over a shared log dir. This asserts that path end to
 * end — a webhook delivered to the ingest PROCESS must wake a `subscribe` in a DIFFERENT
 * process — so the fs-watch propagation `main` relies on can't silently regress.
 */

import { assertEquals } from "@std/assert";
import { TextLineStream } from "@std/streams";
import type { Event, MessageEvent } from "../../connector.ts";
import { openLog } from "../../connector.ts";

/** Poll the ingest's ping until it answers (the process is up and serving). */
async function waitReady(port: number, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://localhost:${port}/`, {
        method: "POST",
        headers: { "x-github-event": "ping" },
        body: "{}",
      });
      await r.body?.cancel();
      if (r.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("ingest process never became ready");
}

Deno.test("cross-process: a webhook to the ingest PROCESS wakes a subscriber in ANOTHER process", async () => {
  const dir = await Deno.makeTempDir();
  const script = new URL("./ingest.ts", import.meta.url).pathname; // absolute — cwd-independent

  // a subscriber in THIS process — exactly what `main` does — resolves on the first gh message
  const log = await openLog(`${dir}/data/log`);
  log.upsertConnections([{ service: "github", address: "github" }]); // the gate wants a grant
  let resolveGot!: (e: MessageEvent) => void;
  const got = new Promise<MessageEvent>((r) => (resolveGot = r));
  const unsub = log.subscribe((e: Event) => {
    if (e.type === "message" && e.envelope.service === "github") resolveGot(e as MessageEvent);
  });

  // the ingest runs as a SEPARATE OS process over the same org — the org lives where you
  // run liquen (a cwd, not an env var). `ingestPort: 0` = any free port, read off the
  // announcement — no bind-and-release race for a parallel suite to steal.
  await Deno.writeTextFile(
    `${dir}/config.jsonc`,
    JSON.stringify({ connections: { github: { ingestPort: 0 } } }),
  );
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", script],
    cwd: dir,
    stdout: "null",
    stderr: "piped",
  }).spawn();
  let resolvePort!: (n: number) => void;
  const announced = new Promise<number>((r) => (resolvePort = r));
  const drain = (async () => { // scan for the announcement, then keep the pipe from filling
    const lines = child.stderr.pipeThrough(new TextDecoderStream())
      .pipeThrough(new TextLineStream());
    for await (const line of lines) {
      const m = line.match(/serving :(\d+)/);
      if (m) resolvePort(Number(m[1]));
    }
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const port = await Promise.race([
      announced,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("ingest never announced its port")), 10_000);
      }),
    ]);
    clearTimeout(timer);
    await waitReady(port);
    const res = await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: { "x-github-event": "issue_comment", "x-github-delivery": "xp-1" },
      body: JSON.stringify({
        action: "created",
        repository: { full_name: "ana/widgets" },
        issue: { number: 99, title: "x" },
        comment: { body: "cross-process hello" },
        sender: { login: "ana" },
      }),
    });
    await res.body?.cancel();
    assertEquals(res.status, 202);

    // the OTHER process's write must reach our subscriber via fs-watch (bounded wait)
    const e = await Promise.race([
      got,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error("subscriber never woke across processes")), 10_000);
      }),
    ]);
    assertEquals(e.envelope.conversation.address, "ana/widgets#99");
    assertEquals((e.parts[0] as { text: string }).text, "cross-process hello");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    unsub();
    child.kill("SIGKILL");
    await child.status;
    await drain; // the kill ends the stream; the reader must finish before the test does
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
});
