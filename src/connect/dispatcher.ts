/**
 * connect/dispatcher.ts — the DISPATCH loop every connector runs: log → world.
 *
 * A dispatcher subscribes to the log, picks the agent's OUTBOUND rows on its service,
 * posts each one in publish order, and stamps the row with what the wire answered —
 * `external_id` (the echo-reconciliation key, §4), the wire's own name for our side, and
 * `dispatched_at`. A post that throws stamps `failed` (`failedStatus`, §5): the row IS the
 * agent's only sign that a queued send never left, so no failure is allowed to vanish.
 * No retry loop lives here (the scheduler's job, PROJECT #10); `error_code` is the class
 * a retrier reads off the log.
 *
 * What differs per wire is injected: `select` maps a row to the service's send shape (or
 * null — nothing to send), `post` puts it on the wire and answers with what to stamp.
 */

import { failedStatus } from "./errors.ts";
import type { DeliveryPatch, Subscriber } from "../store/log.ts";
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
  /** Routing reads `envelope.service` (§3). */
  service: Service;
  /** The service's send shape for an outbound row; null = nothing to send (unaddressable,
   *  empty). Runs synchronously as the row arrives, before the post is queued. */
  select: (event: MessageEvent) => W | null;
  /** Put one send on the wire. Throws to fail the send — `DispatchError` carries the class. */
  post: (work: W, event: MessageEvent) => Promise<Posted>;
  setDelivery?: (id: EventId, patch: DeliveryPatch) => Promise<void>;
  from?: EventId;
  onError?: (event: MessageEvent, err: unknown) => void;
  onSent?: (event: MessageEvent, id: string | undefined) => void;
}

/** OURS and not yet on the wire (§3, §4): `agent` present AND no `external_id` at insert —
 *  the classifier stamps `agent.id` on the principal's inbound rows too, and those always
 *  arrive carrying a platform id, so they never re-dispatch. */
export function isOutbound(e: Event, service: Service): boolean {
  return e.type === "message" &&
    e.agent !== undefined &&
    e.envelope.external_id === undefined &&
    e.envelope.service === service;
}

/** Wire dispatch to the log. Posts serialized to preserve order. Returns stop: take no
 *  more work, settle the posts already in flight. */
export function createDispatcher<W>(deps: DispatcherDeps<W>): () => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  const unsub = deps.subscribe(
    (e) => {
      const event = e as MessageEvent;
      const work = deps.select(event);
      if (work === null) return;
      chain = chain.then(async () => {
        try {
          const posted = await deps.post(work, event);
          await deps.setDelivery?.(event.id, {
            ...(posted.external_id !== undefined ? { external_id: posted.external_id } : {}),
            ...(posted.sender ? { sender: posted.sender } : {}),
            status: { dispatched_at: new Date().toISOString() },
          });
          deps.onSent?.(event, posted.id);
        } catch (err) {
          try {
            await deps.setDelivery?.(event.id, { status: failedStatus(err) });
          } catch { /* the stamp failed too — onError still reports */ }
          deps.onError?.(event, err);
        }
      });
    },
    { from: deps.from, filter: (e) => isOutbound(e, deps.service) },
  );
  return async () => {
    unsub();
    await chain;
  };
}
