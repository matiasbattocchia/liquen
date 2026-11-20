/**
 * connect/self.ts — an account connected for its chat with itself alone (§4).
 *
 * `liquen connect <service> --self` marks an owned account's row `extra.self_only`: its
 * owner steers the agent from the account's chat with itself, and nothing else on it is
 * the agent's. The log's frontier gate refuses a line on such an account anywhere else.
 * An ingest publishes through `keptToSelf`, which leaves those lines out before the gate
 * is asked, by the same rows: the account's mark, and the `aliases` view's self row. So
 * what the wire says elsewhere on the account lands nowhere, and an ingest that tries a
 * refused publish again never meets a refusal it would try for ever. Such an account
 * imports no history.
 */

import { type AliasRow, type Connections, exempt, selfOnly } from "../store/connections.ts";
import type { Draft } from "../types.ts";

type Store = Pick<Connections, "connection" | "aliases">;

/** The services whose sign-in keeps an account to its chat with itself: an account on them
 *  that an agent owns has one, its owner's mind surface. */
export const SELF_SERVICES = ["telegram", "whatsapp"];

/** The refusal of a shared account asked to be kept to its chat with itself. */
export function noSelfShared(): Error {
  return new Error(
    "--self keeps an account to its owner's chat with itself, and a shared " +
      "account has no owner",
  );
}

/** Why a sign-in may not keep its account to its chat with itself, or undefined when it
 *  may. */
export function selfRefused(ask: { service: string; agent?: string }): Error | undefined {
  if (!SELF_SERVICES.includes(ask.service)) {
    return new Error(
      `${ask.service} keeps no account to its chat with itself: ` +
        `${SELF_SERVICES.join(" and ")} do`,
    );
  }
  if (!ask.agent) return noSelfShared();
  return undefined;
}

/** The account's chat with itself among the mind surfaces: the one its owner faces. */
export function selfChatOf(
  surfaces: AliasRow[],
  service: string,
  connection: string,
): string | undefined {
  return surfaces.find((a) =>
    a.service === service && a.connection === connection && a.principal === a.agentId
  )?.conversation;
}

/** The drafts the gate takes, by the account each is on. */
export async function onSelf<D extends Draft>(drafts: D[], store: Store): Promise<D[]> {
  const only = new Map<string, boolean>();
  let surfaces: AliasRow[] | undefined;
  const kept: D[] = [];
  for (const d of drafts) {
    const { service, connection_address: address, conversation } = d.envelope;
    const key = `${service}\n${address}`;
    if (service !== "local" && !only.has(key)) {
      only.set(key, selfOnly(await store.connection(service, address)));
    }
    if (!only.get(key) || exempt(d)) {
      kept.push(d);
      continue;
    }
    surfaces ??= await store.aliases();
    if (selfChatOf(surfaces, service, address) === conversation.address) kept.push(d);
  }
  return kept;
}

/** `publish`, taking only the drafts the gate takes. A single draft left out answers null,
 *  a batch the drafts that landed. */
// deno-lint-ignore no-explicit-any
export function keptToSelf<P extends (one: any, ...rest: any[]) => Promise<unknown>>(
  publish: P,
  store: Store,
): P {
  return (async (one: Draft | Draft[], ...rest: unknown[]) => {
    const drafts = Array.isArray(one) ? one : [one];
    const kept = await onSelf(drafts, store);
    if (kept.length === drafts.length) return publish(one, ...rest);
    if (!Array.isArray(one)) return null;
    return kept.length ? publish(kept, ...rest) : [];
  }) as unknown as P;
}
