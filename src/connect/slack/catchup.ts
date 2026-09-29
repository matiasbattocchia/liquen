/**
 * connect/slack/catchup.ts — what the workspace said while nobody was listening.
 *
 * Slack keeps no queue for an app that is not connected: an event a socket is not there to
 * take is gone, and an HTTP delivery is retried a few times over a few minutes and then
 * dropped. So a laptop closed for a night, a socket that fell and came back, a restart —
 * each leaves a gap the events never fill. The gap is read back from the history APIs
 * instead, and the log is the cursor: the newest row the log holds for the workspace is
 * where the listening stopped, the newest in a room is where THAT room stopped, and
 * `conversations.history` + `conversations.replies` from there is what was missed. A
 * workspace with no row at all has no gap — nothing was ever heard — and is left alone.
 *
 * The rows are LIVE, the same as the WhatsApp bridge's offline queue: one batch per
 * workspace, stamped with each message's own time, so the attention rules and the boot
 * floor (§2) decide what is owed, and a message already in the log merges on its
 * `external_id` and wakes nobody. What is read is what the events would have carried —
 * the same mapping (`mapMessage`), the same membership mirror — with the workspace's own
 * tokens as the delivery's `authorizations`: the bot's, then every bound user's, so a room
 * the bot is in anchors to the bot and a room only a member is in anchors to the workspace,
 * exactly as its events do. Each user token's room list is that user's membership as the
 * wire holds it now, so the joins and leaves the gap swallowed land here too.
 *
 * Not read back: an edit or a delete of a message that was already in the log (history
 * shows the message as it stands, and the row keeps what it had), replies to a thread whose
 * root is older than the gap (history lists roots only, and a reply moves no root), and
 * reactions. All of it is reachable through `search`, none of it is a wake.
 */

import type { Appender, Reader } from "../../store/log.ts";
import type { Connections } from "../../store/connections.ts";
import type { Draft, MessageEvent } from "../../types.ts";
import { timedFetch } from "../http.ts";
import {
  anchorOf,
  type Authorization,
  mapMessage,
  type SlackWebhookDeps,
  type Store,
} from "./ingest.ts";

/** A token the workspace was connected with: the bot's, or one bound user's (whose
 *  membership it states and whose rooms it reads). */
export interface SlackLeg {
  token: string;
  /** The Slack user the token acts as — the bot user for the bot's. */
  user: string;
  bot: boolean;
  /** The member a user token belongs to (the grant's owner); the bot's has none. */
  owner?: string;
}

export interface SlackCatchUpDeps
  extends Pick<SlackWebhookDeps, "publish" | "media" | "names" | "now"> {
  publish: Appender["publish"];
  /** The log, read: where the listening stopped. */
  read: Reader["read"];
  /** The classifier + mirror seam, as the webhook has it, plus the enrollments a user
   *  token's room list is reconciled against (absent ⇒ joins land, leaves do not). */
  store?: Store & Partial<Pick<Connections, "memberships">>;
  /** Every connected workspace and its tokens, bot first. */
  legs: () => Promise<Map<string, SlackLeg[]>>;
  /** The Slack Web API; default `timedFetch`. */
  api?: typeof fetch;
  onCaughtUp?: (team: string, published: number) => void;
  onError?: (team: string, err: unknown) => void;
}

/** A room as `users.conversations` lists it — only what the mapping needs. */
interface Listed {
  id?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
}

/** A message as the history API returns it: the event's own shape, minus the envelope. */
interface Historic {
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
  latest_reply?: string;
  subtype?: string;
  [k: string]: unknown;
}

/** How many rows back the newest stamp is looked for: rows land in append order and are
 *  stamped in wire order, and the two disagree only inside a burst. */
const NEWEST_REACH = 50;
/** One wait on a 429, as the wire asks; a second refusal is the sweep's failure. */
const RETRY_AFTER_CAP_MS = 60_000;

/** The catch-up over every workspace. `run()` does one sweep (a run that lands while one
 *  is going joins it); `settle()` waits for the one in flight, if any. */
