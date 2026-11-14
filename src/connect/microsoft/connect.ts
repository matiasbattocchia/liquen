/**
 * connect/microsoft/connect.ts — `liquen connect microsoft`: the two dev-side Entra doors,
 * Google's shape (connect/google/connect.ts) at Microsoft's wire.
 *
 *   app      the door's own key: paste the app registration (client id + secret + the
 *            tenant it lives in) → vault `microsoft:app:<client_id>`. Not a grant — no
 *            connection, no membership, no event; nobody got connected. Several apps may
 *            coexist; the id in the key is what a sign-in picks by. The door also lays
 *            the Graph skill (`data/system/skills/microsoft-graph.md`, write-if-absent):
 *            the org has it iff it connected Microsoft.
 *   account  a grant through the OAuth handler (connect/microsoft/oauth.ts): the door asks
 *            main for the sign-in (signin.ts), and main serves the handler while it is
 *            open. Ownership (the connection's agent_id) is decided by the ask: the agent
 *            arg, or `--shared` for an ownerless account (§6).
 *
 * The tenant rides on the app row because it is the app's: a registration lives in one
 * directory, and its endpoints are that directory's. `organizations` names an app
 * registered for any work account; a directory id or domain, an app for one org.
 *
 * The redirect URI is the org's, not the app row's: `callbackAddress` (edge.ts) — the
 * public door `<edge.publicUrl>/microsoft/oauth/callback` when the org has a public
 * address, else this machine's edge, `http://localhost:<edge.port>/microsoft/oauth/
 * callback`, which Entra permits in plain http. The app door prints it for the portal's
 * redirect URI field, and a sign-in sends it verbatim as `redirect_uri`, so the string
 * Entra matches against its own list is the one expression. The command opens the link
 * here when it is for the person at this terminal — a loopback callback, or a grant bound
 * to the terminal's own user — and prints it to send otherwise (`handOut`, door.ts).
 * Either way the edge forwards the callback to main, so the org must be running for a
 * sign-in to land.
 *
 * The app door prints the callback before it asks for anything, so the portal's field
 * can be filled while the registration is still being created.
 *
 * Removal is not a door yet: deleting an app or a grant is a deliberate SQL act (§9).
 */

import { helpFlag } from "../help.ts";
import type { Credentials } from "../../store/credentials.ts";
import { findRoot, orgFlag } from "../../config.ts";
import { readConfig } from "../../org.ts";
import { callbackAddress, ingestAddress, reachLine } from "../../edge.ts";
import { declared, printNext, requireEdge } from "../declare.ts";
import { signInHere, terminalUser } from "../door.ts";
import { SPEC } from "./config.ts";
import { entry } from "../../entry.ts";

export const APP_PREFIX = "microsoft:app:";
const SERVICE = "microsoft";

export interface MicrosoftApp {
  clientId: string;
  clientSecret: string;
  tenant: string;
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
    extra: { tenant: app.tenant },
  });
  return key;
}

/** What the app door prints before it asks for anything: the portal walk, step by step.
 *  Entra takes a registration's permissions by hand, one checkbox each, so the list is
 *  the catalog's `scopes` — the very ones a sign-in asks for — and cannot drift from them.
 *  A sign-in that asks for an admin-only permission nobody has granted stops at an
 *  "approval required" page for every surface at once, so admin consent is a step.
 *  `callback` is the org's redirect URI as `callbackAddress` names it. */
