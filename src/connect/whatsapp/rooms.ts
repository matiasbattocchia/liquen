/**
 * connect/whatsapp/rooms.ts — the rooms port, whatsapp's (§9): the account's groups, opened
 * and changed through the bridge's `/groups` routes on the session the dispatcher posts
 * with.
 *
 * WhatsApp has one kind of room the account makes: the group, named at birth and found by
 * nothing but its address. A direct chat is the person's number and needs no opening, so
 * one person unnamed answers their address without a call; a list of two or more with no
 * name has no room of its own here and is refused with the way to name one; `#name` is
 * refused too, since there is no channel to make. No `join`: a WhatsApp group is entered
 * by invite, which no room address carries.
 *
 * Every leg is the bridge's own answer: 4xx is WhatsApp's refusal for these bytes — the
 * account no admin of the group, a person not in it, a subject it will not take — 5xx the
 * bridge or the network. A seat the server would not fill on `add` fails the call naming
 * each person; on `open` the group exists regardless and the roster says who is in it.
 * The port says nothing in the group: the subject, the joins and the leaves are lines
 * WhatsApp writes itself, and the ingest brings back what the bridge posts of them.
 */

import type { RoomsPort } from "../../xi.ts";
import { DispatchError } from "../errors.ts";
import { timedFetch } from "../http.ts";

/** A seat on the roster as the bridge answers it. */
interface Seat {
  address: string;
  name?: string;
  admin?: boolean;
}

/** Bind the port to a bridge: `base` is `connections.whatsapp.bridgeUrl`, `token` the
 *  shared `WA_BRIDGE_TOKEN`. */
export function whatsappRooms(
  base: string,
  token: string,
  fetchApi: typeof fetch = timedFetch,
): RoomsPort {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const call = async <T>(what: string, path: string, init: RequestInit = {}): Promise<T> => {
    const res = await fetchApi(`${base}${path}`, { ...init, headers });
    if (!res.ok) {
      const reason = (await res.text()).slice(0, 256).trim();
      throw new DispatchError(`bridge ${what} HTTP ${res.status}: ${reason}`, res.status);
    }
    return await res.json() as T;
  };
  const group = (connection: string, conversation: string) =>
    `/groups/${encodeURIComponent(connection)}/${encodeURIComponent(conversation)}`;
  const withMembers = (members: string[]) => ({ body: JSON.stringify({ members }) });

  return {
    open: async ({ connection, members, name, kind }) => {
      if (kind === "direct") {
        const others = [...new Set(members)].filter((m) => m !== connection);
        if (others.length !== 1) {
          throw new DispatchError(
            "a WhatsApp chat with no name is one to one — name it with `subject` to open a " +
              "group with everyone in it",
            400,
          );
        }
        return { address: others[0], kind };
      }
      if (kind === "channel") {
        throw new DispatchError(
          "WhatsApp has groups only — name it without the `#` to open a group",
          400,
        );
      }
      const made = await call<{ address: string; name?: string }>(
        "groups",
        `/groups/${encodeURIComponent(connection)}`,
        { method: "POST", body: JSON.stringify({ name: name ?? "", members }) },
      );
      return { address: made.address, kind, ...(made.name ? { name: made.name } : {}) };
    },
    members: async ({ connection, conversation }) => {
      const out = await call<{ members?: Seat[] }>("groups", group(connection, conversation));
      return (out.members ?? []).map((s) => ({
        address: s.address,
        ...(s.name ? { name: s.name } : {}),
      }));
    },
    leave: async ({ connection, conversation }) => {
      await call("groups", group(connection, conversation), { method: "DELETE" });
    },
    add: async ({ connection, conversation, members }) => {
      await call("groups", `${group(connection, conversation)}/members`, {
        method: "POST",
        ...withMembers(members),
      });
    },
    remove: async ({ connection, conversation, members }) => {
      await call("groups", `${group(connection, conversation)}/members`, {
        method: "DELETE",
        ...withMembers(members),
      });
    },
    rename: async ({ connection, conversation, name }) => {
      await call("groups", group(connection, conversation), {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
    },
  };
}
