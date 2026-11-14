/**
 * connect/testing.ts — a sign-in's gate in miniature, for the handlers and polls that ask
 * one (signin.ts). Test-only; nothing in the harness imports it.
 *
 * It keeps the tickets it was given, settles one at its judge, and records every word in
 * `seen`: what was judged, landed, failed, noted and said. `refuse` makes every judge
 * refuse.
 */

import type { TicketRow } from "../store/credentials.ts";
import type { Gate, Who, Word } from "./signin.ts";

export interface Seen {
  judged: { ticket: string; who: Who }[];
  landed: { ticket: string; account: string; missing?: string[] }[];
  failed: { ticket: string; why: string }[];
  said: { ticket: string; word: Word }[];
  noted: Record<string, Record<string, unknown>>;
}

/** A ticket as a test needs one: the rest filled. */
export function ticket(id: string, row: Partial<TicketRow> = {}): TicketRow {
  return {
    ticket: id,
    service: "google",
    key: row.agentId ? `agent:${row.agentId}` : "org",
    extra: {},
    deadline: Date.now() + 60_000,
    ...row,
  };
}

export function fakeGate(
  tickets: TicketRow[],
  opts: { refuse?: string } = {},
): Gate & { seen: Seen } {
  const open = new Map(tickets.map((t) => [t.ticket, t]));
  const seen: Seen = { judged: [], landed: [], failed: [], said: [], noted: {} };
  return {
    seen,
    view: (id) => Promise.resolve(open.get(id) ?? null),
    judge(id, who) {
      const t = open.get(id);
      seen.judged.push({ ticket: id, who });
      if (!t) return Promise.resolve({ refused: "this link was already used" });
      open.delete(id);
      if (opts.refuse) return Promise.resolve({ refused: opts.refuse });
      return Promise.resolve(t.agentId ? { agent: t.agentId } : {});
    },
    landed(id, account, missing) {
      seen.landed.push({ ticket: id, account, ...(missing?.length ? { missing } : {}) });
      return Promise.resolve();
    },
    failed(id, why) {
      open.delete(id);
      seen.failed.push({ ticket: id, why });
      return Promise.resolve();
    },
    note(id, extra) {
      seen.noted[id] = { ...seen.noted[id], ...extra };
      return Promise.resolve();
    },
    say(id, word) {
      seen.said.push({ ticket: id, word });
      return Promise.resolve();
    },
  };
}
