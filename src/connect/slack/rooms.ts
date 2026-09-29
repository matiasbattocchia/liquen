/**
 * connect/slack/rooms.ts — the rooms port, Slack's (§9): the workspace's conversations,
 * opened and changed through `conversations.*` as the acting agent on the account.
 *
 * Every leg resolves its token the way the dispatcher does (`slackTokenFor`): the agent's
 * own grant when the vault holds one, else the workspace bot — so a room is opened by the
 * grant that posts in it, and what a leg may do is what that grant consented to. Slack
 * answers a call short of its scope with `missing_scope` and names the scope it needed;
 * the leg's refusal carries that name, and the account signs in again to grant it.
 *
 * The wire's own rules stay the wire's: a direct room (`conversations.open`) holds up to
 * eight besides the opener, a channel's name is lowercase words joined by `-` or `_` and
 * at most eighty long, `#general` lets nobody go — each is Slack's answer, passed through.
 * A kick takes one person a call; the rest is one call each. The port says nothing in
 * the room: the join, the invite, the rename are lines Slack posts itself, and the ingest
 * brings them back.
 */

import type { RoomsPort } from "../../xi.ts";
import { DispatchError } from "../errors.ts";
import { timedFetch } from "../http.ts";
import { slackErrorCode } from "./dispatch.ts";

export interface SlackRoomsDeps {
  /** Which grant acts for the agent on the workspace — the dispatcher's own resolver. */
  tokenFor: (connection: string, author?: string) => Promise<string>;
  /** Every API call goes through this — bounded by `API_TIMEOUT_MS` unless injected. */
  fetch?: typeof fetch;
}

/** A channel name as Slack takes one: lowercase, the separators `-` and `_` kept, a run of
 *  anything else (a space, a `#`, an accent) folded to one `-`, eighty at most. */
export function slackChannelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

interface Answer {
  ok?: boolean;
  error?: string;
  needed?: string;
}

/** The seven legs over one token resolver. */
export function slackRooms(deps: SlackRoomsDeps): RoomsPort {
  const fetchApi = deps.fetch ?? timedFetch;
  const { tokenFor } = deps;

  // one form-encoded Web-API call, as the dispatcher makes them
  const api = async <T extends Answer>(
    method: string,
    token: string,
    params: Record<string, string>,
  ): Promise<T> => {
    const res = await fetchApi(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: new URLSearchParams(params),
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new DispatchError(`${method}: HTTP ${res.status}`, res.status);
    }
    const out = await res.json() as T;
    if (!out.ok) {
      const why = out.error === "missing_scope" && out.needed
        ? `missing_scope — the grant lacks ${out.needed}; it gains the scope by signing in again`
        : out.error;
      throw new DispatchError(`${method}: ${why}`, slackErrorCode(out.error));
    }
    return out;
  };

  type Channel = { id: string; name?: string };

  return {
    open: async ({ connection, agent, members, name, kind }) => {
      const token = await tokenFor(connection, agent);
      if (kind === "direct") {
        const out = await api<Answer & { channel: Channel }>("conversations.open", token, {
          users: members.join(","),
        });
        return { address: out.channel.id, kind };
      }
      const made = await api<Answer & { channel: Channel }>("conversations.create", token, {
        name: slackChannelName(name ?? ""),
        is_private: String(kind === "group"),
      });
      if (members.length > 0) {
        await api("conversations.invite", token, {
          channel: made.channel.id,
          users: members.join(","),
        });
      }
      return {
        address: made.channel.id,
        kind,
        ...(made.channel.name !== undefined ? { name: made.channel.name } : {}),
      };
    },
    members: async ({ connection, agent, conversation }) => {
      const token = await tokenFor(connection, agent);
      const out: { address: string }[] = [];
      let cursor: string | undefined;
      do {
        const page = await api<
          Answer & { members?: string[]; response_metadata?: { next_cursor?: string } }
        >("conversations.members", token, {
          channel: conversation,
          limit: "200",
          ...(cursor ? { cursor } : {}),
        });
        for (const address of page.members ?? []) out.push({ address });
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return out;
    },
    join: async ({ connection, agent, conversation }) => {
      await api("conversations.join", await tokenFor(connection, agent), {
        channel: conversation,
      });
    },
    leave: async ({ connection, agent, conversation }) => {
      await api("conversations.leave", await tokenFor(connection, agent), {
        channel: conversation,
      });
    },
    add: async ({ connection, agent, conversation, members }) => {
      await api("conversations.invite", await tokenFor(connection, agent), {
        channel: conversation,
        users: members.join(","),
      });
    },
    remove: async ({ connection, agent, conversation, members }) => {
      const token = await tokenFor(connection, agent);
      for (const user of members) {
        await api("conversations.kick", token, { channel: conversation, user });
      }
    },
    rename: async ({ connection, agent, conversation, name }) => {
      await api("conversations.rename", await tokenFor(connection, agent), {
        channel: conversation,
        name: slackChannelName(name),
      });
    },
  };
}
