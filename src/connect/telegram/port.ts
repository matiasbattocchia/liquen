/**
 * connect/telegram/port.ts — the address book and the rooms, telegram's ports (§9), and
 * the socket they cross.
 *
 * An account's session is one connection, and the connector's process holds it: a second
 * client on the same session costs the account the session. So main's ports hold no
 * session of their own. They ask the connector, over a Unix socket under the org's own
 * folder, `data/run/telegram.port.sock`. A service's name takes letters, digits and
 * dashes, so the dot keeps the path out of the edge's grammar: nothing the internet dials
 * reaches it, and the file opens for its owner alone, as main's own socket does.
 *
 * `servePort` is the connector's side: one `POST /<leg>` per call, the request's JSON in
 * and the answer's JSON out, a refusal as its HTTP class with Telegram's words. The two
 * factories are main's side, the same legs as `ContactPort` and `RoomsPort`. Each leg
 * answers within its call and keeps no queue: the tool result is the outcome.
 *
 * The book is the account's contact list. `lookup` reads it, `write` saves a person under
 * a name or takes them out, and `profile` asks Telegram who an address reaches: a handle
 * (`@name`), a phone, or an id, answered with the name the account goes by and what the
 * person wrote about themselves.
 *
 * The rooms are the account's chats. One person unnamed is their own chat, resolved to
 * the id their lines arrive under. A list named by `subject` is a group made with those
 * people in it; `#name` is a supergroup, which stays private until someone gives it a
 * handle, so the port answers `group` for both. `join` enters a public room by its
 * handle. What the log sees of any change is Telegram's own service message, brought back
 * by the ingest as the room's line.
 */

import type { ContactPort, RoomsPort } from "../../xi.ts";
import { DispatchError } from "../errors.ts";
import { API_TIMEOUT_MS } from "../http.ts";
import { serveSocket } from "../serve.ts";
import { kindOf } from "./ingest.ts";
import type { TgPeer, TgWire } from "./wire.ts";

/** The socket the connector answers its ports on, under the org's data root. */
export function portSocket(dir: string): string {
  return `${dir}/run/telegram.port.sock`;
}

/** How many entries a lookup answers. */
const LOOKUP_MAX = 20;

type Body = Record<string, unknown>;
type Leg = (wire: TgWire, body: Body) => Promise<unknown>;

const text = (v: unknown): string => typeof v === "string" ? v : "";
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
const digits = (s: string) => s.replace(/\D/g, "");

/** Who an address reaches: as given, and a bare run of digits also as the phone it may
 *  be, since a number nobody here has met is no id the session can name. */
async function reach(wire: TgWire, address: string): Promise<TgPeer | null> {
  const found = await wire.resolve(address);
  if (found || !/^\d{8,}$/.test(address)) return found;
  return await wire.resolve(`+${address}`);
}

const seat = (p: TgPeer) => ({ address: p.id, ...(p.name ? { name: p.name } : {}) });

const LEGS: Record<string, Leg> = {
  "contact/write": async (wire, b) => {
    const who = await reach(wire, text(b.address));
    if (!who || who.kind !== "user") {
      throw new DispatchError(`nobody on Telegram answers at ${text(b.address)}`, 404);
    }
    if (b.remove === true) {
      await wire.dropContact(who.id);
      return {};
    }
    const saved = await wire.saveContact(who.id, text(b.name) || undefined);
    return saved.name ? { name: saved.name } : {};
  },
  "contact/lookup": async (wire, b) => {
    const q = text(b.query).trim().toLowerCase();
    const number = digits(q);
    return (await wire.contacts())
      .filter((c) =>
        c.name &&
        (c.name.toLowerCase().includes(q) ||
          (c.username ?? "").toLowerCase().includes(q.replace(/^@/, "")) ||
          (number.length >= 4 && digits(c.phone ?? "").includes(number)))
      )
      .slice(0, LOOKUP_MAX)
      .map((c) => ({ name: c.name!, address: c.id }));
  },
  "contact/profile": async (wire, b) => {
    const who = await reach(wire, text(b.address));
    if (!who || who.kind !== "user") return { exists: false };
    // the about text is a courtesy on top of the answer: a read Telegram is rationing
    // leaves the profile without one
    const about = who.bot || who.min ? "" : await wire.about(who.id).catch(() => "");
    return {
      exists: true,
      ...(who.name ? { name: who.name } : {}),
      ...(about ? { about } : {}),
    };
  },
  "rooms/open": async (wire, b) => {
    const members = [...new Set(list(b.members))].filter((m) => m !== wire.self.id);
    if (b.kind === "direct") {
      if (members.length !== 1) {
        throw new DispatchError(
          "a Telegram chat with no name is one to one: name it with `subject` to open a " +
            "group with everyone in it",
          400,
        );
      }
      const who = await reach(wire, members[0]);
      if (!who) throw new DispatchError(`nobody on Telegram answers at ${members[0]}`, 404);
      return { address: who.id, kind: kindOf(who), ...(who.name ? { name: who.name } : {}) };
    }
    const title = text(b.name);
    if (!title) throw new DispatchError("a Telegram group needs a name", 400);
    const seats: string[] = [];
    for (const m of members) {
      const who = await reach(wire, m);
      if (!who) throw new DispatchError(`nobody on Telegram answers at ${m}`, 404);
      seats.push(who.id);
    }
    const made = await wire.createRoom(title, seats, b.kind === "channel" ? "channel" : "group");
    return { address: made.id, kind: kindOf(made), name: made.name ?? title };
  },
  "rooms/members": async (wire, b) => (await wire.members(text(b.conversation))).map(seat),
  "rooms/join": (wire, b) => wire.join(text(b.conversation)),
  "rooms/leave": (wire, b) => wire.leave(text(b.conversation)),
  "rooms/add": (wire, b) => wire.add(text(b.conversation), list(b.members)),
  "rooms/remove": (wire, b) => wire.remove(text(b.conversation), list(b.members)),
  "rooms/rename": (wire, b) => wire.rename(text(b.conversation), text(b.name)),
};

