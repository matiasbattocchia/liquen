import { assertEquals, assertRejects } from "@std/assert";
import { endTelegram } from "./end.ts";
import { PortDown } from "./port.ts";
import type { CredentialRow } from "../../store/credentials.ts";

const ROW = { service: "telegram", address: "700100", credentialKey: "telegram:700100" };
const VAULT: Record<string, CredentialRow> = {
  "telegram:700100": { key: "telegram:700100", value: { session: "1AQAAA-session" } },
  "telegram:app": { key: "telegram:app", value: { api_id: "123", api_hash: "abc" } },
};
const creds = (vault = VAULT) => ({ get: (key: string) => Promise.resolve(vault[key] ?? null) });

async function withRoot(fn: (root: string) => Promise<void>) {
  const root = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${root}/data/telegram`, { recursive: true });
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("telegram end: the running process ends the session it holds", async () => {
  await withRoot(async (root) => {
    const asked: unknown[] = [];
    const loggedOut: unknown[] = [];
    const said = await endTelegram(ROW, {
      root,
      creds: creds(),
      call: (leg, body) => {
        asked.push([leg, body]);
        return Promise.resolve({ ended: true });
      },
      logOut: (o) => {
        loggedOut.push(o);
        return Promise.resolve();
      },
    });
    assertEquals(asked, [["accounts/end", { connection: "700100" }]]);
    assertEquals(loggedOut, []);
    assertEquals(said, "its session on Telegram is ended: the account's devices no longer list it");
  });
});

Deno.test("telegram end: with no process, or none holding it, the removal logs out and forgets the cache", async () => {
  for (
    const call of [() => Promise.reject(new PortDown()), () => Promise.resolve({ ended: false })]
  ) {
    await withRoot(async (root) => {
      await Deno.writeTextFile(`${root}/data/telegram/700100.session`, "cache");
      await Deno.writeTextFile(`${root}/data/telegram/700100.history`, "2026-11-14");
      const loggedOut: unknown[] = [];
      await endTelegram(ROW, {
        root,
        creds: creds(),
        call,
        logOut: (o) => {
          loggedOut.push(o);
          return Promise.resolve();
        },
      });
      assertEquals(loggedOut, [{ apiId: 123, apiHash: "abc", session: "1AQAAA-session" }]);
      const left = [...Deno.readDirSync(`${root}/data/telegram`)].map((e) => e.name);
      assertEquals(left, []);
    });
  }
});

Deno.test("telegram end: nothing in the vault to end with, or a socket that refused, is a failure", async () => {
  await withRoot(async (root) => {
    await assertRejects(
      () =>
        endTelegram(ROW, {
          root,
          creds: creds({}),
          call: () => Promise.reject(new PortDown()),
        }),
      Error,
      "no session or application",
    );
    await assertRejects(
      () =>
        endTelegram(ROW, {
          root,
          creds: creds(),
          call: () => Promise.reject(new Error("HTTP 500")),
        }),
      Error,
      "HTTP 500",
    );
  });
});
