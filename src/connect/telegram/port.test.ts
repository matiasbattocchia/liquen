import { assertEquals, assertRejects } from "@std/assert";
import {
  createPortHandler,
  END_LEG,
  type PortCall,
  portCall,
  PortDown,
  portSocket,
  servePort,
  telegramContact,
  telegramRooms,
} from "./port.ts";
import { type FakeWire, fakeWire, SELF } from "./testing.ts";
import { DispatchError } from "../errors.ts";
import { routeOf } from "../../edge.ts";

/** main's side wired straight to the connector's handler: the socket's two ends with no
 *  socket between them. */
function ports(wire: FakeWire) {
  const handler = createPortHandler((c) => (c === SELF.id ? wire : undefined));
  const call: PortCall = async (leg, body) => {
    const res = await handler(
      new Request(`http://localhost/${leg}`, { method: "POST", body: JSON.stringify(body) }),
    );
    if (!res.ok) throw new DispatchError(await res.text(), res.status);
    return await res.json();
  };
  return { contact: telegramContact(call), rooms: telegramRooms(call), wire };
}

const me = { connection: SELF.id, agent: "ana" };

Deno.test("telegram port: the socket's path is outside the edge's grammar", () => {
  assertEquals(portSocket("/org/data"), "/org/data/run/telegram.port.sock");
  assertEquals(routeOf("/telegram.port/ingest"), null);
});

Deno.test("telegram port: lookup reads the account's book by name, handle or number", async () => {
  const { contact } = ports(fakeWire());
  const hit = [{ name: "Sol Ruiz", address: "700200" }];
  assertEquals(await contact.lookup!({ connection: SELF.id, query: "sol" }), hit);
  assertEquals(await contact.lookup!({ connection: SELF.id, query: "@SolRuiz" }), hit);
  assertEquals(await contact.lookup!({ connection: SELF.id, query: "555 0107" }), hit);
  assertEquals(await contact.lookup!({ connection: SELF.id, query: "beto" }), []);
});

Deno.test("telegram port: write saves a person under a name, or takes them out", async () => {
  const { contact, wire } = ports(fakeWire());
  assertEquals(
    await contact.write!({ connection: SELF.id, address: "@solruiz", name: "Sol (obra)" }),
    { name: "Sol (obra)" },
  );
  assertEquals(wire.calls.at(-1), { op: "saveContact", args: ["700200", "Sol (obra)"] });
  assertEquals(
    await contact.write!({ connection: SELF.id, address: "700200", remove: true }),
    {},
  );
  assertEquals(wire.calls.at(-1), { op: "dropContact", args: ["700200"] });
  const refused = await assertRejects(
    () => contact.write!({ connection: SELF.id, address: "@nadie", name: "x" }),
    DispatchError,
  );
  assertEquals(refused.code, 404);
});

Deno.test("telegram port: a profile is who answers there, with what they wrote about themselves", async () => {
  const { contact } = ports(fakeWire());
  assertEquals(await contact.profile!({ connection: SELF.id, address: "@solruiz" }), {
    exists: true,
    name: "Sol Ruiz",
    about: "Arquitecta. Obras en Mendoza.",
  });
  assertEquals(await contact.profile!({ connection: SELF.id, address: "@nadie" }), {
    exists: false,
  });
  // an about Telegram will not give now leaves the profile without one
  const rationed = ports(
    fakeWire({ about: () => Promise.reject(new DispatchError("FLOOD_WAIT_9", 429)) }),
  );
  assertEquals(await rationed.contact.profile!({ connection: SELF.id, address: "700200" }), {
    exists: true,
    name: "Sol Ruiz",
  });
});

Deno.test("telegram port: a bare number nobody has met is asked again as the phone it may be", async () => {
  const asked: string[] = [];
  const { contact } = ports(fakeWire({
    resolve: (handle: string) => {
      asked.push(handle);
      return Promise.resolve(
        handle === "+5492615550107" ? { id: "700200", kind: "user" as const, name: "Sol" } : null,
      );
    },
    about: () => Promise.resolve(""),
  }));
  assertEquals(await contact.profile!({ connection: SELF.id, address: "5492615550107" }), {
    exists: true,
    name: "Sol",
  });
  assertEquals(asked, ["5492615550107", "+5492615550107"]);
});

