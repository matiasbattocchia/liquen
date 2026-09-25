/**
 * The SQLite adapter runs the vault suite, and answers for what is the file's own: two
 * processes merging one row under the engine's write lock, and the sweep of spent states
 * read straight off the table.
 */

import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { openCredentials } from "./credentials.ts";
import { credentialsSuite } from "./suite/credentials.ts";
import { sqlite } from "./suite/mod.ts";

credentialsSuite(sqlite);

/** One writer on its own thread and connection — a process's view of the vault. Each
 *  merges only its own field into the shared row, `n` times over, starting on `go` so
 *  the writers overlap rather than queue behind each other's boot. */
function writer(dir: string, field: string, n: number): { go: () => Promise<void> } {
  const code = `
  import { openCredentials } from ${JSON.stringify(import.meta.resolve("./credentials.ts"))};
  const creds = await openCredentials(${JSON.stringify(dir)});
  self.onmessage = async () => {
    for (let i = 0; i < ${n}; i++) {
      await creds.put({ key: "svc:org", value: { ${field}: String(i) } });
    }
    await creds.close();
    self.postMessage("done");
  };
  self.postMessage("ready");
`;
  const url = URL.createObjectURL(new Blob([code], { type: "application/javascript" }));
  const w = new Worker(url, { type: "module" });
  const ready = new Promise<void>((resolve, reject) => {
    w.onmessage = () => resolve();
    w.onerror = (e) => reject(e.error ?? new Error(e.message));
  });
  return {
    go: async () => {
      await ready;
      const done = new Promise<void>((resolve, reject) => {
        w.onmessage = () => resolve();
        w.onerror = (e) => reject(e.error ?? new Error(e.message));
      });
      w.postMessage("go");
      await done;
      w.terminate();
    },
  };
}

/** Two processes write DIFFERENT fields of one credential at once — the broker refreshing
 *  a token beside a connector recording a sibling — and both fields survive: the merge is
 *  the database's, decided under its write lock, never a read-merge-write in JS. */
Deno.test("two processes merging different fields of one credential both survive", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const n = 300;
    const [a, b] = [writer(dir, "token", n), writer(dir, "app_token", n)];
    await Promise.all([a.go(), b.go()]);
    const creds = await openCredentials(dir);
    try {
      const row = await creds.get("svc:org");
      assertEquals(row?.value, { token: String(n - 1), app_token: String(n - 1) });
    } finally {
      await creds.close();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** A state past its TTL is dead to `consumeState`, and the row itself is swept — at the
 *  next mint and at open — so the table holds only states a door could still answer. */
Deno.test("expired OAuth states are pruned at the next mint, and at open", async () => {
  const dir = await Deno.makeTempDir();
  let skew = 0;
  const count = (state: string) => {
    const db = new DatabaseSync(`${dir}/log/log.db`);
    try {
      const r = db.prepare("SELECT count(*) AS n FROM oauth_states WHERE state = ?").get(state);
      return Number((r as { n: number }).n);
    } finally {
      db.close();
    }
  };
  try {
    const creds = await openCredentials(dir, { now: () => Date.now() + skew });
    const aged = await creds.mintState("slack");
    const spent = await creds.mintState("slack");
    await creds.consumeState("slack", spent);
    assertEquals(count(aged), 1);
    skew = 10 * 60_000 + 1;
    const fresh = await creds.mintState("slack"); // the prune point
    assertEquals(count(aged), 0);
    assertEquals(count(spent), 0); // a consumed state is swept with the rest
    assertEquals(count(fresh), 1);
    await creds.close();

    skew = 2 * (10 * 60_000 + 1);
    const reopened = await openCredentials(dir, { now: () => Date.now() + skew });
    assertEquals(count(fresh), 0); // open is a prune point too
    await reopened.close();
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
