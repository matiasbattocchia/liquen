/**
 * connect/microsoft/connect.ts — `liquen connect microsoft`: the two dev-side Entra doors,
 * Google's shape (connect/google/connect.ts) at Microsoft's wire.
 *
 *   app      the door's own key: paste the app registration (client id + secret + the
 *            tenant it lives in + the public redirect URI registered on it) → vault
 *            `microsoft:app:<client_id>`. Not a grant — no connection, no membership, no
 *            event; nobody got connected. Several apps may coexist; the id in the key is
 *            what a sign-in picks by. The door also lays the Graph skill
 *            (`data/system/skills/microsoft-graph.md`, write-if-absent): the org has
 *            it iff it connected Microsoft.
 *   account  a grant through the OAuth handler (connect/microsoft/oauth.ts), served for
 *            exactly one sign-in. Ownership (the connection's agent_id) is decided HERE,
 *            at mint time: the agent arg rides `?agent=`; `--org` mints an ownerless link,
 *            the org's shared account (§6).
 *
 * The tenant rides on the app row because it is the app's: a registration lives in one
 * directory, and its endpoints are that directory's. `organizations` names an app
 * registered for any work account; a directory id or domain, an app for one org.
 *
 * One registered redirect URI is the whole of the account door's addressing: the app row's
 * public one, or `localCallback` when it names none — sent verbatim as `redirect_uri`, so
 * the string Entra matches against its own list is the one that was registered. A
 * loopback URI is the dev's own browser, which Entra permits in plain http, and it names
 * the port the door binds; any other host is one a member elsewhere can reach, so the
 * command prints the link to send instead and binds `connections.microsoft.oauthPort`.
 *
 * The app door prints the loopback URI before it asks for anything, so the portal's
 * redirect URI field can be filled while the registration is still being created; the
 * port is picked free of this machine on the run that has nothing declared yet, written
 * to config.jsonc beside the app row, and from then on read — never picked again.
 *
 * Removal is not a door yet: deleting an app or a grant is a deliberate SQL act (§9).
 */

import { helpFlag } from "../help.ts";
import type { CredentialRow, Credentials } from "../../store/credentials.ts";
import { findRoot, orgFlag, readConfig } from "../../config.ts";
import { declared, freePort } from "../declare.ts";
import { type DoorAddress, doorAddress, oneShot, openBrowser } from "../door.ts";
import { SPEC } from "./config.ts";
import { entry } from "../../entry.ts";

export const APP_PREFIX = "microsoft:app:";

export interface MicrosoftApp {
  clientId: string;
  clientSecret: string;
  tenant: string;
  redirectUri?: string; // a public callback registered on the app; none ⇒ the loopback one
}

/** Store an app registration under its own id. The vault's merge lets a re-paste rotate
 *  the secret — Entra expires one within two years — without losing the sidecar. */
export async function connectMicrosoftApp(
  app: MicrosoftApp,
  creds: Pick<Credentials, "put">,
): Promise<string> {
  if (!app.clientId || !app.clientSecret || !app.tenant) {
    throw new Error("client_id, client_secret and tenant required");
  }
  const key = `${APP_PREFIX}${app.clientId}`;
  await creds.put({
    key,
    value: { client_id: app.clientId, client_secret: app.clientSecret },
    extra: { tenant: app.tenant, ...(app.redirectUri ? { redirect_uri: app.redirectUri } : {}) },
  });
  return key;
}

/** The account door's app choice: the only one, or the one `clientId` names. */
export async function pickMicrosoftApp(
  creds: Pick<Credentials, "get" | "list">,
  clientId?: string,
): Promise<CredentialRow> {
  if (clientId) {
    const row = await creds.get(`${APP_PREFIX}${clientId}`);
    if (!row) throw new Error(`no app ${clientId} — \`liquen connect microsoft app\` first`);
    return row;
  }
  const apps = await creds.list(APP_PREFIX);
  if (apps.length === 0) {
    throw new Error("no microsoft app in the vault — `liquen connect microsoft app` first");
  }
  if (apps.length > 1) {
    const ids = apps.map((a) => a.value.client_id).join("\n  ");
    throw new Error(`several apps — pick one with --app <client_id>:\n  ${ids}`);
  }
  return apps[0];
}

/** The door's address when the app row names no public one: this machine's browser, on
 *  `oauthPort`. The app door prints it for the portal's redirect URI field and a sign-in
 *  sends it — one expression, so the registered string and the sent string cannot drift. */
export function localCallback(oauthPort: number): string {
  return `http://localhost:${oauthPort}/oauth/microsoft/callback`;
}

