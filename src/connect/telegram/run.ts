/**
 * run.ts — the telegram connection as ONE process: every account's session, the ingest
 * and the dispatch over them, and the socket main's ports cross. `liquen start` spawns
 * this for `connections.telegram`.
 *
 * The process is the only holder of each session, which is what lets the ports and the
 * dispatcher share the connection the ingest listens on. The accounts it holds follow the
 * store while it runs (`accounts.ts`): at boot, when a door's grant note lands in the log,
 * and every `RECONCILE_MS`, so a sign-in, a new sign-in of an account and a removal each
 * touch that one account and leave the others' sessions as they are. A removal asks over
 * the socket for the account's session to be ended on Telegram. An account Telegram
 * signed out is said on its row and left. SIGTERM stops the way main stops: no new work,
 * what is in flight settled, the sessions closed with their cursors kept.
 *
 * An opening that follows a sign-in imports the account's history: every chat's last
 * `historyDays`, stamped `backfill`, behind the live session. The sign-in is the door's
 * grant note, and the note whose history is in sits beside the cache (`historyPath`), so a
 * restart resumes and a new sign-in imports again.
 *
 * Every line is published through the room marks (`connect/marks.ts`).
 *
 * The body runs under `entry` (§9): a boot that cannot go on is a refusal in a sentence.
 */

import { findRoot, orgFlag } from "../../config.ts";
import { entry } from "../../entry.ts";
import type { Reader } from "../../store/log.ts";
import { heartbeat, setState } from "../health.ts";
import { createMarks, marked } from "../marks.ts";
import { logDirectory } from "../mentions.ts";
import { exitOnStop } from "../stop.ts";
import { createAccounts, type Opened, RECONCILE_MS } from "./accounts.ts";
import { createBios } from "./bio.ts";
import { logOutSession, openTelegram } from "./client.ts";
import { APP_KEY, cachePath, GRANT_SENDER, historyPath, telegramConfig } from "./config.ts";
import { createTelegramDispatch } from "./dispatch.ts";
import { createTelegramIngest } from "./ingest.ts";
import { servePort } from "./port.ts";
import { SERVICE, type TgEvent } from "./wire.ts";

const DAY_MS = 24 * 60 * 60_000;

/** When the account was last signed in: its newest grant note's time. */
export async function signedInAt(
  read: Reader["read"],
  account: string,
): Promise<string | undefined> {
  const [note] = await read({
    service: SERVICE,
    connection: account,
    conversation: "connect",
    senders: [GRANT_SENDER],
    limit: 1,
  });
  return note?.ts;
}

/** The sign-in an opening owes its history to: the newest one, unless its history is
 *  already in. */
export async function owedHistory(
  read: Reader["read"],
  account: string,
  marker: string,
): Promise<string | undefined> {
  const signed = await signedInAt(read, account);
  if (!signed) return undefined;
  const done = await Deno.readTextFile(marker).then((s) => s.trim(), () => "");
  return done === signed ? undefined : signed;
}

