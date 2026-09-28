/**
 * connect/google/connect.ts — `liquen connect google`: the two dev-side Google doors (§4).
 *
 *   app      the door's own key: paste the OAuth client (id + secret) → vault
 *            `google:app:<client_id>`. Not a grant — no connection, no membership, no
 *            event; nobody got connected. Several apps may coexist (`list("google:app:")`);
 *            the id in the key is what a sign-in picks by.
 *   account  a grant through the OAuth handler (connect/google/oauth.ts), served for
 *            exactly one sign-in: hand out /start, and the callback does what every grant
 *            does — writes the map. Ownership (the connection's agent_id) is decided HERE,
 *            at mint time: the agent arg rides `?agent=`; `--org` mints an ownerless link,
 *            the org's shared account (§6). The handler only executes what the mint said.
 *
 * The redirect URI is the org's, not the app row's: `callbackAddress` (edge.ts) — the
 * public door `<edge.publicUrl>/google/oauth/callback` when the org has a public address,
 * else this machine's edge, `http://localhost:<edge.port>/google/oauth/callback`, which
 * Google permits in plain http. It is sent verbatim as `redirect_uri`, so the string
 * Google matches against its own list is the one expression, and its host decides who can
 * reach that sign-in: the loopback one is the dev's own browser, and the public one is
 * reached by a member anywhere. The command opens the link here when it is for the person
 * at this terminal — a loopback callback, or a grant bound to the terminal's own user —
 * and prints it to send otherwise (`handOut`, door.ts). Either way the edge forwards the callback to the door's socket
 * (`serveDoor`), so the org must be running for a sign-in to land.
 *
 * The app door prints the callback before it asks for anything, so the console's
 * "Authorized redirect URIs" field can be filled while the client is still being created.
 *
 * Removal is not a door yet: deleting an app or a grant is a deliberate SQL act (§9).
 */

import { helpFlag } from "../help.ts";
import type { CredentialRow, Credentials } from "../../store/credentials.ts";
import { findRoot, orgFlag, readConfig } from "../../config.ts";
import { callbackAddress } from "../../edge.ts";
import { declared, printNext, requireEdge, startStep } from "../declare.ts";
import {
  type DoorAddress,
  doorAddress,
  handOut,
  oneShot,
  serveDoor,
  terminalUser,
} from "../door.ts";
import { SPEC } from "./config.ts";
import { entry } from "../../entry.ts";

export const APP_PREFIX = "google:app:";
const SERVICE = "google";

export interface GoogleApp {
  clientId: string;
  clientSecret: string;
}

/** Store an OAuth client under its own id. The vault's merge lets a re-paste rotate the
 *  secret. */
export async function connectGoogleApp(
  app: GoogleApp,
  creds: Pick<Credentials, "put">,
): Promise<string> {
  if (!app.clientId || !app.clientSecret) throw new Error("client_id and client_secret required");
  const key = `${APP_PREFIX}${app.clientId}`;
  await creds.put({ key, value: { client_id: app.clientId, client_secret: app.clientSecret } });
  return key;
}

/** The account door's app choice: the only one, or the one `clientId` names. */
export async function pickGoogleApp(
  creds: Pick<Credentials, "get" | "list">,
  clientId?: string,
): Promise<CredentialRow> {
  if (clientId) {
    const row = await creds.get(`${APP_PREFIX}${clientId}`);
    if (!row) throw new Error(`no app ${clientId} — \`liquen connect google app\` first`);
    return row;
  }
  const apps = await creds.list(APP_PREFIX);
  if (apps.length === 0) {
    throw new Error("no google app in the vault — `liquen connect google app` first");
  }
  if (apps.length > 1) {
    const ids = apps.map((a) => a.value.client_id).join("\n  ");
    throw new Error(`several apps — pick one with --app <client_id>:\n  ${ids}`);
  }
  return apps[0];
}

/* ── local entry ────────────────────────────────────────────────────────────────────────
 *
 *   deno task connect google app                          # paste client id + secret
 *   deno task connect google account [principal] [--org] [--app <client_id>]
 *                                    [--scopes "a b c"]   # default: connections.google.scopes
 */

/** The API a scope reaches, by the scope's first path word: a Google Cloud project answers
 *  403 for an API it has not enabled, whatever the consent carried. */
const APIS: Record<string, string> = {
  calendar: "Google Calendar API",
  gmail: "Gmail API",
  drive: "Google Drive API",
  spreadsheets: "Google Sheets API",
  documents: "Google Docs API",
  tasks: "Google Tasks API",
  contacts: "People API",
};

/** What the app door prints before it asks for anything: the console walk, step by step.
 *  The APIs to enable and the scopes to list are read off the catalog's `scopes`, the very
 *  ones a sign-in asks for, so the page cannot drift from them. `callback` is the org's
 *  redirect URI as `callbackAddress` names it. */
