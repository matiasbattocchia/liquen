/**
 * connect/remove.ts — `liquen connect --remove <service>:<address>`: a grant taken back (§4).
 *
 * The target is what `liquen status` prints: a connection as `<service>:<address>`, or a
 * service's vault key no live connection authenticates with (a token grant, which has no
 * row; an app registration a door keeps for the next grant). Three
 * records answer for a connection, and each is undone in its own terms:
 *
 *   the row      soft-deleted: the publish gate closes, and the history it already ingested
 *                keeps its identity and its readers.
 *   the secret   deleted from the vault — unless another live connection authenticates
 *                with the same one, which keeps it.
 *   the scope    `connections.<service>` leaves the store's configuration once the service
 *                has no live connection left, so `liquen start` spawns nothing for it. One
 *                `config.yaml` declares stays: the file is where it is removed.
 *
 * The platform's side stays as it is: the app install, the OAuth grant, the paired device
 * are the platform's to revoke, and the last line says where.
 */

import type { Connections } from "../store/connections.ts";
import type { Credentials } from "../store/credentials.ts";

/** Where each service's side of a grant is revoked, as its owner finds it. */
const REVOKE_AT: Record<string, string> = {
  slack: "in the workspace's installed apps (Settings → Manage apps)",
  google: "in the account's third-party access (myaccount.google.com/connections)",
  microsoft: "in the account's app permissions (myapps.microsoft.com for a work account, " +
    "account.microsoft.com/privacy/app-access for a personal one)",
  whatsapp: "in the phone's linked devices (WhatsApp → Linked devices)",
  telegram: "in the account's devices (Telegram → Settings → Devices)",
  github: "in the installed GitHub Apps of the org or account, and a member's leg in " +
    "github.com/settings/apps/authorizations",
  mercadopago: "by renewing the application's Access Token on its Credentials page " +
    "(mercadopago.com.ar/developers/panel/app)",
};

export interface RemoveDeps {
  store: Pick<Connections, "connections" | "deleteConnections">;
  creds: Pick<Credentials, "list" | "delete">;
  /** Take `connections.<service>` out of the store's configuration; whether it was
   *  there. Throws, in a sentence, when the file declares it. */
  undeclare: (service: string) => Promise<boolean>;
  /** The services a door grants under (`available`). A vault key outside them is the
   *  harness's own — the media signing key — and no target. */
  services: string[];
}

/** Undo one grant and say what was undone, a line per record. Throws, touching nothing,
 *  when the target names neither a live connection nor a free-standing vault key. */
export async function removeConnection(target: string, deps: RemoveDeps): Promise<string[]> {
  const live = await deps.store.connections();
  const said: string[] = [];
  const row = live.find((r) => `${r.service}:${r.address}` === target);
  if (row) {
    await deps.store.deleteConnections([{ service: row.service, address: row.address }]);
    said.push(`${target} removed — nothing new enters through it; what it brought in stays`);
    const key = row.credentialKey;
    const sharer = key && live.find((r) => r !== row && r.credentialKey === key);
    if (sharer) {
      said.push(`its secret ${key} stays — ${sharer.service}:${sharer.address} uses it too`);
    } else if (key && await deps.creds.delete(key)) {
      said.push(`its secret ${key} is out of the vault`);
    }
    if (!live.some((r) => r !== row && r.service === row.service)) {
      try {
        if (await deps.undeclare(row.service)) {
          said.push(
            `no ${row.service} connection is left — connections.${row.service} is no longer declared`,
          );
        }
      } catch (err) {
        // the file's to remove: its process keeps running until it is
        said.push(err instanceof Error ? err.message : String(err));
      }
    }
    const where = REVOKE_AT[row.service] ?? "there";
    said.push(`${row.service} itself still holds the grant — revoke it ${where} to end it`);
    return said;
  }
  const owner = live.find((r) => r.credentialKey === target);
  if (owner) {
    throw new Error(
      `${target} is the secret of ${owner.service}:${owner.address} — remove the connection`,
    );
  }
  const grant = (key: string) =>
    deps.services.some((s) => key.startsWith(`${s}:`)) &&
    !live.some((r) => r.credentialKey === key);
  if (grant(target) && await deps.creds.delete(target)) return [`${target} is out of the vault`];
  const vault = (await deps.creds.list("")).map((r) => r.key).filter(grant);
  const removable = [...live.map((r) => `${r.service}:${r.address}`), ...vault];
  throw new Error(
    `no connection or grant "${target}" — removable: ${removable.join(" · ") || "(none)"}`,
  );
}