/** Bring the connection up: resident once it returns. Returns stop. */
export async function runTelegram(): Promise<() => Promise<void>> {
  const { openStore } = await import("../../store/mod.ts");
  const root = findRoot(orgFlag());
  const store = await openStore(root);
  const log = await store.log();
  const creds = await store.vault();
  const storage = store.storage();
  const { bios, historyDays, crowd, busy, follow } = await telegramConfig(root);
  const read: Reader["read"] = (q) => log.read(q);
  const publish = marked(log.publish, createMarks({ read, knobs: { crowd, busy, follow } }));

  const app = await creds.get(APP_KEY);
  if (!app?.value.api_id || !app.value.api_hash) {
    throw new Error(
      "no Telegram application in the vault: `liquen connect telegram app` stores its api " +
        "id and hash",
    );
  }
  const apiId = Number(app.value.api_id);
  const apiHash = app.value.api_hash;
  await Deno.mkdir(`${root}/data/telegram`, { recursive: true, mode: 0o700 });

  const said = (account: string, what: string, err: unknown) =>
    console.error(`[telegram ${account}] ${what} FAILED:`, err);

  /** One account's session with its ingest over it. */
  const open = async (account: string, session: string): Promise<Opened> => {
    const fail = (what: string, err: unknown) => said(account, what, err);
    // events arrive before the ingest exists (the opening's own state line): they wait
    const route: { handle?: (event: TgEvent) => Promise<void> } = {};
    let chain: Promise<void> = Promise.resolve();
    const early: TgEvent[] = [];
    const opened = await openTelegram({
      apiId,
      apiHash,
      session,
      cache: cachePath(root, account),
      onError: fail,
      onEvent: (event) => {
        const take = route.handle;
        if (!take) return void early.push(event);
        chain = chain.then(() => take(event)).catch((err) => fail("an event", err));
      },
    });
    const reader = bios
      ? createBios({ about: opened.wire.about, onError: (u, e) => fail(`reading ${u}`, e) })
      : undefined;
    const marker = historyPath(root, account);
    const signedIn = await owedHistory(read, account, marker).catch((err) => {
      fail("reading the sign-in", err);
      return undefined;
    });
    const ingest = createTelegramIngest({
      wire: opened.wire,
      publish,
      read,
      store: log,
      storage,
      ...(reader ? { bios: reader } : {}),
      ...(signedIn ? { signedIn } : {}),
      onError: fail,
    });
    route.handle = ingest.handle;
    for (const event of early) chain = chain.then(() => ingest.handle(event));
    // the history runs behind the live session, and is in once every chat went through
    const imported = signedIn && historyDays > 0
      ? ingest.backfill(new Date(Date.parse(signedIn) - historyDays * DAY_MS).toISOString())
        .then(async (whole) => {
          if (whole) await Deno.writeTextFile(marker, signedIn);
        })
        .catch((err) => fail("importing the history", err))
      : signedIn
      ? Deno.writeTextFile(marker, signedIn).catch((err) => fail("marking the history", err))
      : Promise.resolve();
    const closing = async (close: () => Promise<void>) => {
      ingest.stop();
      reader?.stop();
      await close();
      await imported;
      await chain.catch(() => {});
    };
    return {
      wire: opened.wire,
      stop: () => closing(opened.stop),
      logOut: () => closing(opened.logOut),
    };
  };

  const accounts = createAccounts({
    rows: () => log.connections(),
    removed: async (account) => {
      const row = await log.connection(SERVICE, account);
      return row?.deletedAt ? row : undefined;
    },
    forget: async (account) => {
      for (const path of [cachePath(root, account), historyPath(root, account)]) {
        await Deno.remove(path).catch((err) => {
          if (!(err instanceof Deno.errors.NotFound)) throw err;
        });
      }
    },
    session: async (key) => (await creds.get(key))?.value.session,
    open: (row, session) => open(row.address, session),
    logOut: (session) => logOutSession({ apiId, apiHash, session }),
    signedOut: async (row, error) => {
      console.error(`[telegram ${row.address}] ${error}`);
      await setState(log, row, "signed_out", { error });
    },
    onError: said,
    onOpened: (account, wire) =>
      console.error(`[telegram ${account}] listening as ${wire.self.name ?? account}`),
  });
  await accounts.reconcile();
  const round = () => accounts.reconcile().catch((err) => said("*", "reconciling", err));
  // a door's grant note is the moment an account is signed in
  const unsubscribe = log.subscribe(() => void round(), {
    filter: (e) => e.envelope.service === SERVICE && e.envelope.sender?.address === GRANT_SENDER,
  });
  const ticks = setInterval(() => void round(), RECONCILE_MS);

  const stopDispatch = createTelegramDispatch({
    subscribe: (l, o) => log.subscribe(l, o),
    read: (q) => log.read(q),
    publish: log.publish,
    wireOf: accounts.wireOf,
    storage,
    directory: logDirectory((q) => log.read(q)),
    setDelivery: (id, patch) => log.setDelivery(id, patch),
    store: log,
    onSent: (e, id) =>
      console.error(`[dispatch] sent → ${e.envelope.conversation.address} (${id})`),
    onError: (e, err) =>
      console.error(`[dispatch] FAILED → ${e.envelope.conversation.address}:`, err),
  });
  const stopPort = await servePort(`${root}/data`, accounts.wireOf, accounts.end);

  return async () => {
    clearInterval(ticks);
    unsubscribe();
    await stopPort();
    await stopDispatch();
    await accounts.stop();
    await creds.close();
    await log.close();
  };
}

if (import.meta.main) {
  await entry(async () => exitOnStop([await runTelegram(), await heartbeat(SERVICE)]));
}