export function appGuide(callback: string, scopes: string[]): string {
  const apis = [
    ...new Set(
      scopes.flatMap((s) => {
        const word = /^https:\/\/www\.googleapis\.com\/auth\/([a-z]+)/.exec(s)?.[1];
        return word ? [APIS[word] ?? `the API behind ${s}`] : [];
      }),
    ),
  ];
  return [
    `1. Pick or create a project: https://console.cloud.google.com`,
    `2. APIs & Services → Library: enable ${apis.join(", ")}.`,
    `3. Google Auth Platform → Branding: an app name and a support email. Audience:`,
    `   "Internal" serves your Workspace organization's own accounts. "External" in Testing`,
    `   signs in only the accounts listed under Test users, and its grants expire in 7 days.`,
    `4. Data access → Add or remove scopes, and add these (connections.google.scopes):`,
    ...scopes.map((s) => `     ${s}`),
    `5. Clients → Create client, type "Web application". Under "Authorized redirect URIs":`,
    `     ${callback}`,
    `   That is where a sign-in comes back: the org's public door when edge.publicUrl is`,
    `   set (a member signs in from anywhere), else this machine's edge (edge.port).`,
    `   Setting publicUrl later means registering the public one too.`,
    `6. Copy the client ID and the client secret (shown once, at creation) and paste them below.`,
    ``,
  ].join("\n");
}

const USAGE = `usage: liquen connect google app
       liquen connect google account [agent] [--org] [--app <client_id>] [--scopes "…"]

  Connect Google from this terminal — the app into the vault, an account through the
  browser here; knobs: connections.google.

  app       the OAuth client (id and secret) the account door signs in with
  account   sign a Google account in: [agent]'s (default: your OS username) or, with
            --org, the org's own; --app picks the client when the vault holds several;
            --scopes overrides the catalog's (space- or comma-separated)
  --dir <org>   the org, when run from elsewhere`;

if (import.meta.main) {
  await entry(async () => {
    const { openStore } = await import("../../store/mod.ts");
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const root = findRoot(org);
    const store = await openStore(root);
    const [verb, ...rest] = org.args;

    const flags = new Map<string, string>();
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--org") flags.set("org", "1");
      else if (rest[i].startsWith("--")) flags.set(rest[i].slice(2), rest[++i] ?? "");
      else positional.push(rest[i]);
    }

    const creds = await store.vault();
    try {
      if (verb === "app") {
        const { googleConfig } = await import("./config.ts");
        const { scopes } = await googleConfig(root);
        const { connections, edge } = await readConfig(root);
        const callback = callbackAddress(edge, SERVICE);
        console.error(appGuide(callback, scopes));
        const ask = (label: string): string => {
          const v = prompt(label)?.trim();
          if (!v) {
            console.error("nothing pasted — nothing written");
            Deno.exit(2);
          }
          return v;
        };
        const clientId = ask("Client ID:");
        const clientSecret = ask("Client secret:");
        const key = await connectGoogleApp({ clientId, clientSecret }, creds);
        console.error(`✓ app stored: ${key} (callback: ${callback})`);
        // only now, because a door that wrote nothing promised nothing
        if (!(SERVICE in connections)) await declared(root, SPEC);
        printNext([
          "`liquen connect google account <agent>` — sign an account in from this machine's " +
          "browser (`--org` for the org's shared one)",
        ]);
      } else if (verb === "account") {
        const { createGoogleOAuth } = await import("./oauth.ts");
        const agent = flags.has("org") ? undefined : positional[0] ?? terminalUser();
        const app = await pickGoogleApp(creds, flags.get("app")).catch((e: Error) => {
          console.error(e.message);
          Deno.exit(2);
        });
        const { googleConfig } = await import("./config.ts");
        const { scopes } = await googleConfig(root);
        const asked = flags.get("scopes")?.split(/[ ,]+/).filter(Boolean) ?? scopes;
        const registered = callbackAddress((await readConfig(root)).edge, SERVICE);
        let door: DoorAddress;
        try {
          door = doorAddress(registered);
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
          Deno.exit(2);
        }
        await requireEdge(root);
        const log = await store.log();
        let shortfall: string[] = [];
        const { handler, outcome } = oneShot(createGoogleOAuth({
          config: {
            clientId: app.value.client_id,
            clientSecret: app.value.client_secret,
            redirectUri: door.callback,
            scopes: asked,
          },
          creds,
          publish: log.publish,
          store: log,
          onGrant: (g) => (shortfall = g.missing),
        }));
        let server: Deno.HttpServer;
        try {
          server = await serveDoor(root, SERVICE, handler);
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
          await log.close();
          Deno.exit(2);
        }
        const start = new URL(door.start);
        if (agent) start.searchParams.set("agent", agent);
        console.error(
          `Connecting a Google account${agent ? ` for "${agent}"` : " (org — ownerless)"} ` +
            `via app ${app.value.client_id}.\nAsking for:\n  ${asked.join("\n  ")}\n`,
        );
        handOut(door, start, agent);
        const res = await outcome;
        await server.shutdown();
        await log.close();
        if (res.status !== 200) {
          console.error(`✗ not connected: ${(await res.text()).trim()}`);
          Deno.exit(1);
        }
        console.error(
          shortfall.length
            ? `\n⚠ connected, WITHOUT:\n  ${shortfall.join("\n  ")}\n` +
              `The grant cannot do what those scopes carry — the API answers 403. Tick them ` +
              `on the consent screen (or add them under Data access) and run this again; ` +
              `consent is incremental, so it merges into this grant.`
            : "\n✓ connected (deno task status shows the map)",
        );
        await declared(root, SPEC);
        printNext([
          await startStep(
            root,
            "the Google process polls calendar and mail, and agents get $GOOGLE_WORKSPACE_CLI_TOKEN",
          ),
        ]);
      } else {
        console.error(USAGE);
        Deno.exit(2);
      }
    } finally {
      await creds.close();
    }
  });
}
