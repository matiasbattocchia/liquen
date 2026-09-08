/**
 * connect/dispatcher.ts — the DISPATCH loop every connector runs: log → world.
 *
 * A dispatcher subscribes to the log, picks the agent's OUTBOUND rows on its service,
 * posts each one in publish order, and stamps the row with what the wire answered —
 * `external_id` (the echo-reconciliation key, §4), the wire's own name for our side, and
 * `state: dispatched` with its `dispatched_at`. A post that throws stamps `failed`
 * (`failedStatus`, §5): the row IS the agent's only sign that a queued send never left, so
 * no failure is allowed to vanish. The retry is not this loop's: the sweeper
 * (`store/sweep.ts`) moves a transiently failed row back to `queued`, and it arrives here
 * through the update stream as one more offer — the same offer, in another process, when
 * the connector lives there.
 *
 * An offer is a `queued` row: born so by the store when an agent's message is bound for a
 * wire, made so again by the sweeper. The dispatcher opens by reading its service's
 * `queued` rows — every offer made while no process was there to take it — and then rides
 * the stream for the rest; a row can arrive by both roads, so an offer (the row plus its
 * `queued_at`) is posted once per process however often it is seen.
 *
 * What differs per wire is injected: `select` maps a row to the service's send shape (or
 * null — nothing to send), `post` puts it on the wire and answers with what to stamp.
 */

import { failedStatus } from "./errors.ts";
import type { DeliveryPatch, Reader, Subscriber } from "../store/log.ts";
import type { Event, EventId, MessageEvent, Service } from "../types.ts";

/** What a post answers with: the wire's id for the artifact (`id`, what `onSent` reports),
 *  the log's key for it (`external_id`, service-prefixed the way the ingest stamps it),
 *  and the wire naming its own side in the send response (`sender`, §4). A post that
 *  creates no artifact of its own (a reaction, an edit) answers `{}`. */
export interface Posted {
  id?: string;
  external_id?: string;
  sender?: DeliveryPatch["sender"];
}

export interface DispatcherDeps<W> {
  subscribe: Subscriber["subscribe"];
  /** The opening read: the service's `queued` rows, offers made before this process was
   *  there to take them. */
  read: Reader["read"];
  /** Routing reads `envelope.service` (§3). */
  service: Service;
  /** The service's send shape for an outbound row; null = nothing to send (unaddressable,
   *  empty). Runs synchronously as the row arrives, before the post is queued. */
  select: (event: MessageEvent) => W | null;
  /** Put one send on the wire. Throws to fail the send — `DispatchError` carries the class. */
  post: (work: W, event: MessageEvent) => Promise<Posted>;
  setDelivery?: (id: EventId, patch: DeliveryPatch) => Promise<void>;
  onError?: (event: MessageEvent, err: unknown) => void;
  onSent?: (event: MessageEvent, id: string | undefined) => void;
}

/** OURS and offered (§3, §4): `agent` present AND no `external_id` at insert — the
 *  classifier stamps `agent.id` on the principal's inbound rows too, and those always
 *  arrive carrying a platform id, so they never re-dispatch — AND standing `queued`: a
 *  `dispatched` row is on the wire even when the post minted no artifact (a reaction), and
 *  a `failed` one waits for the sweeper's re-offer. */
export function isOutbound(e: Event, service: Service): boolean {
  return e.type === "message" &&
    e.agent !== undefined &&
    e.envelope.external_id === undefined &&
    e.envelope.service === service &&
    e.envelope.status === "queued";
}

/** Wire dispatch to the log. Posts serialized to preserve order. Returns stop: take no
 *  more work, settle the posts already in flight. */
export function createDispatcher<W>(deps: DispatcherDeps<W>): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  const taken = new Map<EventId, string>(); // row → the offer (`queued_at`) this process posted
  const offered = (e: Event) => {
    const event = e as MessageEvent;
    const offer = event.status?.queued_at ?? "";
    if (taken.get(event.id) === offer) return;
    taken.set(event.id, offer);
    const work = deps.select(event);
    if (work === null) return;
    chain = chain.then(async () => {
      try {
        const posted = await deps.post(work, event);
        await deps.setDelivery?.(event.id, {
          ...(posted.external_id !== undefined ? { external_id: posted.external_id } : {}),
          ...(posted.sender ? { sender: posted.sender } : {}),
          status: { state: "dispatched", dispatched_at: new Date().toISOString() },
        });
        deps.onSent?.(event, posted.id);
      } catch (err) {
        try {
          await deps.setDelivery?.(event.id, { status: failedStatus(err) });
        } catch { /* the stamp failed too — onError still reports */ }
        deps.onError?.(event, err);
      }
    });
  };
  const ours = (e: Event) => isOutbound(e, deps.service);
  // listen first, then read: an offer that lands in between is seen twice and posted once
  const unsub = deps.subscribe(offered, { updates: true, filter: ours });
  const opening = deps.read({ service: deps.service, types: ["message"], state: "queued" })
    .then((rows) => rows.filter(ours).forEach(offered));
  return async () => {
    unsub();
    await opening;
    await chain;
  };
}
