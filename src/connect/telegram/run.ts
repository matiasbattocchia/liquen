/**
 * run.ts — the telegram connection as ONE process: every account's session, the ingest
 * and the dispatch over them, and the socket main's ports cross. `liquen start` spawns
 * this for `connections.telegram`.
 *
 * The process is the only holder of each session, which is what lets the ports and the
 * dispatcher share the connection the ingest listens on. An account Telegram signed out
 * is said on its row and left; the others run. SIGTERM stops the way main stops: no new
 * work, what is in flight settled, the sessions closed with their cursors kept.
 *
 * The body runs under `entry` (§9): a boot that cannot go on is a refusal in a sentence.
 */

import { findRoot, orgFlag } from "../../config.ts";
import { entry } from "../../entry.ts";
import { SignedOut } from "../errors.ts";
import { heartbeat, setState } from "../health.ts";
import { logDirectory } from "../mentions.ts";
import { exitOnStop } from "../stop.ts";
import { createBios } from "./bio.ts";
import { openTelegram } from "./client.ts";
import { APP_KEY, cachePath, sessionKey, telegramConfig } from "./config.ts";
import { createTelegramDispatch } from "./dispatch.ts";
import { createTelegramIngest } from "./ingest.ts";
import { servePort } from "./port.ts";
import { SERVICE, type TgEvent, type TgWire } from "./wire.ts";

/** Bring the connection up: resident once it returns. Returns stop. */
export async function runTelegram(): Promise<() => Promise<void>> {
  const { openStore } = await import("../../store/mod.ts");
  const root = findRoot(orgFlag());
  const store = await openStore(root);
  const log = await store.log();
  const creds = await store.vault();
  const storage = store.storage();
  const { bios } = await telegramConfig(root);

  const app = await creds.get(APP_KEY);
  if (!app?.value.api_id || !app.value.api_hash) {
    throw new Error(
      "no Telegram application in the vault: `liquen connect telegram app` stores its api " +
        "id and hash",
    );
  }
  await Deno.mkdir(`${root}/data/telegram`, { recursive: true, mode: 0o700 });

  const wires = new Map<string, TgWire>();
  const stops: (() => Promise<void> | void)[] = [];
  const accounts = (await log.connections()).filter((r) => r.service === SERVICE);
  for (const row of accounts) {
    const account = row.address;
    const said = (what: string, err: unknown) =>
      console.error(`[telegram ${account}] ${what} FAILED:`, err);
    const held = await creds.get(row.credentialKey ?? sessionKey(account));
    if (!held?.value.session) {
      console.error(`[telegram ${account}] no session in the vault: sign in again`);
      await setState(log, row, "signed_out", { error: "no session in the vault" });
      continue;
    }
    // events arrive before the ingest exists (the opening's own state line): they wait
    let handle: ((event: TgEvent) => Promise<void>) | undefined;
    let chain: Promise<void> = Promise.resolve();
    const early: TgEvent[] = [];
    try {
      const session = await openTelegram({
        apiId: Number(app.value.api_id),
        apiHash: app.value.api_hash,
        session: held.value.session,
        cache: cachePath(root, account),
        onError: said,
        onEvent: (event) => {
          if (!handle) return void early.push(event);
          const take = handle;
          chain = chain.then(() => take(event)).catch((err) => said("an event", err));
        },
      });
      const reader = bios
        ? createBios({ about: session.wire.about, onError: (u, e) => said(`reading ${u}`, e) })
        : undefined;
      const ingest = createTelegramIngest({
        wire: session.wire,
        publish: log.publish,
        read: (q) => log.read(q),
        store: log,
        storage,
        ...(reader ? { bios: reader } : {}),
        onError: said,
      });
      handle = ingest.handle;
      for (const event of early) chain = chain.then(() => ingest.handle(event));
      wires.set(account, session.wire);
      stops.push(async () => {
        ingest.stop();
        reader?.stop();
        await session.stop();
        await chain.catch(() => {});
      });
      console.error(
        `[telegram ${account}] listening as ${session.wire.self.name ?? account}`,
      );
    } catch (err) {
      if (!(err instanceof SignedOut)) throw err;
      console.error(`[telegram ${account}] ${err.message}`);
      await setState(log, row, "signed_out", { error: err.message });
    }
  }
  if (accounts.length === 0) {
    console.error("[telegram] no account is linked: `liquen connect telegram` signs one in");
  }

  const stopDispatch = createTelegramDispatch({
    subscribe: (l, o) => log.subscribe(l, o),
    read: (q) => log.read(q),
    wireOf: (c) => wires.get(c),
    storage,
    directory: logDirectory((q) => log.read(q)),
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    store: log,
    onSent: (e, id) =>
      console.error(`[dispatch] sent → ${e.envelope.conversation.address} (${id})`),
    onError: (e, err) =>
      console.error(`[dispatch] FAILED → ${e.envelope.conversation.address}:`, err),
  });
  const stopPort = await servePort(`${root}/data`, (c) => wires.get(c));

  return async () => {
    await stopPort();
    await stopDispatch();
    for (const stop of stops) await stop();
    await creds.close();
    await log.close();
  };
}

if (import.meta.main) {
  await entry(async () => exitOnStop([await runTelegram(), await heartbeat(SERVICE)]));
}
