/**
 * connect/microsoft/rooms.ts — the rooms port, Teams' (§9): the member's chats and the
 * channels of their teams, opened and changed through Graph as the member.
 *
 * Every leg acts on the account's own grant (`microsoft:<upn>`, the token the dispatcher
 * posts with), so a room is opened by the grant that speaks in it, and what a leg may do
 * is what that grant consented to. Graph answers a call short of its permission with a
 * 403 and does not always name the one it wanted, so the leg's refusal names the
 * permission the leg needs; the account signs in again to grant it, and the channel
 * permissions are a tenant admin's to consent to.
 *
 * A chat is a roster Teams keeps: a oneOnOne is the one chat of two people, found or made
 * (`POST /chats`), so an unnamed list is one person, and a longer list is refused — a
 * group chat is made anew on every call and is named by its topic, so it is what a
 * named `group` opens, its topic the name. A `channel` lives in a team, so its name is
 * `Team / Channel`: the team one the member is in, found by its name, the channel made
 * standard in it — its people are the team's, so the list opens it and reaches those of
 * them in the team. `members` answers user ids with the names Teams shows; `leave`,
 * `add` and `remove` are the membership legs of a chat or of a private channel (a
 * standard channel's roster is its team's, and Graph refuses there); `rename` is the
 * chat's topic or the channel's display name. Nobody joins a chat or a channel by
 * their own hand on Teams, so there is no `join`. A person added to a chat sees its
 * whole history.
 *
 * The port says nothing in the room: a chat made, a member added, a topic changed are
 * lines Teams posts itself, and the ingest brings them back.
 */

import type { RoomsPort } from "../../xi.ts";
import type { Credentials } from "../../store/credentials.ts";
import type { GrantBroker } from "../../proxy/grants.ts";
import { DispatchError } from "../errors.ts";
import { timedFetch } from "../http.ts";
import { GRAPH, placeOf } from "./teams.ts";

export interface TeamsRoomsDeps {
  broker: Pick<GrantBroker, "issue" | "accessTokenFor">;
  /** The grant rows — a leg reads the account's own user id (`extra.oid`) off its row. */
  creds: Pick<Credentials, "get">;
  /** Every Graph call goes through this — bounded by `API_TIMEOUT_MS` unless injected. */
  fetch?: typeof fetch;
}

const GRANT_PREFIX = "microsoft:";
/** A chat's topic as Graph takes one: no `:`, 250 at most. */
export function teamsTopic(name: string): string {
  return name.replace(/:/g, " ").replace(/\s+/g, " ").trim().slice(0, 250);
}
/** A channel's display name as Graph takes one: fifty at most, none of the characters
 *  Teams keeps out of one, not opening with `_` or `.`. */
