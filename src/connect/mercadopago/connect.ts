/**
 * src/connect/mercadopago/connect.ts — `liquen connect mercadopago`: an account's access
 * token, and its application's webhook secret.
 *
 * The token is an application's production Access Token (`APP_USR-…`, its Credentials
 * page), checked with `GET /users/me` before anything is written: the user id it answers
 * with is the account's address. One vault row, `mercadopago:<user_id>`, holds the token
 * and the webhook secret, and carries the proxy declaration (§9) — `MP_ACCESS_TOKEN`
 * toward `api.mercadopago.com` — so an agent's `mpcli` works with no real credential in
 * user space. One connection row maps the account to its principal (or to the org), and a
 * note crosses into the log.
 *
 * The webhook is the application's, set in its panel (Webhooks → Configure notifications,
 * the production URL, the Payments event), which hands back the secret the door asks for.
 * It is optional: the poll alone reads every payment, a minute late.
 *
 * Arg: the principal (default: the OS username), or `--org`. Env: none.
 */

import { helpFlag } from "../help.ts";
import {
  type Appender,
  type Connections,
  type Credentials,
  type Draft,
  findRoot,
  ingestAddress,
  linked,
  type MessageEvent,
  orgFlag,
  reachLine,
  readConfig,
  requireIngest,
} from "../../connector.ts";
import { SPEC } from "./config.ts";
import { GRANT_ENV, GRANT_HOSTS, GRANT_PREFIX, SERVICE } from "./payments.ts";
import { contention } from "../token/connect.ts";
import { entry } from "../../entry.ts";

export interface Account {
  id: string;
  nickname?: string;
}

export interface MercadopagoDoorDeps {
  /** The roster name the grant belongs to; absent ⇒ the org's, ownerless. */
  principal?: string;
  creds: Pick<Credentials, "put" | "list">;
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  publish: Appender["publish"];
  /** `GET /users/me` with the pasted token — injectable; default hits the API. */
  whoami?: (
    token: string,
  ) => Promise<{ id?: number | string; nickname?: string; message?: string }>;
  now?: () => string;
}

/** Verify the token, write the grant and the map, notify the log. Throws, writing nothing,
 *  when Mercado Pago refuses the token. Returns the account and what `frontedFor` will make
 *  of the grant (`contention`). */
export async function connectMercadopago(
  token: string,
  webhookSecret: string | undefined,
  deps: MercadopagoDoorDeps,
): Promise<{ account: Account; contention?: string }> {
  const now = deps.now ?? (() => new Date().toISOString());
  token = token.trim();
  if (!token) throw new Error("an empty token — nothing written");
  const me = await (deps.whoami ?? defaultWhoami)(token);
  if (me.id === undefined) throw new Error(`GET /users/me: ${me.message ?? "no user id"}`);
  const account: Account = { id: String(me.id), ...(me.nickname ? { nickname: me.nickname } : {}) };

  const key = `${GRANT_PREFIX}${account.id}`;
  const row = {
    key,
    value: { token, ...(webhookSecret ? { webhook_secret: webhookSecret } : {}) },
    ...(deps.principal ? { agentId: deps.principal } : {}),
    extra: { env: GRANT_ENV, hosts: GRANT_HOSTS },
  };
  await deps.creds.put(row);
  await deps.store.upsertConnections([{
    service: SERVICE,
    address: account.id,
    ...(deps.principal ? { agentId: deps.principal } : {}),
    credentialKey: key,
    extra: linked(now()),
  }]);
  if (deps.principal) {
    // the grant note is the principal's to see (§6)
    await deps.store.upsertMemberships([
      {
        service: SERVICE,
        connection: account.id,
        conversation: "connect",
        agentId: deps.principal,
      },
    ]);
  }

  // cross the frontier the only legal way: an event (§4)
  const note: Draft<MessageEvent> = {
    ts: now(),
    type: "message",
    envelope: {
      service: SERVICE,
      connection_address: account.id,
      conversation: { address: "connect" },
      sender: { address: "mercadopago-connect" },
    },
    parts: [{
      type: "text",
      kind: "text",
      text: `Mercado Pago connected: ${account.nickname ?? account.id} (user ${account.id}) → ` +
        `${deps.principal ?? "the org"}` +
        (webhookSecret ? "" : " — no webhook secret: payments arrive by the poll alone"),
    }],
  };
  await deps.publish(note);
  const said = contention(await deps.creds.list(""), row);
  return { account, ...(said ? { contention: said } : {}) };
}

