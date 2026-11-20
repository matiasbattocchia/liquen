import { assertEquals } from "@std/assert";
import type { AliasRow } from "../store/connections.ts";
import type { Event, MessageEvent } from "../types.ts";
import type { ReadQuery } from "../store/log.ts";
import { heardUntil, historySince } from "./history.ts";

const AT = "2026-11-20T12:00:00.000Z";

Deno.test("historySince: from where the listening stopped, never further back than the window", () => {
  assertEquals(historySince(AT, 60), "2026-09-21T12:00:00.000Z");
  assertEquals(historySince(AT, 60, "2026-11-18T09:30:00Z"), "2026-11-18T09:30:00.000Z");
  assertEquals(historySince(AT, 2, "2026-11-01T00:00:00Z"), "2026-11-18T12:00:00.000Z");
});

/** A log of rows on one WhatsApp number, newest last, read the way the store reads: the
 *  bound and the filter first, then the newest `limit`. */
function logOf(rows: MessageEvent[], surfaces: AliasRow[] = []) {
  const asked: ReadQuery[] = [];
  return {
    asked,
    aliases: () => Promise.resolve(surfaces),
    read: (q: ReadQuery = {}) => {
      asked.push(q);
      const kept = rows.filter((e) =>
        e.envelope.service === q.service && e.envelope.connection_address === q.connection &&
        (q.before === undefined || Date.parse(e.ts) < Date.parse(q.before)) &&
        (q.copies !== false || !e.extra?.via) && (!q.filter || q.filter(e as Event))
      );
      return Promise.resolve(kept.slice(-(q.limit ?? kept.length)) as Event[]);
    },
  };
}

const row = (id: string, ts: string, chat: string, over: Partial<MessageEvent> = {}) =>
  ({
    id,
    ts,
    type: "message",
    envelope: {
      service: "whatsapp",
      connection_address: "549",
      conversation: { address: chat },
    },
    parts: [{ type: "text", kind: "text", text: id }],
    ...over,
  }) as MessageEvent;

Deno.test("heardUntil: the newest line the wire brought, not one that lands whether it is up or not", async () => {
  const log = logOf(
    [
      row("1", "2026-11-17T10:00:00Z", "5491100000001"), // the last line the wire brought
      // what lands with the wire down: an agent's send, the mirror's copy, the door's note,
      // imported history, and the account's chat with itself
      row("2", "2026-11-18T10:00:00Z", "5491100000001", {
        agent: { id: "matias", session_id: "mind" },
      }),
      row("3", "2026-11-18T11:00:00Z", "5491100000002", { extra: { via: { event: "x" } } }),
      row("4", "2026-11-18T12:00:00Z", "connect"),
      row("5", "2026-11-18T13:00:00Z", "5491100000003", { extra: { backfill: true } }),
      row("6", "2026-11-19T09:00:00Z", "549"),
      // after the sign-in: the new session's own
      row("7", "2026-11-20T12:05:00Z", "5491100000001"),
    ],
    [{
      service: "whatsapp",
      connection: "549",
      conversation: "549",
      agentId: "matias",
      principal: "matias",
      live: true,
    }],
  );
  assertEquals(await heardUntil(log, "whatsapp", "549", AT), "2026-11-17T10:00:00Z");
  assertEquals(log.asked[0].limit, 1);
  assertEquals(await heardUntil(logOf([]), "whatsapp", "549", AT), undefined);
});