export function teamsChannelName(name: string): string {
  return name.replace(/[~#%&*{}+/\\:<>?|'"]+/g, " ").replace(/\s+/g, " ").trim()
    .replace(/^[_.]+/, "").slice(0, 50).trim();
}
/** The history a member added to a chat is shown: all of it. */
const WHOLE_HISTORY = "0001-01-01T00:00:00Z";

interface Member {
  id: string;
  userId?: string;
  displayName?: string | null;
}

/** The legs over one grant broker. */
export function teamsRooms(deps: TeamsRoomsDeps): RoomsPort {
  const fetchApi = deps.fetch ?? timedFetch;

  /** The account as a caller: its token and its own user id. */
  const as = async (connection: string) => {
    const key = `${GRANT_PREFIX}${connection}`;
    const token = await deps.broker.accessTokenFor(deps.broker.issue(key));
    if (!token) throw new DispatchError(`no access token for ${key}`, 401);
    const self = (await deps.creds.get(key))?.extra?.oid;
    if (typeof self !== "string") throw new DispatchError(`${key} carries no user id`, 401);
    const call = async (what: string, needs: string, url: string, init: RequestInit = {}) => {
      const res = await fetchApi(url, {
        ...init,
        headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
      if (res.ok) return res;
      const body = (await res.text()).slice(0, 300);
      throw new DispatchError(
        res.status === 403
          ? `${what}: the grant lacks ${needs}; it gains the permission by signing in again — ${body}`
          : `${what}: HTTP ${res.status} ${body}`,
        res.status,
      );
    };
    const json = (method: string, body: unknown): RequestInit => ({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const page = async <T>(what: string, needs: string, url: string): Promise<T[]> => {
      const out: T[] = [];
      let next: string | undefined = url;
      while (next) {
        const res = await call(what, needs, next);
        const got = await res.json() as { value?: T[]; "@odata.nextLink"?: string };
        out.push(...(got.value ?? []));
        next = got["@odata.nextLink"];
      }
      return out;
    };
    return { self, call, json, page };
  };
  type Caller = Awaited<ReturnType<typeof as>>;

  const user = (id: string, roles: string[], history = false) => ({
    "@odata.type": "#microsoft.graph.aadUserConversationMember",
    roles,
    "user@odata.bind": `${GRAPH}/users('${id}')`,
    ...(history ? { visibleHistoryStartDateTime: WHOLE_HISTORY } : {}),
  });

  /** A room's roster, membership ids included — what `remove` and `leave` delete by. */
  const roster = (g: Caller, conversation: string): Promise<Member[]> => {
    const p = placeOf(conversation);
    return p.kind === "chat"
      ? g.page<Member>("chat members", "Chat.ReadWrite", `${GRAPH}/chats/${enc(p.chat)}/members`)
      : g.page<Member>(
        "channel members",
        "ChannelMember.ReadWrite.All",
        `${GRAPH}/teams/${enc(p.team)}/channels/${enc(p.channel)}/members`,
      );
  };
  const membership = (g: Caller, conversation: string, ids: string[]): Promise<void> =>
    roster(g, conversation).then(async (people) => {
      const p = placeOf(conversation);
      for (const id of ids) {
        const m = people.find((x) => x.userId === id);
        if (!m) throw new DispatchError(`${id} is not in the room`, 404);
        await (p.kind === "chat"
          ? g.call(
            "chat remove",
            "ChatMember.ReadWrite",
            `${GRAPH}/chats/${enc(p.chat)}/members/${enc(m.id)}`,
            { method: "DELETE" },
          )
          : g.call(
            "channel remove",
            "ChannelMember.ReadWrite.All",
            `${GRAPH}/teams/${enc(p.team)}/channels/${enc(p.channel)}/members/${enc(m.id)}`,
            { method: "DELETE" },
          ));
      }
    });

  return {
    open: async ({ connection, members, name, kind }) => {
      const g = await as(connection);
      const others = [...new Set(members)].filter((m) => m !== g.self);
      if (kind === "direct") {
        if (others.length !== 1) {
          throw new DispatchError(
            "a Teams chat with no name is one to one — name it with `subject` to open a " +
              "group chat with these people",
            400,
          );
        }
        const res = await g.call(
          "chat",
          "Chat.Create",
          `${GRAPH}/chats`,
          g.json("POST", {
            chatType: "oneOnOne",
            members: [user(g.self, ["owner"]), user(others[0], ["owner"])],
          }),
        );
        const chat = await res.json() as { id: string };
        return { address: chat.id, kind };
      }
      if (kind === "group") {
        const topic = teamsTopic(name ?? "");
        const res = await g.call(
          "chat",
          "Chat.Create",
          `${GRAPH}/chats`,
          g.json("POST", {
            chatType: "group",
            topic,
            members: [g.self, ...others].map((id) => user(id, ["owner"])),
          }),
        );
        const chat = await res.json() as { id: string; topic?: string | null };
        return { address: chat.id, kind, name: chat.topic || topic };
      }
      const slash = (name ?? "").lastIndexOf("/");
      const teamName = slash < 0 ? "" : (name ?? "").slice(0, slash).trim();
      if (!teamName) {
        throw new DispatchError(
          "a Teams channel lives in a team — name it `#Team / Channel`, the team one you are in",
          400,
        );
      }
      const teams = await g.page<{ id: string; displayName?: string }>(
        "teams",
        "Team.ReadBasic.All",
        `${GRAPH}/me/joinedTeams`,
      );
      const want = teamName.toLowerCase();
      const team = teams.find((t) => (t.displayName ?? "").toLowerCase() === want);
      if (!team) {
        throw new DispatchError(`no team named "${teamName}" among the ones you are in`, 404);
      }
      const res = await g.call(
        "channel",
        "Channel.Create",
        `${GRAPH}/teams/${enc(team.id)}/channels`,
        g.json("POST", {
          displayName: teamsChannelName((name ?? "").slice(slash + 1)),
          membershipType: "standard",
        }),
      );
      const channel = await res.json() as { id: string; displayName?: string };
      return {
        address: `${team.id}/${channel.id}`,
        kind,
        name: [team.displayName, channel.displayName].filter(Boolean).join(" / "),
      };
    },
    members: async ({ connection, conversation }) => {
      const g = await as(connection);
      return (await roster(g, conversation))
        .filter((m): m is Member & { userId: string } => typeof m.userId === "string")
        .map((
          m,
        ) => (m.displayName ? { address: m.userId, name: m.displayName } : { address: m.userId }));
    },
    leave: async ({ connection, conversation }) => {
      const g = await as(connection);
      await membership(g, conversation, [g.self]);
    },
    add: async ({ connection, conversation, members }) => {
      const g = await as(connection);
      const p = placeOf(conversation);
      for (const id of members) {
        await (p.kind === "chat"
          ? g.call(
            "chat add",
            "ChatMember.ReadWrite",
            `${GRAPH}/chats/${enc(p.chat)}/members`,
            g.json("POST", user(id, ["owner"], true)),
          )
          : g.call(
            "channel add",
            "ChannelMember.ReadWrite.All",
            `${GRAPH}/teams/${enc(p.team)}/channels/${enc(p.channel)}/members`,
            g.json("POST", user(id, [])),
          ));
      }
    },
    remove: async ({ connection, conversation, members }) => {
      await membership(await as(connection), conversation, members);
    },
    rename: async ({ connection, conversation, name }) => {
      const g = await as(connection);
      const p = placeOf(conversation);
      await (p.kind === "chat"
        ? g.call(
          "chat rename",
          "Chat.ReadWrite",
          `${GRAPH}/chats/${enc(p.chat)}`,
          g.json("PATCH", { topic: teamsTopic(name) }),
        )
        : g.call(
          "channel rename",
          "ChannelSettings.ReadWrite.All",
          `${GRAPH}/teams/${enc(p.team)}/channels/${enc(p.channel)}`,
          g.json("PATCH", { displayName: teamsChannelName(name) }),
        ));
    },
  };
}

const enc = encodeURIComponent;
