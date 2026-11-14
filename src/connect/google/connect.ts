/**
 * connect/google/connect.ts — `liquen connect google`: the two dev-side Google doors (§4).
 *
 *   app      the door's own key: paste the OAuth client (id + secret) → vault
 *            `google:app:<client_id>`. Not a grant — no connection, no membership, no
 *            event; nobody got connected. Several apps may coexist (`list("google:app:")`);
 *            the id in the key is what a sign-in picks by.
 *   account  a grant through the OAuth handler (connect/google/oauth.ts): the door asks
 *            main for the sign-in (signin.ts), main serves the handler while it is open,
 *            and the callback does what every grant does — writes the map. Ownership (the
 *            connection's agent_id) is decided by the ask: the agent arg, or `--shared`
 *            for an ownerless account (§6). The ticket carries it, never the link.
 *
 * The redirect URI is the org's, not the app row's: `callbackAddress` (edge.ts) — the
 * public door `<edge.publicUrl>/google/oauth/callback` when the org has a public address,
 * else this machine's edge, `http://localhost:<edge.port>/google/oauth/callback`, which
 * Google permits in plain http. It is sent verbatim as `redirect_uri`, so the string
 * Google matches against its own list is the one expression, and its host decides who can
 * reach that sign-in: the loopback one is the dev's own browser, and the public one is
 * reached by a member anywhere. The command opens the link here when it is for the person
 * at this terminal — a loopback callback, or a grant bound to the terminal's own user —
 * and prints it to send otherwise (`handOut`, door.ts). Either way the edge forwards the
 * callback to main, so the org must be running for a sign-in to land.
 *
 * The app door prints the callback before it asks for anything, so the console's
 * "Authorized redirect URIs" field can be filled while the client is still being created.
 *
 * Removal is not a door yet: deleting an app or a grant is a deliberate SQL act (§9).
 */

import { helpFlag } from "../help.ts";
import type { Credentials } from "../../store/credentials.ts";
import { findRoot, orgFlag } from "../../config.ts";
import { readConfig } from "../../org.ts";
import { callbackAddress } from "../../edge.ts";
import { declared, printNext, requireEdge } from "../declare.ts";
import { signInHere, terminalUser } from "../door.ts";
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

/* ── local entry ────────────────────────────────────────────────────────────────────────
 *
 *   deno task connect google app                          # paste client id + secret
 *   deno task connect google account [principal] [--shared] [--app <client_id>]
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
       liquen connect google account [agent] [--shared] [--app <client_id>] [--scopes "…"]

  Connect Google from this terminal — the app into the vault, an account through the
  browser here; knobs: connections.google.

  app       the OAuth client (id and secret) the account door signs in with
  account   sign a Google account in: [agent]'s (default: your OS username) or, with
            --shared, one nobody owns; --app picks the client when the vault holds several;
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
      if (rest[i] === "--shared") flags.set("shared", "1");
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
          "browser (`--shared` for a shared one)",
        ]);
      } else if (verb === "account") {
        const agent = flags.has("shared") ? undefined : positional[0] ?? terminalUser();
        const scopes = flags.get("scopes")?.split(/[ ,]+/).filter(Boolean);
        await requireEdge(root);
        console.error(
          `Connecting a Google account${agent ? ` for "${agent}"` : " (org — ownerless)"}.\n`,
        );
        await creds.close();
        Deno.exit(
          await signInHere(root, {
            service: SERVICE,
            ...(agent ? { agent } : {}),
            ...(flags.get("app") ? { app: flags.get("app") } : {}),
            ...(scopes?.length ? { scopes } : {}),
          }),
        );
      } else {
        console.error(USAGE);
        Deno.exit(2);
      }
    } finally {
      await creds.close();
    }
  });
}