Deno.test("telegram port: one person unnamed is their own chat, by the id their lines arrive under", async () => {
  const { rooms, wire } = ports(fakeWire());
  assertEquals(
    await rooms.open!({ ...me, members: ["@solruiz", SELF.id], kind: "direct" }),
    { address: "700200", kind: "direct", name: "Sol Ruiz" },
  );
  assertEquals(wire.calls.filter((c) => c.op === "createRoom"), []);
  const two = await assertRejects(
    () => rooms.open!({ ...me, members: ["@solruiz", "700300"], kind: "direct" }),
    DispatchError,
  );
  assertEquals(two.code, 400);
});

Deno.test("telegram port: a named list is a group made with its people, each resolved to an id", async () => {
  const { rooms, wire } = ports(fakeWire());
  assertEquals(
    await rooms.open!({ ...me, members: ["@solruiz"], name: "Obra", kind: "group" }),
    { address: "-4200", kind: "group", name: "Obra" },
  );
  assertEquals(wire.calls.at(-1), { op: "createRoom", args: ["Obra", ["700200"], "group"] });
  await rooms.open!({ ...me, members: [], name: "obra", kind: "channel" });
  assertEquals(wire.calls.at(-1), { op: "createRoom", args: ["obra", [], "channel"] });
  const stranger = await assertRejects(
    () => rooms.open!({ ...me, members: ["@nadie"], name: "Obra", kind: "group" }),
    DispatchError,
  );
  assertEquals(stranger.code, 404);
});

Deno.test("telegram port: the roster and the changes are the wire's own legs", async () => {
  const { rooms, wire } = ports(fakeWire());
  const room = { ...me, conversation: "-4100" };
  assertEquals(await rooms.members!(room), [
    { address: "700100", name: "Ana Paz" },
    { address: "700200", name: "Sol Ruiz" },
  ]);
  await rooms.join!({ ...me, conversation: "@obra" });
  await rooms.add!({ ...room, members: ["700300"] });
  await rooms.remove!({ ...room, members: ["700300"] });
  await rooms.rename!({ ...room, name: "Equipo A" });
  await rooms.leave!(room);
  assertEquals(wire.calls.slice(1), [
    { op: "join", args: ["@obra"] },
    { op: "add", args: ["-4100", ["700300"]] },
    { op: "remove", args: ["-4100", ["700300"]] },
    { op: "rename", args: ["-4100", "Equipo A"] },
    { op: "leave", args: ["-4100"] },
  ]);
});

Deno.test("telegram port: Telegram's refusal crosses with its class, and an account with no session is a 503", async () => {
  const { rooms } = ports(fakeWire({
    rename: () => Promise.reject(new DispatchError("CHAT_ADMIN_REQUIRED", 400)),
  }));
  const refused = await assertRejects(
    () => rooms.rename!({ ...me, conversation: "-4100", name: "x" }),
    DispatchError,
    "CHAT_ADMIN_REQUIRED",
  );
  assertEquals(refused.code, 400);
  const absent = await assertRejects(
    () => rooms.leave!({ connection: "999", agent: "ana", conversation: "-4100" }),
    DispatchError,
  );
  assertEquals(absent.code, 503);
});

Deno.test("telegram port: the legs cross a real socket, and a connector that is down is said", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tgp" });
  try {
    const call = portCall(dir);
    const down = await assertRejects(
      () => call("rooms/leave", { connection: SELF.id, conversation: "-4100" }),
      PortDown,
      "not answering",
    );
    assertEquals(down.code, 503);
    const wire = fakeWire();
    const ended: string[] = [];
    const stop = await servePort(dir, (c) => (c === SELF.id ? wire : undefined), (account) => {
      ended.push(account);
      return Promise.resolve(account === SELF.id);
    });
    try {
      assertEquals((await Deno.stat(portSocket(dir))).mode! & 0o777, 0o600);
      assertEquals(
        await telegramContact(portCall(dir)).lookup!({ connection: SELF.id, query: "sol" }),
        [{ name: "Sol Ruiz", address: "700200" }],
      );
      // a removal's ask reaches the process's accounts, a session up or not
      assertEquals(await portCall(dir)(END_LEG, { connection: SELF.id }), { ended: true });
      assertEquals(await portCall(dir)(END_LEG, { connection: "999" }), { ended: false });
      assertEquals(ended, [SELF.id, "999"]);
    } finally {
      await stop();
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
