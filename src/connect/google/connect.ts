/**
 * connect/google/connect.ts — `liquen connect google`: the two dev-side Google doors (§4).
 *
 *   app      the door's own key: paste the OAuth client (id + secret + redirect URI)
 *            → vault `google:app:<client_id>`. Not a grant — no connection, no
 *            membership, no event; nobody got connected. Several apps may coexist
 *            (`list("google:app:")`); the id in the key is what the account door picks by.
 *   account  the dev's own grant through the SAME handler the hosted door serves
 *            (connect/google/oauth.ts): serve it on localhost, open the browser at
 *            /start, and the callback does what every grant does — writes the map.
 *            Ownership (the connection's agent_id) is decided HERE, at mint time:
 *            the principal arg rides `?agent=`; `--org` mints an ownerless link, the
 *            org's shared account (§6). The door only executes what the mint said.
 *
 * The account door overrides the app's redirect URI with its own localhost callback —
 * `http://localhost:<port>/oauth/google/callback` must be registered on the OAuth client
 * alongside the hosted one (Google allows plain-http localhost redirects).
 *
 * Removal is not a door yet: deleting an app or a grant is a deliberate SQL act (§9).
 */

import { helpFlag } from "../help.ts";
import type { CredentialRow, Credentials } from "../../store/credentials.ts";
import { findRoot, orgFlag } from "../../config.ts";
import { declared } from "../declare.ts";

export const APP_PREFIX = "google:app:";

export interface GoogleApp {
  clientId: string;
  clientSecret: string;
  redirectUri?: string; // the HOSTED door's callback; the account door uses localhost
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
 *   deno task connect:google app                          # paste client id + secret
 *   deno task connect:google account [principal] [--org] [--app <client_id>]
 *                                    [--scopes "a b c"]   # default: connections.google.scopes
 *
 * The account door serves its callback on connections.google.oauthPort. */
/** A handler wrapped for a one-shot door: the first callback — whichever way it went —
 *  settles `outcome`, so the command reports and exits instead of waiting on a page that
 *  already told the member it failed. */
export function oneShot(
  handler: (req: Request) => Promise<Response>,
): { handler: (req: Request) => Promise<Response>; outcome: Promise<Response> } {
  const done = Promise.withResolvers<Response>();
  return {
    outcome: done.promise,
    handler: async (req) => {
      const res = await handler(req);
      if (new URL(req.url).pathname.endsWith("/callback")) done.resolve(res.clone());
      return res;
    },
  };
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
  try {
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
        const redirectUri = prompt("Hosted redirect URI (empty to skip):")?.trim() || undefined;
        const key = await connectGoogleApp({ clientId, clientSecret, redirectUri }, creds);
        console.error(
          `✓ app stored: ${key}` + (redirectUri ? ` (hosted callback: ${redirectUri})` : ""),
        );
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
        const { oauthPort: port, scopes } = await googleConfig(root);
        const asked = flags.get("scopes")?.split(/[ ,]+/).filter(Boolean) ?? scopes;
        const callback = `http://localhost:${port}/oauth/google/callback`;
        const log = await openLog(`${dir}/log`);
        let shortfall: string[] = [];
        const { handler, outcome } = oneShot(createGoogleOAuth({
          config: {
            clientId: app.value.client_id,
            clientSecret: app.value.client_secret,
            redirectUri: callback,
            scopes: asked,
          },
          creds,
          publish: log.publish,
          store: log,
          onGrant: (g) => (shortfall = g.missing),
        }));
        const server = Deno.serve({ port, onListen: () => {} }, handler);
        const start = new URL(`http://localhost:${port}/oauth/google/start`);
        if (agent) start.searchParams.set("agent", agent);
        const hosted = app.extra?.redirect_uri as string | undefined;
        console.error(
          `Connecting a Google account${agent ? ` for "${agent}"` : " (org — ownerless)"} ` +
            `via app ${app.value.client_id}.\nAsking for:\n  ${asked.join("\n  ")}\n` +
            `Open and approve:\n  ${start.href}\n` +
            `This door waits on localhost, so ${callback} must be registered on the OAuth ` +
            `client — Google rejects the request with redirect_uri_mismatch otherwise.` +
            (hosted
              ? `\n(the app's hosted callback ${hosted} is the served door's, not this one's)`
              : ""),
        );
        try { // best effort — the link above is the real door
          new Deno.Command(Deno.build.os === "darwin" ? "open" : "xdg-open", {
            args: [start.href],
            stdout: "null",
            stderr: "null",
          }).spawn().unref();
        } catch { /* headless is fine */ }
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
        await declared(root, "google");
      } else {
        console.error(USAGE);
        Deno.exit(2);
      }
    } finally {
      await creds.close();
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(1);
  }
}