/** The connector's side: each leg over the live session of the account the call names. */
export function createPortHandler(
  wireOf: (connection: string) => TgWire | undefined,
): (req: Request) => Promise<Response> {
  const say = (status: number, message: string) => new Response(message, { status });
  return async (req) => {
    const leg = LEGS[new URL(req.url).pathname.slice(1)];
    if (req.method !== "POST" || !leg) return say(404, "no such leg");
    let body: Body;
    try {
      body = await req.json() as Body;
    } catch {
      return say(400, "invalid json");
    }
    const wire = wireOf(text(body.connection));
    if (!wire) return say(503, `no Telegram session is up for ${text(body.connection)}`);
    try {
      return Response.json(await leg(wire, body) ?? {});
    } catch (err) {
      const status = err instanceof DispatchError && err.code !== undefined ? err.code : 502;
      return say(status, err instanceof Error ? err.message : String(err));
    }
  };
}

/** Serve the ports on the org's socket, which only its owner may open. Returns stop. */
export async function servePort(
  dir: string,
  wireOf: (connection: string) => TgWire | undefined,
): Promise<() => Promise<void>> {
  const path = portSocket(dir);
  const server = await serveSocket(path, createPortHandler(wireOf));
  await Deno.chmod(path, 0o600);
  return async () => {
    await server.shutdown();
    await Deno.remove(path).catch(() => {});
  };
}

/** One call across the socket: the leg's answer, or its refusal as a `DispatchError`. */
export type PortCall = (leg: string, body: object) => Promise<unknown>;

/** main's side of the socket. A connector that is not running is a 503 in a sentence. */
export function portCall(dir: string): PortCall {
  const path = portSocket(dir);
  let client: Deno.HttpClient | undefined;
  return async (leg, body) => {
    client ??= Deno.createHttpClient({ proxy: { transport: "unix", path } });
    let res: Response;
    try {
      res = await fetch(`http://localhost/${leg}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        client,
        signal: AbortSignal.timeout(API_TIMEOUT_MS),
      });
    } catch {
      throw new DispatchError("the telegram connector is not answering: is the org running?", 503);
    }
    if (!res.ok) {
      throw new DispatchError((await res.text()).slice(0, 256) || `HTTP ${res.status}`, res.status);
    }
    return await res.json();
  };
}

/** The address book, telegram's port. */
export function telegramContact(call: PortCall): ContactPort {
  return {
    write: (req) => call("contact/write", req) as Promise<{ name?: string }>,
    lookup: (req) => call("contact/lookup", req) as Promise<{ name: string; address: string }[]>,
    profile: (req) =>
      call("contact/profile", req) as Promise<{ exists: boolean; name?: string; about?: string }>,
  };
}

/** The rooms, telegram's port. */
export function telegramRooms(call: PortCall): RoomsPort {
  const done = async (leg: string, req: object) => {
    await call(leg, req);
  };
  return {
    open: (req) =>
      call("rooms/open", req) as Promise<
        { address: string; kind?: "direct" | "group" | "channel"; name?: string }
      >,
    members: (req) => call("rooms/members", req) as Promise<{ address: string; name?: string }[]>,
    join: (req) => done("rooms/join", req),
    leave: (req) => done("rooms/leave", req),
    add: (req) => done("rooms/add", req),
    remove: (req) => done("rooms/remove", req),
    rename: (req) => done("rooms/rename", req),
  };
}