const USAGE = `usage: liquen connect microsoft app
       liquen connect microsoft account [agent] [--org] [--app <client_id>] [--scopes "…"]

  Connect Microsoft 365 from this terminal — the app registration into the vault, an
  account through the browser here; knobs: connections.microsoft.

  app       the Entra app registration (client id, secret, tenant) the account door
            signs in with
  account   sign a Microsoft account in: [agent]'s (default: your OS username) or, with
            --org, the org's own; --app picks the registration when the vault holds
            several; --scopes overrides the catalog's (space- or comma-separated)
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
        const { microsoftConfig } = await import("./config.ts");
        const { oauthPort: fromCatalog } = await microsoftConfig(root);
        // the loopback callback is handed to a human who registers it with Entra, so the
        // port is picked HERE, once: free of this machine while the file has nothing to
        // say, and then never again — a declared port is the operator's
        const alreadyDeclared = "microsoft" in (await readConfig(root)).connections;
        const oauthPort = alreadyDeclared ? fromCatalog : freePort(fromCatalog);
        const local = localCallback(oauthPort);
        console.error(
          `Register the app at https://entra.microsoft.com → App registrations → New ` +
            `registration. Under "Redirect URI" pick platform "Web" and register:\n` +
            `  ${local}\n` +
            `That is where a sign-in from this terminal comes back (the port is ` +
            `connections.microsoft.oauthPort), and it is what this door serves unless you ` +
            `paste a public URI below. A member signing in elsewhere needs one: register ` +
            `that too, paste it, and their sign-in is served there instead.\n` +
            `Then "Certificates & secrets" → New client secret: paste its VALUE (shown ` +
            `once), not its id. The overview page has the client id and the tenant id.\n`,
        );
        const ask = (label: string): string => {
          const v = prompt(label)?.trim();
          if (!v) {
            console.error("nothing pasted — nothing written");
            Deno.exit(2);
          }
          return v;
        };
        const clientId = ask("Application (client) ID:");
        const clientSecret = ask("Client secret value:");
        const tenant = prompt("Tenant (directory id or domain; empty = organizations):")
          ?.trim() || "organizations";
        const redirectUri = prompt("Public redirect URI (empty to skip):")?.trim() || undefined;
        if (redirectUri) {
          try { // a URI the door cannot serve is caught here, not after someone consents
            doorAddress(redirectUri, oauthPort);
          } catch (e) {
            console.error(e instanceof Error ? e.message : String(e));
            Deno.exit(2);
          }
        }
        const key = await connectMicrosoftApp(
          { clientId, clientSecret, tenant, redirectUri },
          creds,
        );
        console.error(`✓ app stored: ${key} (tenant ${tenant}, callback: ${redirectUri ?? local})`);
        if (!alreadyDeclared) await declared(root, SPEC, { oauthPort });
        const { seedSkill } = await import("../../store/seed.ts");
        if (await seedSkill(dir, "microsoft-graph")) {
          console.error("✓ skill laid: data/system/skills/microsoft-graph.md");
        }
      } else if (verb === "account") {
        const { createMicrosoftOAuth } = await import("./oauth.ts");
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
        const app = await pickMicrosoftApp(creds, flags.get("app")).catch((e: Error) => {
          console.error(e.message);
          Deno.exit(2);
        });
        const { microsoftConfig } = await import("./config.ts");
        const { oauthPort, scopes } = await microsoftConfig(root);
        const asked = flags.get("scopes")?.split(/[ ,]+/).filter(Boolean) ?? scopes;
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
        const { handler, outcome } = oneShot(createMicrosoftOAuth({
          config: {
            clientId: app.value.client_id,
            clientSecret: app.value.client_secret,
            tenant: String(app.extra?.tenant ?? "organizations"),
            redirectUri: door.callback,
            scopes: asked,
          },
          creds,
          publish: log.publish,
          store: log,
          onGrant: (g) => (shortfall = g.missing),
        }));
        // the port is registered with Entra now, so a taken one is a conflict a human has
        // to settle — the door cannot step over it without invalidating the URI it must send
        let server: Deno.HttpServer;
        try {
          server = Deno.serve({ port: door.port, onListen: () => {} }, handler);
        } catch (e) {
          if (!(e instanceof Deno.errors.AddrInUse)) throw e;
          console.error(
            `port ${door.port} is already in use, and it is the port ${door.callback} is ` +
              `registered on — stop whatever holds it (another org's door, \`deno task ` +
              `status\`), or register a callback on a free port and set ` +
              `connections.microsoft.oauthPort to match.`,
          );
          await log.close();
          Deno.exit(2);
        }
        const start = new URL(door.start);
        if (agent) start.searchParams.set("agent", agent);
        console.error(
          `Connecting a Microsoft account${agent ? ` for "${agent}"` : " (org — ownerless)"} ` +
            `via app ${app.value.client_id}.\nAsking for:\n  ${asked.join("\n  ")}\n`,
        );
        if (door.loopback) {
          console.error(`Open and approve:\n  ${start.href}`);
          openBrowser(start.href);
        } else {
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
              `The grant cannot do what those permissions carry — Graph answers 403. A ` +
              `permission the tenant reserves for its admins (reading channels, most ` +
              `mail and calendar permissions under Microsoft's default consent policy) ` +
              `needs their grant on the app registration; then run this again — consent ` +
              `adds up, so it merges into this grant.`
            : "\n✓ connected (deno task status shows the map)",
        );
        await declared(root, SPEC, { oauthPort: door.port });
      } else {
        console.error(USAGE);
        Deno.exit(2);
      }
    } finally {
      await creds.close();
    }
  });
}
