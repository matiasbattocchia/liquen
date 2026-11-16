/**
 * connect/testing.ts — a sign-in's gate in miniature, for the handlers and polls that ask
 * one (signin.ts). Test-only; nothing in the harness imports it.
 *
 * It keeps the tickets it was given, settles one at its judge, and records every word in
 * `seen`: what was judged, landed, failed, noted and said. `refuse` makes every judge
 * refuse. A page flow is asked through `door`, over the vault and the map `pageCtx`
 * keeps in memory.
 */

import type { CredentialRow, TicketRow } from "../store/credentials.ts";
import type { ConnectionRow, MembershipRow } from "../store/connections.ts";
import type { Draft, Event } from "../types.ts";
import type { FlowCtx, Gate, SignInFlow, Who, Word } from "./signin.ts";

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

/** A flow's context over a vault, a map and a log kept in memory. */
export function pageCtx(agents: { agentId: string; phone?: string }[] = []) {
  const vault = new Map<string, CredentialRow>();
  const connections: ConnectionRow[] = [];
  const memberships: MembershipRow[] = [];
  const published: Draft[] = [];
  const declared: string[] = [];
  const ctx = {
    root: "/nowhere/acme",
    edge: { publicUrl: null, port: 8787 },
    creds: {
      put: (row: CredentialRow) => Promise.resolve(void vault.set(row.key, row)),
      get: (key: string) => Promise.resolve(vault.get(key) ?? null),
      list: (prefix: string) =>
        Promise.resolve([...vault.values()].filter((r) => r.key.startsWith(prefix))),
    },
    log: {
      agents: () => Promise.resolve(agents),
      upsertConnections: (rows: ConnectionRow[]) => Promise.resolve(void connections.push(...rows)),
      upsertMemberships: (rows: MembershipRow[]) => Promise.resolve(void memberships.push(...rows)),
      publish: (e: Draft) => {
        published.push(e);
        return Promise.resolve(e as Event);
      },
    },
    declare: (service: string) => Promise.resolve(void declared.push(service)),
  } as unknown as FlowCtx;
  return { ctx, vault, connections, memberships, published, declared };
}

/** A page flow's door, asked as a browser asks it. */
export function door(flow: SignInFlow, ctx: FlowCtx, gate: Gate) {
  const handler = flow.link!.handler(ctx, gate);
  const at = (id: string) => `http://localhost/x/oauth/start?ticket=${id}`;
  return {
    get: (id: string) => handler(new Request(at(id))),
    post: (id: string, fields: Record<string, string>) =>
      handler(
        new Request(at(id), {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams(fields).toString(),
        }),
      ),
  };
}
