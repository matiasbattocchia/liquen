/**
 * connect/steering.ts — an ingest's publish on an account kept to steering (§4).
 *
 * The log's frontier gate refuses a line on such an account outside its mind surfaces.
 * An ingest publishes through `steered`, which leaves those lines out before the gate is
 * asked, by the same rows: the account's `extra.steering`, and the `aliases` view. So
 * what the wire says elsewhere on the account lands nowhere, and an ingest that tries a
 * refused publish again never meets a refusal it would try for ever.
 */

import { type Connections, exempt, forSteering } from "../store/connections.ts";
import type { Draft } from "../types.ts";

type Store = Pick<Connections, "connection" | "aliases">;

/** The services whose sign-in keeps an account to steering: an account on them that an
 *  agent owns has a chat with itself, its owner's mind surface. */
export const STEERED = ["telegram", "whatsapp"];

/** The refusal of a shared account asked to be kept to steering. */
export function noSteeringShared(): Error {
  return new Error(
    "--steering keeps an account to its owner's mind, and a shared account has no owner",
  );
}

/** Why a sign-in may not keep its account to steering, or undefined when it may. */
export function steeringRefused(ask: { service: string; agent?: string }): Error | undefined {
  if (!STEERED.includes(ask.service)) {
    return new Error(`${ask.service} keeps no account to steering: ${STEERED.join(" and ")} do`);
  }
  if (!ask.agent) return noSteeringShared();
  return undefined;
}

/** The drafts the gate takes, by the account each is on. */
export async function onSurfaces<D extends Draft>(drafts: D[], store: Store): Promise<D[]> {
  const steering = new Map<string, boolean>();
  let surfaces: Awaited<ReturnType<Store["aliases"]>> | undefined;
  const kept: D[] = [];
  for (const d of drafts) {
    const { service, connection_address: address, conversation } = d.envelope;
    const key = `${service}\n${address}`;
    if (service !== "local" && !steering.has(key)) {
      steering.set(key, forSteering(await store.connection(service, address)));
    }
    if (!steering.get(key) || exempt(d)) {
      kept.push(d);
      continue;
    }
    surfaces ??= await store.aliases();
    if (
      surfaces.some((a) =>
        a.service === service && a.connection === address &&
        a.conversation === conversation.address
      )
    ) {
      kept.push(d);
    }
  }
  return kept;
}

/** `publish`, taking only the drafts the gate takes. A single draft left out answers null,
 *  a batch the drafts that landed. */
// deno-lint-ignore no-explicit-any
export function steered<P extends (one: any, ...rest: any[]) => Promise<unknown>>(
  publish: P,
  store: Store,
): P {
  return (async (one: Draft | Draft[], ...rest: unknown[]) => {
    const drafts = Array.isArray(one) ? one : [one];
    const kept = await onSurfaces(drafts, store);
    if (kept.length === drafts.length) return publish(one, ...rest);
    if (!Array.isArray(one)) return null;
    return kept.length ? publish(kept, ...rest) : [];
  }) as unknown as P;
}
