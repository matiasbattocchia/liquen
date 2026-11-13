/**
 * connect/telegram/connect.ts — `liquen connect telegram`: the sign-in door (§4).
 *
 * Two doors. `app` stores the application Telegram issued at my.telegram.org, its api id
 * and hash, under `telegram:app`: every session of the org signs in as that application.
 * The other signs an ACCOUNT in, on a session of its own: a QR code to scan from the
 * phone, or with `--phone` the code Telegram sends that number, and the two-step password
 * when the account has one.
 *
 *   signed in → the vault: `telegram:<user id>`, the session string
 *             → connections: ONE row at the account's user id, the anchor every event
 *               carries. Owned by the member whose account it is, with their chat with
 *               themselves (Saved Messages) as `mirrors.self`; or the org's, owned by
 *               nobody and spoken through by its agents
 *             → membership: the `connect` conversation, so the note reaches the owner
 *             → the log: the grant crosses the frontier as an event (§4)
 *
 * The session the door makes is a new one, so its cache starts empty: the file a former
 * session of the account left is removed, and the connection's process restarts onto the
 * new credential. Telegram holds what an account missed for a session that exists, so
 * nothing is lost between the sign-in and the restart.
 */

import { helpFlag } from "../help.ts";
import type { Appender } from "../../store/log.ts";
import type { Connections } from "../../store/connections.ts";
import type { Credentials } from "../../store/credentials.ts";
import type { Draft, MessageEvent } from "../../types.ts";
import { findRoot, orgFlag } from "../../config.ts";
import { readConfig } from "../../org.ts";
import { entry } from "../../entry.ts";
import { declared } from "../declare.ts";
import { terminalUser } from "../door.ts";
import { linked } from "../health.ts";
import { APP_KEY, cachePath, sessionKey, SPEC } from "./config.ts";
import { SERVICE, type TgPeer } from "./wire.ts";

export interface TelegramApp {
  apiId: string;
  apiHash: string;
}

/** Store the application's credentials. */
export async function connectTelegramApp(
  app: TelegramApp,
  creds: Pick<Credentials, "put">,
): Promise<void> {
  if (!/^\d+$/.test(app.apiId) || !app.apiHash) {
    throw new Error("an api id (digits) and its api hash, both from my.telegram.org");
  }
  await creds.put({ key: APP_KEY, value: { api_id: app.apiId, api_hash: app.apiHash } });
}

export interface TelegramConnectDeps {
  /** The sign-in itself: the session string and who the account is. */
  signIn: () => Promise<{ session: string; self: TgPeer }>;
  /** The member whose account this is. Absent: the org's own account. */
  principal?: string;
  creds: Pick<Credentials, "put">;
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  publish: Appender["publish"];
  /** Remove the cache a former session of the account left. */
  dropCache?: (account: string) => Promise<void>;
  now?: () => string;
}

/** Sign one account in and write the map. Throws, writing nothing, when the sign-in
 *  does. */
export async function connectTelegram(deps: TelegramConnectDeps): Promise<{ account: TgPeer }> {
  const now = deps.now ?? (() => new Date().toISOString());
  const { session, self } = await deps.signIn();
  const address = self.id;
  const key = sessionKey(address);

  await deps.dropCache?.(address);
  await deps.creds.put({
    key,
    value: { session },
    ...(deps.principal ? { agentId: deps.principal } : {}),
  });
  await deps.store.upsertConnections([{
    service: SERVICE,
    address,
    credentialKey: key,
    ...(deps.principal ? { agentId: deps.principal } : {}),
    extra: {
      ...linked(now()),
      ...(self.name ? { name: self.name } : {}),
      ...(self.username ? { username: self.username } : {}),
      // an owned account's chat with itself is a face of its owner's mind (§4)
      ...(deps.principal ? { mirrors: { self: address } } : {}),
    },
  }]);
  if (deps.principal) {
    await deps.store.upsertMemberships([
      { service: SERVICE, connection: address, conversation: "connect", agentId: deps.principal },
    ]);
  }
  const who = self.username ? `@${self.username}` : self.name ?? address;
  const note: Draft<MessageEvent> = {
    ts: now(),
    type: "message",
    envelope: {
      service: SERVICE,
      connection_address: address,
      conversation: { address: "connect" },
      sender: { address: "telegram-connect" },
    },
    parts: [{
      type: "text",
      kind: "text",
      text: `Telegram connected: ${who} (${address}) → ${deps.principal ?? "the org"}`,
    }],
  };
  await deps.publish(note);
  return { account: self };
}

