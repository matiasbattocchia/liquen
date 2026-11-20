/**
 * connect/history.ts — how far back a sign-in's history import reaches (§4).
 *
 * A sign-in imports what the log is missing of the account and no more: from where the
 * listening stopped, never further back than the connection's `historyDays`. Where it
 * stopped is the log's own record, the newest line the wire brought before the sign-in.
 * Rows that land whether or not the wire is up say nothing of it: imported history, a copy
 * the mirror wrote, an agent's send, a door's note. Neither does the account's own mind
 * surfaces: an account kept to its chat with itself goes on hearing that chat while the
 * rest of it goes unheard, so the chat tells nothing of where the rest stopped.
 */

import { type Connections, GRANT_NOTES } from "../store/connections.ts";
import type { Reader } from "../store/log.ts";

const DAY_MS = 24 * 60 * 60_000;

/** When the wire last brought a line of the account, before `before`; undefined when the
 *  log holds none. */
export async function heardUntil(
  log: Pick<Reader, "read"> & Pick<Connections, "aliases">,
  service: string,
  connection: string,
  before: string,
): Promise<string | undefined> {
  const surfaces = new Set(
    (await log.aliases())
      .filter((a) => a.service === service && a.connection === connection)
      .map((a) => a.conversation),
  );
  const [last] = await log.read({
    service,
    connection,
    before,
    types: ["message"],
    copies: false,
    filter: (e) => {
      const where = e.envelope.conversation.address;
      return where !== GRANT_NOTES && !surfaces.has(where) && e.extra?.backfill !== true &&
        !e.agent?.session_id;
    },
    limit: 1,
  });
  return last?.ts;
}

/** The start of what a sign-in at `at` imports: where the listening stopped, or `days`
 *  before the sign-in, whichever is later. */
export function historySince(at: string, days: number, heard?: string): string {
  const floor = Date.parse(at) - days * DAY_MS;
  const last = heard === undefined ? NaN : Date.parse(heard);
  return new Date(last > floor ? last : floor).toISOString();
}
