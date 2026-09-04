import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { openCredentials } from "./credentials.ts";

/** An OAuth state is one-shot and short-lived: consumed once, and only within its TTL.
 *  The TTL is compared against the store's clock (§9), so the test ages it by moving the
 *  clock — never by waiting the ten minutes out. */
Deno.test("an OAuth state is consumed once, and not at all past its TTL", async () => {
  const dir = await Deno.makeTempDir();
  let skew = 0;
  const creds = await openCredentials(dir, { now: () => Date.now() + skew });
  try {
    const fresh = await creds.mintState("slack", { agentId: "ana" });
    assertEquals(await creds.consumeState("google", fresh), null); // another service's door
    assertEquals(await creds.consumeState("slack", fresh), { agentId: "ana" });
    assertEquals(await creds.consumeState("slack", fresh), null); // spent

    const aged = await creds.mintState("slack");
    skew = 10 * 60_000 + 1; // a TTL and a millisecond later…
    assertEquals(await creds.consumeState("slack", aged), null); // …the door is closed
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
});

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

/** The merge is FIELD-WISE: a top-level field lands whole, replacing what was under it —
 *  a door that rewrites a map (the calendar's cursors) drops a key by leaving it out. */
Deno.test("put merges by top-level field: a nested object is replaced whole, not merged", async () => {
  const dir = await Deno.makeTempDir();
  const creds = await openCredentials(dir);
  try {
    await creds.put({
      key: "google:ana",
      value: { refresh_token: "r1" },
      extra: { expiry: "t1", calendar_sync: { primary: "tok1", team: "tok2" } },
    });
    await creds.put({ key: "google:ana", value: {}, extra: { calendar_sync: { team: "tok3" } } });
    await creds.put({ key: "google:ana", value: { access_token: "a1" }, extra: { expiry: "t2" } });
    assertEquals(await creds.get("google:ana"), {
      key: "google:ana",
      value: { refresh_token: "r1", access_token: "a1" },
      extra: { expiry: "t2", calendar_sync: { team: "tok3" } },
    });
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
});
