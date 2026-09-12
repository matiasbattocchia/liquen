/**
 * connect/google/connect.ts — `liquen connect google`: the two dev-side Google doors (§4).
 *
 *   app      the door's own key: paste the OAuth client (id + secret + the public redirect
 *            URI registered on it) → vault `google:app:<client_id>`. Not a grant — no
 *            connection, no membership, no event; nobody got connected. Several apps may
 *            coexist (`list("google:app:")`); the id in the key is what a sign-in picks by.
 *   account  a grant through the OAuth handler (connect/google/oauth.ts), served for
 *            exactly one sign-in: hand out /start, and the callback does what every grant
 *            does — writes the map. Ownership (the connection's agent_id) is decided HERE,
 *            at mint time: the agent arg rides `?agent=`; `--org` mints an ownerless link,
 *            the org's shared account (§6). The handler only executes what the mint said.
 *
 * One registered redirect URI is the whole of the account door's addressing: the app row's
 * public one, or `localCallback` when it names none. It is sent verbatim as `redirect_uri`,
 * so the string Google matches against its own list is the one that was registered, and its
 * host decides who can reach that sign-in. A loopback URI is the dev's own browser — Google
 * permits plain http there — and it names the port the door binds, because that browser dials
 * the door directly; the command opens it. Any other host is one a member elsewhere can
 * reach, so the command prints the link to send instead and binds
 * `connections.google.oauthPort` for whatever terminates TLS to forward to.
 *
 * The app door prints the loopback URI before it asks for anything, so the console's
 * "Authorized redirect URIs" field can be filled while the client is still being created.
 *
 * Removal is not a door yet: deleting an app or a grant is a deliberate SQL act (§9).
 */

import { helpFlag } from "../help.ts";
import type { CredentialRow, Credentials } from "../../store/credentials.ts";
import { findRoot, orgFlag } from "../../config.ts";
import { declared } from "../declare.ts";
import { type DoorAddress, doorAddress, oneShot, openBrowser } from "../door.ts";
import { SPEC } from "./config.ts";
import { entry } from "../../entry.ts";

export const APP_PREFIX = "google:app:";

export interface GoogleApp {
  clientId: string;
  clientSecret: string;
  redirectUri?: string; // a public callback registered on the client; none ⇒ the loopback one
}

/** Store an OAuth client under its own id. The vault's merge lets a re-paste rotate the
 *  secret without losing the sidecar. */
export async function connectGoogleApp(
  app: GoogleApp,
  creds: Pick<Credentials, "put">,
): Promise<string> {
  if (!app.clientId || !app.clientSecret) throw new Error("client_id and client_secret required");
  const key = `${APP_PREFIX}${app.clientId}`;
  await creds.put({
    key,
    value: { client_id: app.clientId, client_secret: app.clientSecret },
    ...(app.redirectUri ? { extra: { redirect_uri: app.redirectUri } } : {}),
  });
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
 *
 * The account door serves its callback on connections.google.oauthPort. */

/** The door's address when the app row names no public one: this machine's browser, on
 *  `oauthPort`. The app door prints it for the console's "Authorized redirect URIs" field
 *  and a sign-in sends it — one expression, so the registered string and the sent string
 *  cannot drift apart. */
export function localCallback(oauthPort: number): string {
  return `http://localhost:${oauthPort}/oauth/google/callback`;
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
    const { openCredentials } = await import("../../store/credentials.ts");
    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const root = findRoot(org);
    const dir = `${root}/data`;
    const [verb, ...rest] = org.args;

    const flags = new Map<string, string>();
    const positional: string[] = [];
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--org") flags.set("org", "1");
      else if (rest[i].startsWith("--")) flags.set(rest[i].slice(2), rest[++i] ?? "");
      else positional.push(rest[i]);
    }

    const creds = await openCredentials(dir);
    try {
      if (verb === "app") {
        const { googleConfig } = await import("./config.ts");
        const { oauthPort } = await googleConfig(root);
        const local = localCallback(oauthPort);
        console.error(
          `Create the client at https://console.cloud.google.com/auth/clients — type "Web ` +
            `application". Under "Authorized redirect URIs" register:\n` +
            `  ${local}\n` +
            `That is where a sign-in from this terminal comes back (the port is ` +
            `connections.google.oauthPort), and it is what this door serves unless you paste ` +
            `a public URI below. A member signing in elsewhere needs one: register that too, ` +
            `paste it, and their sign-in is served there instead.\n`,
        );
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
        const redirectUri = prompt("Public redirect URI (empty to skip):")?.trim() || undefined;
        if (redirectUri) {
          try { // a URI the door cannot serve is caught here, not after someone consents
            doorAddress(redirectUri, oauthPort);
          } catch (e) {
            console.error(e instanceof Error ? e.message : String(e));
            Deno.exit(2);
          }
        }
        const key = await connectGoogleApp({ clientId, clientSecret, redirectUri }, creds);
        console.error(`✓ app stored: ${key} (callback: ${redirectUri ?? local})`);
      } else if (verb === "account") {
        const { createGoogleOAuth } = await import("./oauth.ts");
        const { openLog } = await import("../../store/log.ts");
        const { userInfo } = await import("node:os");
        const org = flags.has("org");
        const agent = org ? undefined : positional[0] ?? (() => {
          try {
            return userInfo().username;
          } catch {
            return "principal";
          }
        })();
        const app = await pickGoogleApp(creds, flags.get("app")).catch((e: Error) => {
          console.error(e.message);
          Deno.exit(2);
        });
        const { googleConfig } = await import("./config.ts");
        const { oauthPort, scopes } = await googleConfig(root);
        const asked = flags.get("scopes")?.split(/[ ,]+/).filter(Boolean) ?? scopes;
        // no public URI on the app row means the dev never set one up: the sign-in is theirs
        const registered = (app.extra?.redirect_uri as string | undefined) ??
          localCallback(oauthPort);
        let door: DoorAddress;
        try {
          door = doorAddress(registered, oauthPort);
        } catch (e) {
          console.error(e instanceof Error ? e.message : String(e));
          Deno.exit(2);
        }
        const log = await openLog(`${dir}/log`);
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
        const server = Deno.serve({ port: door.port, onListen: () => {} }, handler);
        const start = new URL(door.start);
        if (agent) start.searchParams.set("agent", agent);
        console.error(
          `Connecting a Google account${agent ? ` for "${agent}"` : " (org — ownerless)"} ` +
            `via app ${app.value.client_id}.\nAsking for:\n  ${asked.join("\n  ")}\n`,
        );
        if (door.loopback) {
          console.error(`Open and approve:\n  ${start.href}`);
          openBrowser(start.href);
        } else {
          // opening it here would spend the one sign-in on whoever is logged in to this
          // browser, and the grant would land under the name meant for someone else
          console.error(
            `Send this link to the person signing in:\n  ${start.href}\n` +
              `It binds the grant to ${agent ? `"${agent}"` : "the org"} and is good for one ` +
              `sign-in, so it goes to exactly one person. This door waits until they finish, ` +
              `serving ${door.callback} on port ${door.port}.`,
          );
        }
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
      } else {
        console.error(USAGE);
        Deno.exit(2);
      }
    } finally {
      await creds.close();
    }
  });
}