export function appGuide(callback: string, scopes: string[]): string {
  const width = 76;
  const lines: string[] = [];
  let line = "";
  for (const s of scopes) {
    if (line && line.length + 2 + s.length > width) {
      lines.push(line);
      line = "";
    }
    line = line ? `${line}  ${s}` : s;
  }
  if (line) lines.push(line);
  return [
    `1. Register the app: https://entra.microsoft.com → App registrations → New registration.`,
    `   Supported account types: "this organizational directory only" serves one tenant.`,
    `   Redirect URI: platform "Web", value:`,
    `     ${callback}`,
    `   That is where a sign-in comes back: the org's public door when edge.publicUrl is`,
    `   set (a member signs in from anywhere), else this machine's edge (edge.port).`,
    `   Setting publicUrl later means registering the public one too.`,
    `2. Certificates & secrets → New client secret. Copy its VALUE (shown once), not its id.`,
    `3. API permissions → Add a permission → Microsoft Graph → Delegated permissions, and`,
    `   tick each of these (connections.microsoft.scopes):`,
    ...lines.map((l) => `     ${l}`),
    `4. Still under API permissions: "Grant admin consent for <tenant>", as a Global`,
    `   Administrator. Every row's status must read granted: ChannelMessage.*, Channel.*`,
    `   and ChatMember.* are the tenant admin's alone, and a sign-in asking for one not`,
    `   granted is refused whole.`,
    `5. Overview: copy the Application (client) ID and the Directory (tenant) ID, and paste`,
    `   them below. A single-tenant app needs its tenant id; "organizations" is for an app`,
    `   registered for any work account.`,
    ``,
  ].join("\n");
}

const USAGE = `usage: liquen connect microsoft app
       liquen connect microsoft account [agent] [--shared] [--app <client_id>] [--scopes "…"]

  Connect Microsoft 365 from this terminal — the app registration into the vault, an
  account through the browser here; knobs: connections.microsoft.

  app       the Entra app registration (client id, secret, tenant) the account door
            signs in with
  account   sign a Microsoft account in: [agent]'s (default: your OS username) or, with
            --shared, one nobody owns; --app picks the registration when the vault holds
            several; --scopes overrides the catalog's (space- or comma-separated)
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
        const { microsoftConfig } = await import("./config.ts");
        const { scopes } = await microsoftConfig(root);
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
        const clientId = ask("Application (client) ID:");
        const clientSecret = ask("Client secret value:");
        const tenant = prompt("Directory (tenant) ID or domain (empty = organizations):")
          ?.trim() || "organizations";
        const key = await connectMicrosoftApp({ clientId, clientSecret, tenant }, creds);
        console.error(`✓ app stored: ${key} (tenant ${tenant}, callback: ${callback})`);
        if (!(SERVICE in connections)) await declared(root, SPEC);
        const { seedSkill } = await import("../../store/seed.ts");
        const docs = await store.docs();
        const log = await store.log();
        try {
          if (await seedSkill(docs.bed, log, "microsoft-graph")) {
            console.error(`✓ skill laid: system/skills/microsoft-graph (${docs.on})`);
          }
        } finally {
          await log.close();
          await docs.close();
        }
        printNext([
          "`liquen connect microsoft account <agent>` — sign an account in from this " +
          "machine's browser (`--shared` for a shared one)",
        ]);
      } else if (verb === "account") {
        const agent = flags.has("shared") ? undefined : positional[0] ?? terminalUser();
        const scopes = flags.get("scopes")?.split(/[ ,]+/).filter(Boolean);
        const { edge } = await readConfig(root);
        await requireEdge(root);
        console.error(
          `Connecting a Microsoft account${agent ? ` for "${agent}"` : " (org — ownerless)"}.\n`,
        );
        const code = await signInHere(root, {
          service: SERVICE,
          ...(agent ? { agent } : {}),
          ...(flags.get("app") ? { app: flags.get("app") } : {}),
          ...(scopes?.length ? { scopes } : {}),
        }, {
          shortfall: "A permission the tenant reserves for its admins (reading channels, most " +
            "mail and calendar permissions under Microsoft's default consent policy) needs " +
            "their grant on the app registration first.",
        });
        if (code !== 0) Deno.exit(code);
        // Teams is push-only, to the org's public door: the address is checked from the
        // internet in while there is a human here to read the answer
        const push = edge.publicUrl === null ? null : ingestAddress(edge.publicUrl, SERVICE);
        if (push !== null) console.error(await reachLine(push, SERVICE));
        if (push === null) {
          printNext([
            "Teams: set edge.publicUrl — Graph pushes chats and channels to " +
            "<publicUrl>/microsoft/ingest, and nowhere else; sends go out without it",
          ]);
        }
      } else {
        console.error(USAGE);
        Deno.exit(2);
      }
    } finally {
      await creds.close();
    }
  });
}
