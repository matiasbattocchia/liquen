import { assertEquals } from "@std/assert";
import { createAccounts, type Opened } from "./accounts.ts";
import { fakeWire } from "./testing.ts";
import { SignedOut } from "../errors.ts";
import type { ConnectionRow } from "../../store/connections.ts";

/** A store and a Telegram the test moves: rows, the vault's sessions, and every open,
 *  close and log out recorded in order. */
function world() {
  const rows: ConnectionRow[] = [];
  const vault = new Map<string, string>();
  const said: string[] = [];
  const downs: { account: string; error: string }[] = [];
  const refuse = new Set<string>();
  const accounts = createAccounts({
    rows: () => Promise.resolve([...rows]),
    session: (key) => Promise.resolve(vault.get(key)),
    open: (row, session): Promise<Opened> => {
      if (refuse.has(session)) return Promise.reject(new SignedOut("SESSION_REVOKED"));
      said.push(`open ${row.address} ${session}`);
      return Promise.resolve({
        wire: { ...fakeWire(), self: { id: row.address, kind: "user" } },
        stop: () => {
          said.push(`close ${row.address} ${session}`);
          return Promise.resolve();
        },
      });
    },
    logOut: (session) => {
      said.push(`log out ${session}`);
      return Promise.resolve();
    },
    signedOut: (row, error) => {
      downs.push({ account: row.address, error });
      return Promise.resolve();
    },
  });
  const link = (address: string, session: string) => {
    if (!rows.some((r) => r.address === address)) {
      rows.push({ service: "telegram", address, credentialKey: `telegram:${address}` });
    }
    vault.set(`telegram:${address}`, session);
  };
  const unlink = (address: string) => {
    rows.splice(rows.findIndex((r) => r.address === address), 1);
    vault.delete(`telegram:${address}`);
  };
  return { accounts, link, unlink, said, downs, refuse, vault };
}

Deno.test("telegram accounts: a sign-in opens that account alone, the others left as they are", async () => {
  const w = world();
  w.link("1", "s1");
  await w.accounts.reconcile();
  w.link("2", "s2");
  await w.accounts.reconcile();
  assertEquals(w.said, ["open 1 s1", "open 2 s2"]);
  assertEquals(w.accounts.wireOf("2")?.self.id, "2");
  // nothing moved: nothing happens
  await w.accounts.reconcile();
  assertEquals(w.said.length, 2);
});

Deno.test("telegram accounts: a new sign-in of an account swaps its session and ends the old one", async () => {
  const w = world();
  w.link("1", "s1");
  w.link("2", "s2");
  await w.accounts.reconcile();
  w.link("1", "s1b");
  await w.accounts.reconcile();
  assertEquals(w.said, ["open 1 s1", "open 2 s2", "close 1 s1", "log out s1", "open 1 s1b"]);
});

Deno.test("telegram accounts: a removed account closes, and its session stays on Telegram", async () => {
  const w = world();
  w.link("1", "s1");
  w.link("2", "s2");
  await w.accounts.reconcile();
  w.unlink("2");
  await w.accounts.reconcile();
  assertEquals(w.said, ["open 1 s1", "open 2 s2", "close 2 s2"]);
  assertEquals(w.accounts.wireOf("2"), undefined);
});

Deno.test("telegram accounts: a session Telegram refused is said down once, and tried again only when signed in anew", async () => {
  const w = world();
  w.refuse.add("s1");
  w.link("1", "s1");
  await w.accounts.reconcile();
  await w.accounts.reconcile();
  assertEquals(w.downs, [{ account: "1", error: "SESSION_REVOKED" }]);
  assertEquals(w.said, []);
  w.link("1", "s1b");
  await w.accounts.reconcile();
  assertEquals(w.said, ["open 1 s1b"]);
});

Deno.test("telegram accounts: a row with no session in the vault is said down, and its open session closes", async () => {
  const w = world();
  w.link("1", "s1");
  await w.accounts.reconcile();
  w.vault.delete("telegram:1");
  await w.accounts.reconcile();
  assertEquals(w.said, ["open 1 s1", "close 1 s1"]);
  assertEquals(w.downs, [{ account: "1", error: "no session in the vault: sign in again" }]);
});

Deno.test("telegram accounts: reconciles asked at once run one after the other, and stop closes all", async () => {
  const w = world();
  w.link("1", "s1");
  await Promise.all([w.accounts.reconcile(), w.accounts.reconcile(), w.accounts.reconcile()]);
  assertEquals(w.said, ["open 1 s1"]);
  await w.accounts.stop();
  assertEquals(w.said, ["open 1 s1", "close 1 s1"]);
  w.link("2", "s2");
  await w.accounts.reconcile();
  assertEquals(w.said.length, 2);
});