async function defaultWhoami(
  token: string,
): Promise<{ id?: number | string; nickname?: string; message?: string }> {
  const res = await fetch("https://api.mercadopago.com/users/me", {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30_000),
  });
  return await res.json();
}

const USAGE = `usage: liquen connect mercadopago [agent] [--org]

  An account's production Access Token (APP_USR-…, from its application's Credentials at
  https://www.mercadopago.com.ar/developers/panel/app), and optionally the application's
  webhook secret. Answers are pasted at a prompt, or piped one per line for a secret
  manager. Payments land one conversation per counterparty, by the webhook as they happen
  and by a poll a minute later either way; an agent's \`mpcli\` reads MP_ACCESS_TOKEN.

  [agent]       whose account it is (default: your OS username)
  --org         file the grant as the org's, ownerless, rather than an agent's
  --dir <org>   the org, when run from elsewhere

  Knobs: none.`;

if (import.meta.main) {
  await entry(async () => {
    const { openStore } = await import("../../connector.ts");
    const { userInfo } = await import("node:os");

    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const root = findRoot(org);
    const flags = new Set(org.args.filter((a) => a.startsWith("--")));
    const unknown = [...flags].filter((f) => f !== "--org");
    if (unknown.length) throw new Error(`unknown flag ${unknown[0]}\n${USAGE}`);
    const [named] = org.args.filter((a) => !a.startsWith("--"));
    const principal = flags.has("--org") ? undefined : named ?? (() => {
      try {
        return userInfo().username;
      } catch {
        return "principal";
      }
    })();
    if (principal) {
      const known = Object.keys((await readConfig(root)).agents);
      if (!known.includes(principal)) {
        throw new Error(
          `no agent "${principal}" on the roster — have: ${known.join(" · ") || "(none)"}`,
        );
      }
    }
    // the webhook delivers from the moment it is configured, so the ingest comes up first
    await requireIngest(root, SPEC);

    console.error(
      principal
        ? `Connecting Mercado Pago as agent "${principal}".\n`
        : "Connecting Mercado Pago as the org — ownerless, every agent's fallback.\n",
    );

    /** TTY: interactive prompt; piped stdin: consumed line by line (secret managers). */
    const lines = Deno.stdin.isTerminal()
      ? null
      : (await new Response(Deno.stdin.readable).text()).split("\n").map((l) => l.trim());
    const ask = (label: string): string | undefined =>
      (lines ? lines.shift() : prompt(label)?.trim()) || undefined;

    const token = ask("Access token (APP_USR-…):");
    if (!token) {
      console.error("nothing pasted — nothing written");
      Deno.exit(2);
    }

    const { edge } = await readConfig(root);
    if (edge.publicUrl === null) {
      console.error(
        "\nThis org has no public door (edge.publicUrl), so Mercado Pago cannot deliver to " +
          "it: payments arrive by the poll alone.\n",
      );
    } else {
      const webhook = ingestAddress(edge.publicUrl, SERVICE);
      console.error(
        `\nThe webhook, set in the application's panel (Webhooks → Configure notifications):\n` +
          `  — Production mode URL: ${webhook}\n` +
          `  — Events: Payments\n` +
          `  Save, and the panel shows the secret signature to paste below.\n`,
      );
      // the address Mercado Pago is about to be handed, checked from the internet in while
      // there is a human here to read the answer
      console.error(`${await reachLine(webhook, SERVICE)}\n`);
    }
    const secret = edge.publicUrl === null
      ? undefined
      : ask("Webhook secret signature (empty to skip — the poll alone reads every payment):");

    const store = await openStore(root);
    const log = await store.log();
    const creds = await store.vault();
    try {
      const { account, contention } = await connectMercadopago(token, secret, {
        ...(principal ? { principal } : {}),
        creds,
        store: log, // connections live on the Log (§4)
        publish: log.publish,
      });
      console.error(
        `\n✓ connected: mercadopago ${account.nickname ?? account.id} (user ${account.id}) → ` +
          `${principal ?? "the org"}`,
      );
      if (contention) console.error(`  but: ${contention} (\`liquen connect --remove\` it)`);
      console.error("  (deno task status shows the map)");
    } finally {
      await creds.close();
      await log.close();
    }
  });
}