export function createSlackCatchUp(
  deps: SlackCatchUpDeps,
): { run(): Promise<void>; settle(): Promise<void> } {
  const now = deps.now ?? (() => new Date().toISOString());
  const api = deps.api ?? timedFetch;

  /** One Web API call — GET with the query, a 429 waited out once. `ok: false` throws
   *  the error's name, so a token short of a scope is said and not spun on. */
  const call = async <T>(
    token: string,
    method: string,
    params: Record<string, string>,
  ): Promise<T> => {
    const url = `https://slack.com/api/${method}?${new URLSearchParams(params)}`;
    for (let attempt = 0;; attempt++) {
      const res = await api(url, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 429 && attempt === 0) {
        await res.body?.cancel();
        const wait = Math.min(
          Number(res.headers.get("retry-after") ?? 1) * 1000,
          RETRY_AFTER_CAP_MS,
        );
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      const body = await res.json() as T & { ok: boolean; error?: string };
      if (!body.ok) throw new Error(`${method}: ${body.error ?? `HTTP ${res.status}`}`);
      return body;
    }
  };

  /** Every item of a cursor-paged listing. */
  const pages = async <T>(
    token: string,
    method: string,
    params: Record<string, string>,
    field: string,
  ): Promise<T[]> => {
    const out: T[] = [];
    let cursor = "";
    do {
      const body = await call<Record<string, unknown>>(token, method, {
        ...params,
        ...(cursor ? { cursor } : {}),
      });
      out.push(...((body[field] as T[] | undefined) ?? []));
      cursor = (body.response_metadata as { next_cursor?: string } | undefined)?.next_cursor ??
        "";
    } while (cursor);
    return out;
  };

  /** The newest stamp among the last rows a query matches, or undefined for none. */
  const newest = async (where: { connection?: string; conversation?: string }): Promise<
    string | undefined
  > => {
    const rows = await deps.read({
      service: "slack",
      ...where,
      types: ["message"],
      limit: NEWEST_REACH,
    });
    let best: string | undefined;
    for (const r of rows) if (best === undefined || r.ts > best) best = r.ts;
    return best;
  };

  /** A user token's room list IS that member's membership as the wire holds it: the rooms
   *  listed are joined, the enrollments held that are not listed were left. */
  const reconcile = async (team: string, leg: SlackLeg, listed: Set<string>): Promise<void> => {
    if (!deps.store || !leg.owner) return;
    const row = (conversation: string) => ({
      service: "slack",
      connection: team,
      conversation,
      agentId: leg.owner!,
    });
    if (listed.size) await deps.store.upsertMemberships([...listed].map(row));
    if (!deps.store.memberships) return;
    const held = (await deps.store.memberships()).filter((m) =>
      m.service === "slack" && m.connection === team && m.agentId === leg.owner &&
      !m.deletedAt && !listed.has(m.conversation) && m.conversation !== "connect"
    );
    if (held.length) await deps.store.deleteMemberships(held.map((m) => row(m.conversation)));
  };

  const sweepTeam = async (team: string, legs: SlackLeg[]): Promise<number> => {
    // where the listening stopped: the newest row at any of the workspace's anchors
    const anchors = [team, ...legs.filter((l) => l.bot).map((l) => `${team}:${l.user}`)];
    let since: string | undefined;
    for (const a of anchors) {
      const t = await newest({ connection: a });
      if (t !== undefined && (since === undefined || t > since)) since = t;
    }
    if (since === undefined) return 0; // nothing was ever heard here: no gap to fill

    // every room a token is in, with the tokens that are — the delivery's `authorizations`
    const rooms = new Map<string, { type: string; auths: Authorization[]; token: string }>();
    for (const leg of [...legs].sort((a, b) => Number(b.bot) - Number(a.bot))) {
      const listed = await pages<Listed>(leg.token, "users.conversations", {
        types: "public_channel,private_channel,mpim,im",
        exclude_archived: "true",
        limit: "200",
      }, "channels");
      const ids = new Set<string>();
      for (const c of listed) {
        if (!c.id) continue;
        ids.add(c.id);
        const room = rooms.get(c.id) ?? { type: typeOf(c), auths: [], token: leg.token };
        room.auths.push(leg.bot ? { user_id: leg.user, is_bot: true } : { user_id: leg.user });
        rooms.set(c.id, room);
      }
      await reconcile(team, leg, ids);
    }

    const drafts = new Map<string, Draft<MessageEvent>>();
    const keep = (rows: Draft<MessageEvent>[]) => {
      for (const d of rows) drafts.set(d.envelope.external_id ?? crypto.randomUUID(), d);
    };
    for (const [channel, room] of rooms) {
      const anchor = anchorOf(team, room.auths);
      const from = (await newest({ conversation: channel })) ?? since;
      const oldest = (Date.parse(from) / 1000).toFixed(3);
      const one = (m: Historic) =>
        mapMessage(
          // the event's shape: the message with the envelope fields history leaves out
          { ...m, type: "message", channel, channel_type: room.type, event_ts: m.ts } as Parameters<
            typeof mapMessage
          >[0],
          team,
          anchor,
          room.auths,
          deps.store,
          deps.media,
          deps.names,
          { now },
        );
      const history = await pages<Historic>(room.token, "conversations.history", {
        channel,
        oldest,
        limit: "200",
      }, "messages");
      for (const m of history) {
        keep(await one(m));
        // history lists roots only; a thread with replies newer than the gap is read back
        if (!m.ts || !m.reply_count || Number(m.latest_reply ?? 0) <= Number(oldest)) continue;
        const replies = await pages<Historic>(room.token, "conversations.replies", {
          channel,
          ts: m.ts,
          oldest,
          limit: "200",
        }, "messages");
        for (const r of replies) if (r.ts !== m.ts) keep(await one(r));
      }
    }
    if (drafts.size === 0) return 0;
    const stored = await deps.publish([...drafts.values()]);
    return stored.length;
  };

  let inflight: Promise<void> | null = null;
  const sweep = async () => {
    for (const [team, legs] of await deps.legs()) {
      try {
        const published = await sweepTeam(team, legs);
        deps.onCaughtUp?.(team, published);
      } catch (err) {
        deps.onError?.(team, err);
      }
    }
  };
  return {
    run(): Promise<void> {
      inflight ??= sweep().finally(() => (inflight = null));
      return inflight;
    },
    settle: () => inflight ?? Promise.resolve(),
  };
}

/** The `channel_type` an event would carry, from the listing's flags. */
function typeOf(c: Listed): string {
  if (c.is_im) return "im";
  if (c.is_mpim) return "mpim";
  return c.is_private ? "group" : "channel";
}

/** The workspaces and their tokens, read off the vault and the connections map: the
 *  bot's row (`slack:<team>:org`, `extra.bot_user`) and every user grant
 *  (`slack:<team>:<principal>`, the user id on its connection row). */
export function slackLegs(
  rows: { key: string; value: Record<string, string>; extra?: Record<string, unknown> }[],
  connections: { service: string; address: string; agentId?: string; credentialKey?: string }[],
): Map<string, SlackLeg[]> {
  const out = new Map<string, SlackLeg[]>();
  const add = (team: string, leg: SlackLeg) => {
    const legs = out.get(team) ?? [];
    legs.push(leg);
    out.set(team, legs);
  };
  for (const r of rows) {
    const [service, team, principal] = r.key.split(":");
    if (service !== "slack" || !team || !principal || !r.value.token) continue;
    if (team === "app" || team === "socket") continue;
    if (principal === "org") {
      const user = r.extra?.bot_user;
      if (typeof user === "string" && user) add(team, { token: r.value.token, user, bot: true });
      continue;
    }
    const conn = connections.find((c) => c.service === "slack" && c.credentialKey === r.key);
    const user = conn?.address.split(":")[1];
    if (user) add(team, { token: r.value.token, user, bot: false, owner: conn?.agentId });
  }
  return out;
}