const USAGE = `usage: liquen connect telegram app
       liquen connect telegram [agent] [--phone <number>]
       liquen connect telegram --org [--phone <number>]

  Sign a Telegram account in over MTProto; knobs: connections.telegram.

  app               store the application's api id and api hash (my.telegram.org →
                    API development tools); once per org, before any account
  [agent]           the roster member whose account this is (default: your OS username)
  --org             the org's own account: owned by nobody, spoken through by its agents
  --phone <number>  the code flow for that number (international, with or without +);
                    without it, a QR code to scan from the phone
  --dir <org>       the org, when run from elsewhere`;

if (import.meta.main) {
  await entry(async () => {
    const { openStore } = await import("../../store/mod.ts");
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const root = findRoot(org);
    const store = await openStore(root);
    const flags = new Map<string, string>();
    const positional: string[] = [];
    let orgOwned = false;
    for (let i = 0; i < org.args.length; i++) {
      if (org.args[i] === "--org") orgOwned = true;
      else if (org.args[i].startsWith("--")) flags.set(org.args[i].slice(2), org.args[++i] ?? "");
      else positional.push(org.args[i]);
    }
    /** TTY: a prompt; piped stdin: consumed line by line. */
    const lines = Deno.stdin.isTerminal()
      ? null
      : (await new Response(Deno.stdin.readable).text()).split("\n").map((l) => l.trim());
    const ask = (label: string): string => (lines ? lines.shift() : prompt(label)?.trim()) ?? "";

    const creds = await store.vault();
    try {
      if (positional[0] === "app") {
        console.error(
          "The application is made once at https://my.telegram.org → API development tools.\n",
        );
        await connectTelegramApp(
          { apiId: ask("api_id:"), apiHash: ask("api_hash:") },
          creds,
        );
        console.error(`✓ application stored: ${APP_KEY}`);
        // a process that refused for want of the application gets another go
        await declared(root, SPEC, {}, [SPEC.name]);
        return;
      }

      if (orgOwned && positional.length > 0) {
        throw new Error("--org signs in the org's own account: no agent to name");
      }
      const principal = orgOwned ? undefined : positional[0] ?? terminalUser();
      if (principal) {
        const member = (await readConfig(root)).agents[principal];
        if (!member) {
          throw new Error(
            `no agent "${principal}" in ${root}: \`liquen agent ${principal}\` makes one`,
          );
        }
      }
      const app = await creds.get(APP_KEY);
      if (!app?.value.api_id || !app.value.api_hash) {
        throw new Error(
          "no Telegram application in the vault yet: `liquen connect telegram app` first",
        );
      }
      const phone = flags.get("phone") || undefined;
      if (flags.has("phone") && !phone) throw new Error("--phone needs the number");

      const { signIn } = await import("./client.ts");
      const qrcode = (await import("qrcode-terminal")).default;
      console.error(
        `Connecting Telegram as ${principal ? `agent "${principal}"` : "the org"}: ` +
          `${phone ? `a code sent to ${phone}` : "QR"}.\n`,
      );
      const log = await store.log();
      try {
        const { account } = await connectTelegram({
          principal,
          creds,
          store: log,
          publish: log.publish,
          dropCache: async (id) => {
            for (const tail of ["", "-wal", "-shm", "-journal"]) {
              await Deno.remove(cachePath(root, id) + tail).catch(() => {});
            }
          },
          signIn: () =>
            signIn({
              apiId: Number(app.value.api_id),
              apiHash: app.value.api_hash,
              ...(phone ? { phone } : {}),
              code: () => Promise.resolve(ask("The code Telegram sent:")),
              password: () => Promise.resolve(ask("Two-step verification password:")),
              onQr: (url) => {
                console.error(
                  "Scan with the phone: Telegram → Settings → Devices → Link Desktop Device\n",
                );
                qrcode.generate(url, { small: true }, (q: string) => console.error(q));
              },
            }),
        });
        console.error(
          `\n✓ signed in: ${account.name ?? account.id} (${account.id}) → ${
            principal ?? "the org"
          }`,
        );
      } finally {
        await log.close();
      }
      // the process reads its sessions once, at boot
      await declared(root, SPEC, {}, [SPEC.name]);
      console.error(
        "  (deno task status shows the map; the session shows under Telegram → Settings → " +
          "Devices, where it is ended)",
      );
    } finally {
      await creds.close();
    }
  });
}
