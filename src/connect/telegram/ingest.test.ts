import { assert, assertEquals } from "@std/assert";
import {
  createTelegramIngest,
  followed,
  kindOf,
  roomChange,
  type TelegramIngestDeps,
} from "./ingest.ts";
import { externalId, messageIdOf } from "./wire.ts";
import { fakeWire, FORUM, message, SELF, SOL, TEAM } from "./testing.ts";
import type { ConnectionRow } from "../../store/connections.ts";
import type { Storage } from "../../store/storage.ts";
import type { Draft, Event, MessageEvent } from "../../types.ts";
import type { TgPeer } from "./wire.ts";

const NOW = "2026-11-13T16:00:00.000Z";

function memoryStorage(): Storage & { kept: Map<string, Uint8Array> } {
  const kept = new Map<string, Uint8Array>();
  return {
    kept,
    put: (key, bytes) => {
      kept.set(key, bytes);
      return Promise.resolve();
    },
    get: (key) => Promise.resolve((kept.get(key) ?? null) as Uint8Array<ArrayBuffer> | null),
    delete: (key) => {
      kept.delete(key);
      return Promise.resolve();
    },
    keys: async function* () {},
  };
}

function harness(over: Partial<TelegramIngestDeps> = {}) {
  const published: Draft<MessageEvent>[] = [];
  const wire = fakeWire();
  const ingest = createTelegramIngest({
    wire,
    publish: ((drafts: Draft<MessageEvent>[]) => {
      published.push(...drafts);
      return Promise.resolve(drafts as unknown as Event[]);
    }) as TelegramIngestDeps["publish"],
    now: () => NOW,
    sleep: () => Promise.resolve(),
    ...over,
  });
  return { ingest, published, wire };
}

Deno.test("telegram ingest: kinds come from the chat's type, and a followed channel is no conversation", () => {
  assertEquals(kindOf(SOL), "direct");
  assertEquals(kindOf(TEAM), "group");
  assertEquals(kindOf(FORUM), "group");
  assertEquals(kindOf({ ...FORUM, username: "obra" }), "channel");
  const news: TgPeer = { id: "-1007000", kind: "channel", name: "Noticias" };
  assertEquals(kindOf(news), "broadcast");
  assert(followed(news));
  assert(!followed({ ...news, posts: true }));
});

Deno.test("telegram ingest: an id is scoped by its chat only where the chat numbers its own", () => {
  assertEquals(externalId("700100", "700200", 41), "telegram:700100.41");
  assertEquals(externalId("700100", "-4100", 41), "telegram:700100.41");
  assertEquals(externalId("700100", "-1009000", 41), "telegram:700100.-1009000.41");
  assertEquals(messageIdOf("telegram:700100.-1009000.41"), 41);
  assertEquals(messageIdOf("telegram:700100.41"), 41);
  assertEquals(messageIdOf("telegram:700100.41.deleted"), undefined);
  assertEquals(messageIdOf("telegram:700100.41.edit.1794582300"), undefined);
  assertEquals(messageIdOf("telegram:700100.41.react.700200.👍.1794582300"), undefined);
});

Deno.test("telegram ingest: a direct message maps to one row, named and addressed", async () => {
  const { ingest, published } = harness();
  await ingest.handle({
    type: "message",
    message: message({ text: "hola mundo", entities: [{ type: "bold", offset: 5, length: 5 }] }),
  });
  assertEquals(published, [{
    ts: "2026-11-13T15:00:00.000Z",
    type: "message",
    envelope: {
      service: "telegram",
      connection_address: "700100",
      conversation: { address: "700200", kind: "direct", name: "Sol Ruiz" },
      sender: { address: "700200", name: "Sol Ruiz" },
      external_id: "telegram:700100.41",
    },
    parts: [{ type: "text", kind: "text", text: "hola **mundo**" }],
  }]);
});

Deno.test("telegram ingest: the account's own line names the account; a saved sender is marked; marks ride", async () => {
  const { ingest, published } = harness();
  await ingest.handle({ type: "message", message: message({ out: true, sender: SELF }) });
  assertEquals(published[0].envelope.sender, { address: "700100", name: "Ana Paz" });
  assertEquals(published[0].extra, undefined);
  await ingest.handle({
    type: "message",
    message: message({
      id: 42,
      chat: TEAM,
      sender: { ...SOL, contact: true },
      muted: true,
      archived: true,
    }),
  });
  assertEquals(published[1].extra, { muted: true, archived: true, sender_saved: true });
  assertEquals(published[1].envelope.conversation, {
    address: "-4100",
    kind: "group",
    name: "Equipo",
  });
});

Deno.test("telegram ingest: a reply, a forward and the people a text names ride the payload", async () => {
  const { ingest, published } = harness();
  await ingest.handle({
    type: "message",
    message: message({
      chat: FORUM,
      reply: 30,
      forwarded: true,
      text: "che @Beto mirá",
      entities: [{ type: "mention_name", offset: 4, length: 5, user: "700300" }],
      mentioned: true,
    }),
  });
  assertEquals(published[0].payload, {
    action: "reply",
    ref_external_id: "telegram:700100.-1009000.30",
    mentions: [{ address: "700300", name: "Beto" }, { address: "700100", name: "Ana Paz" }],
  });
  await ingest.handle({ type: "message", message: message({ id: 43, forwarded: true }) });
  assertEquals(published[1].payload, { action: "forward" });
});

Deno.test("telegram ingest: a file is kept and its caption rides the part; one too big is named", async () => {
  const storage = memoryStorage();
  const { ingest, published } = harness({ storage });
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  await ingest.handle({
    type: "message",
    message: message({
      text: "el plano",
      file: {
        kind: "image",
        mime: "image/png",
        name: "plano.png",
        size: png.length,
        bytes: () => Promise.resolve(png),
      },
    }),
  });
  const part = published[0].parts[0];
  assert(part.type === "file");
  assertEquals(part.kind, "image");
  assertEquals(part.text, "el plano");
  assertEquals(part.file.mime_type, "image/png");
  assert(part.file.uri.startsWith("storage://"));
  assertEquals(storage.kept.size, 1);

  let fetched = false;
  await ingest.handle({
    type: "message",
    message: message({
      id: 44,
      text: "la obra",
      file: {
        kind: "video",
        mime: "video/mp4",
        name: "obra.mp4",
        size: 200 * 1024 * 1024,
        bytes: () => {
          fetched = true;
          return Promise.resolve(new Uint8Array());
        },
      },
    }),
  });
  assertEquals(published[1].parts, [
    { type: "text", kind: "text", text: "[obra.mp4: 200 MB, left on Telegram]\nla obra" },
  ]);
  assert(!fetched);
});

Deno.test("telegram ingest: a place, a card and media with no bytes are parts or a named line", async () => {
  const { ingest, published } = harness();
  await ingest.handle({
    type: "message",
    message: message({ text: "", location: { latitude: -32.89, longitude: -68.84 } }),
  });
  assertEquals(published[0].parts, [
    { type: "data", kind: "location", data: { latitude: -32.89, longitude: -68.84 } },
  ]);
  await ingest.handle({
    type: "message",
    message: message({ id: 45, text: "", contact: { name: "Beto Paz", phone: "5492615550103" } }),
  });
  assertEquals(published[1].parts, [{
    type: "data",
    kind: "contacts",
    data: [{ name: { formatted_name: "Beto Paz" }, phones: [{ phone: "5492615550103" }] }],
  }]);
  await ingest.handle({ type: "message", message: message({ id: 46, text: "", other: "poll" }) });
  assertEquals(published[2].parts, [{ type: "text", kind: "text", text: "[poll]" }]);
});

Deno.test("telegram ingest: a followed channel publishes nothing; one the account posts in is a broadcast", async () => {
  const { ingest, published } = harness();
  const news: TgPeer = { id: "-1007000", kind: "channel", name: "Noticias" };
  await ingest.handle({ type: "message", message: message({ chat: news, sender: undefined }) });
  assertEquals(published, []);
  await ingest.handle({
    type: "message",
    message: message({ chat: { ...news, posts: true }, sender: undefined }),
  });
  assertEquals(published[0].envelope.conversation.kind, "broadcast");
  assertEquals(published[0].envelope.sender, undefined);
});

Deno.test("telegram ingest: an edit is its own event at the edit's time, keyed on it", async () => {
  const { ingest, published } = harness();
  await ingest.handle({
    type: "edit",
    message: message({ text: "hola!", edited: "2026-11-13T15:05:00.000Z" }),
  });
  assertEquals(published, [{
    ts: "2026-11-13T15:05:00.000Z",
    type: "message",
    payload: { action: "edit", ref_external_id: "telegram:700100.41" },
    envelope: {
      service: "telegram",
      connection_address: "700100",
      conversation: { address: "700200", kind: "direct", name: "Sol Ruiz" },
      sender: { address: "700200", name: "Sol Ruiz" },
      external_id: "telegram:700100.41.edit.1794582300",
    },
    parts: [{ type: "text", kind: "text", text: "hola!" }],
  }]);
  // an edit with no edit time (a link preview arriving) is no edit
  await ingest.handle({ type: "edit", message: message() });
  assertEquals(published.length, 1);
});

Deno.test("telegram ingest: a delete is the event plus a stamp on the original, its chat remembered", async () => {
  const { ingest, published } = harness();
  await ingest.handle({ type: "message", message: message() });
  await ingest.handle({ type: "delete", ids: [41] });
  const [, event, stamp] = published;
  assertEquals(event.payload, { action: "delete", ref_external_id: "telegram:700100.41" });
  assertEquals(event.envelope.conversation, { address: "700200" });
  assertEquals(event.envelope.external_id, "telegram:700100.41.deleted");
  assertEquals(event.parts, []);
  assertEquals(stamp.envelope.external_id, "telegram:700100.41");
  assertEquals(stamp.status, { state: "deleted", deleted_at: NOW });
  assert(!("parts" in stamp));

  await ingest.handle({ type: "delete", ids: [9], chat: "-1009000" });
  assertEquals(published[3].payload?.ref_external_id, "telegram:700100.-1009000.9");
});

Deno.test("telegram ingest: a read receipt stamps the newest message the other side saw", async () => {
  const { ingest, published } = harness();
  await ingest.handle({ type: "read", chat: "700200", id: 77 });
  assertEquals(published.length, 1);
  assertEquals(published[0].envelope.external_id, "telegram:700100.77");
  assertEquals(published[0].status, { state: "read", read_at: NOW });
  assert(!("parts" in published[0]));
});

Deno.test("telegram ingest: service messages speak the room vocabulary", () => {
  const beto: TgPeer = { id: "700300", kind: "user", name: "Beto" };
  assertEquals(roomChange({ type: "added", members: [beto] }, SOL), {
    joined: [{ address: "700300", name: "Beto" }],
    reason: "added",
  });
  assertEquals(roomChange({ type: "added", members: [SOL] }, SOL), {
    joined: [{ address: "700200", name: "Sol Ruiz" }],
  });
  assertEquals(roomChange({ type: "joined", how: "link" }, SOL), {
    joined: [{ address: "700200", name: "Sol Ruiz" }],
    reason: "link",
  });
  assertEquals(roomChange({ type: "left" }, SOL), {
    left: [{ address: "700200", name: "Sol Ruiz" }],
  });
  assertEquals(roomChange({ type: "removed", member: beto }, SOL), {
    left: [{ address: "700300", name: "Beto" }],
    reason: "removed",
  });
  assertEquals(roomChange({ type: "created", title: "Obra", members: [SOL, beto] }, SOL), {
    state: "created",
    name: "Obra",
    joined: [{ address: "700200", name: "Sol Ruiz" }, { address: "700300", name: "Beto" }],
  });
  assertEquals(roomChange({ type: "title", title: "Obra 2" }, SOL), { name: "Obra 2" });
  assertEquals(roomChange({ type: "photo", photo: "removed" }, SOL), { picture: "removed" });
  assertEquals(roomChange({ type: "timer", seconds: 86400 }, SOL), {
    settings: { disappearing: 86400 },
  });
  assertEquals(roomChange({ type: "call", state: "missed", kind: "video" }, SOL), {
    call: { state: "missed", kind: "video" },
  });
  assertEquals(roomChange({ type: "moved", to: "-1009000" }, SOL), {
    moved: { to: "-1009000" },
  });
  assertEquals(roomChange({ type: "topic", title: "Planos", state: "created" }, SOL), {
    changed: ["topic created Planos"],
  });
  assertEquals(roomChange({ type: "other", name: "theme_changed" }, SOL), {
    changed: ["theme_changed"],
  });
});

Deno.test("telegram ingest: a room line is one room part from whoever made the change; a pin points", async () => {
  const { ingest, published } = harness();
  await ingest.handle({
    type: "message",
    message: message({
      id: 50,
      chat: TEAM,
      text: "",
      action: { type: "title", title: "Equipo A" },
    }),
  });
  assertEquals(published[0].parts, [{ type: "data", kind: "room", data: { name: "Equipo A" } }]);
  assertEquals(published[0].envelope.sender, { address: "700200", name: "Sol Ruiz" });
  assertEquals(published[0].envelope.external_id, "telegram:700100.50");
  await ingest.handle({
    type: "message",
    message: message({ id: 51, chat: TEAM, text: "", action: { type: "pinned", id: 41 } }),
  });
  assertEquals(published[1].parts, [{ type: "data", kind: "room", data: { pinned: true } }]);
  assertEquals(published[1].payload, { ref_external_id: "telegram:700100.41" });
});

Deno.test("telegram ingest: the classifier stamps a member by their own account, or their declared phone", async () => {
  const rows: Record<string, ConnectionRow> = {
    "700200": { service: "telegram", address: "700200", agentId: "sol" },
  };
  const store = {
    connection: (_s: string, address: string) => Promise.resolve(rows[address] ?? null),
    connections: () => Promise.resolve(Object.values(rows)),
    upsertConnections: () => Promise.resolve(),
    agents: () =>
      Promise.resolve([
        { agentId: "beto", phone: "+54 9 261 555-0103" },
      ]) as ReturnType<NonNullable<NonNullable<TelegramIngestDeps["store"]>["agents"]>>,
  };
  const { ingest, published } = harness({ store });
  await ingest.handle({ type: "message", message: message() });
  assertEquals(published[0].agent, { id: "sol" });
  await ingest.handle({
    type: "message",
    message: message({
      id: 60,
      sender: { id: "700300", kind: "user", name: "Beto", phone: "5492615550103" },
    }),
  });
  assertEquals(published[1].agent, { id: "beto" });
  await ingest.handle({
    type: "message",
    message: message({ id: 61, sender: { id: "700400", kind: "user", name: "Otro" } }),
  });
  assertEquals(published[2].agent, undefined);
});

Deno.test("telegram ingest: a member's DM with an owned account is recorded before its line lands", async () => {
  const BETO: TgPeer = { id: "700300", kind: "user", name: "Beto", phone: "5492615550103" };
  const rows: Record<string, ConnectionRow> = {
    "700100": { service: "telegram", address: "700100", agentId: "ana" },
    "700200": { service: "telegram", address: "700200", agentId: "sol" },
  };
  const order: string[] = [];
  const upserts: Partial<ConnectionRow>[] = [];
  const store = {
    connection: (_s: string, address: string) => Promise.resolve(rows[address] ?? null),
    connections: () => Promise.resolve(Object.values(rows)),
    upsertConnections: (patch: Partial<ConnectionRow>[]) => {
      order.push("record");
      upserts.push(...patch);
      const row = rows[patch[0].address!];
      row.extra = {
        ...row.extra,
        mirrors: {
          dms: {
            ...(row.extra?.mirrors as { dms?: object })?.dms,
            ...(patch[0].extra?.mirrors as { dms: object }).dms,
          },
        },
      };
      return Promise.resolve();
    },
    agents: () =>
      Promise.resolve([
        { agentId: "beto", phone: "+54 9 261 555-0103" },
      ]) as ReturnType<NonNullable<NonNullable<TelegramIngestDeps["store"]>["agents"]>>,
  } as unknown as NonNullable<TelegramIngestDeps["store"]>;
  const published: Draft<MessageEvent>[] = [];
  const ingest = createTelegramIngest({
    wire: fakeWire(),
    store,
    publish: ((drafts: Draft<MessageEvent>[]) => {
      order.push("publish");
      published.push(...drafts);
      return Promise.resolve(drafts as unknown as Event[]);
    }) as TelegramIngestDeps["publish"],
    now: () => NOW,
    sleep: () => Promise.resolve(),
  });

  // Sol, by her own account, and Beto, by his declared phone
  await ingest.handle({ type: "message", message: message() });
  await ingest.handle({ type: "message", message: message({ id: 42, chat: BETO, sender: BETO }) });
  assertEquals(upserts, [
    { service: "telegram", address: "700100", extra: { mirrors: { dms: { sol: "700200" } } } },
    { service: "telegram", address: "700100", extra: { mirrors: { dms: { beto: "700300" } } } },
  ]);
  assertEquals(order, ["record", "publish", "record", "publish"]);

  // once recorded, a chat is not written again; the account's own line and a stranger's
  // record nothing
  await ingest.handle({ type: "message", message: message({ id: 43 }) });
  await ingest.handle({
    type: "message",
    message: message({ id: 44, sender: SELF, out: true }),
  });
  const ZOE: TgPeer = { id: "700500", kind: "user", name: "Zoe" };
  await ingest.handle({ type: "message", message: message({ id: 45, chat: ZOE, sender: ZOE }) });
  // a member in a group is no DM
  await ingest.handle({ type: "message", message: message({ id: 46, chat: TEAM }) });
  assertEquals(upserts.length, 2);
});

Deno.test("telegram ingest: a shared account records no DM", async () => {
  const rows: Record<string, ConnectionRow> = {
    "700100": { service: "telegram", address: "700100" },
    "700200": { service: "telegram", address: "700200", agentId: "sol" },
  };
  let upserts = 0;
  const store = {
    connection: (_s: string, address: string) => Promise.resolve(rows[address] ?? null),
    connections: () => Promise.resolve(Object.values(rows)),
    upsertConnections: () => {
      upserts++;
      return Promise.resolve();
    },
  };
  const { ingest, published } = harness({ store });
  await ingest.handle({ type: "message", message: message() });
  assertEquals(published[0].agent, { id: "sol" });
  assertEquals(upserts, 0);
});

Deno.test("telegram ingest: a stranger's about rides their first line in each conversation", async () => {
  const waits: number[] = [];
  const bios = {
    of: (_user: string, waitMs = 0) => {
      waits.push(waitMs);
      return Promise.resolve<string | undefined>("Arquitecta. Obras en Mendoza.");
    },
    stop: () => {},
  };
  const { ingest, published } = harness({ bios });
  await ingest.handle({ type: "message", message: message() });
  await ingest.handle({ type: "message", message: message({ id: 42 }) });
  await ingest.handle({ type: "message", message: message({ id: 43, chat: TEAM }) });
  assertEquals(published[0].extra, { sender_about: "Arquitecta. Obras en Mendoza." });
  assertEquals(published[1].extra, undefined);
  assertEquals(published[2].extra, { sender_about: "Arquitecta. Obras en Mendoza." });
  // a direct chat's first line waits for the read; a group's does not
  assert(waits[0] > 0);
  assertEquals(waits[1], 0);
});

Deno.test("telegram ingest: nobody's about is read for a contact, a bot, a stub, the account or a public room", async () => {
  const asked: string[] = [];
  const bios = {
    of: (user: string) => {
      asked.push(user);
      return Promise.resolve<string | undefined>("x");
    },
    stop: () => {},
  };
  const { ingest } = harness({ bios });
  const from = (sender: TgPeer, over = {}) =>
    ingest.handle({ type: "message", message: message({ sender, ...over }) });
  await from({ ...SOL, contact: true });
  await from({ ...SOL, bot: true });
  await from({ ...SOL, min: true });
  await from(SELF, { out: true });
  await from(SOL, { chat: { ...FORUM, username: "obra" } });
  assertEquals(asked, []);
  // an about still unread leaves the line as it is, and the next line asks again
  const pending = {
    of: (user: string) => {
      asked.push(user);
      return Promise.resolve<string | undefined>(undefined);
    },
    stop: () => {},
  };
  const later = harness({ bios: pending });
  await later.ingest.handle({ type: "message", message: message() });
  await later.ingest.handle({ type: "message", message: message({ id: 42 }) });
  assertEquals(asked, ["700200", "700200"]);
  assertEquals(later.published[0].extra, undefined);
});

Deno.test("telegram ingest: a gap is read from the room's newest row on, and a room never heard is left", async () => {
  const stored = [
    { envelope: { external_id: "telegram:700100.-1009000.90" } },
    { envelope: { external_id: "telegram:700100.-1009000.95.edit.1794582300" } },
    { envelope: { external_id: "telegram:700100.-1009000.93" } },
    { envelope: { external_id: "telegram:700100.-1009000.91.react.700200.👍.1794582300" } },
  ] as unknown as Event[];
  const wire = fakeWire({
    history: (chat: string, since: number) =>
      Promise.resolve([
        message({ id: since + 1, chat: FORUM, text: "uno" }),
        message({ id: since + 2, chat: FORUM, text: "dos", edited: "2026-11-13T15:05:00.000Z" }),
      ].filter(() => chat === FORUM.id)),
  });
  const { ingest, published } = harness({
    wire,
    read: (q) =>
      Promise.resolve(
        q?.conversation === FORUM.id ? stored.filter(q.filter ?? (() => true)) : [],
      ),
  });
  await ingest.handle({ type: "gap", chat: FORUM.id });
  assertEquals(wire.calls.at(-1), { op: "history", args: ["-1009000", 93] });
  assertEquals(published.map((d) => d.envelope.external_id), [
    "telegram:700100.-1009000.94",
    "telegram:700100.-1009000.95",
    "telegram:700100.-1009000.95.edit.1794582300",
  ]);
  await ingest.handle({ type: "gap", chat: "-1008000" });
  assertEquals(published.length, 3);
});

Deno.test("telegram ingest: a publish that fails is tried again until it lands", async () => {
  let tries = 0;
  const errors: string[] = [];
  const { ingest } = harness({
    publish: (() => {
      if (++tries < 3) return Promise.reject(new Error("database is locked"));
      return Promise.resolve([]);
    }) as unknown as TelegramIngestDeps["publish"],
    onError: (what) => errors.push(what),
  });
  await ingest.handle({ type: "message", message: message() });
  assertEquals(tries, 3);
  assertEquals(errors, ["publishing", "publishing"]);
});

Deno.test("telegram ingest: a refusal for an account whose row was removed is final", async () => {
  let tries = 0;
  const live: ConnectionRow[] = [];
  const { ingest } = harness({
    publish: (() => {
      tries++;
      return Promise.reject(new Error("connection not registered: telegram:700100"));
    }) as unknown as TelegramIngestDeps["publish"],
    store: {
      connection: () => Promise.resolve(null),
      connections: () => Promise.resolve(live),
      upsertConnections: () => Promise.resolve(),
    },
  });
  await ingest.handle({ type: "message", message: message() });
  assertEquals(tries, 1);
});

Deno.test("telegram ingest: a message's reactions become adds and removes against the log", async () => {
  const stood = {
    id: "0190a",
    ts: "2026-11-13T15:00:00.000Z",
    type: "message",
    payload: { action: "add", ref_external_id: "telegram:700100.41" },
    envelope: {
      service: "telegram",
      connection_address: "700100",
      conversation: { address: "700200" },
      sender: { address: "700200", name: "Sol Ruiz" },
      external_id: "telegram:700100.41.react.700200.❤️.1794580000",
    },
    parts: [{ type: "data", kind: "reaction", data: { name: "❤️", unicode: "❤️" } }],
  } as unknown as Event;
  const { ingest, published } = harness({
    read: (q) => Promise.resolve([stood].filter((e) => !q?.filter || q.filter(e))),
  });
  await ingest.handle({
    type: "reactions",
    chat: SOL,
    id: 41,
    reactions: [{ by: SOL, emoji: "👍", date: "2026-11-13T15:05:00.000Z" }],
  });
  assertEquals(published.map((d) => [d.payload?.action, d.envelope.external_id]), [
    ["add", "telegram:700100.41.react.700200.👍.1794582300"],
    ["remove", "telegram:700100.41.react.700200.❤️.1794580000.removed"],
  ]);
  assertEquals(published[0].envelope.conversation, {
    address: "700200",
    kind: "direct",
    name: "Sol Ruiz",
  });
  // a followed channel's reactions are nobody's lines
  await ingest.handle({
    type: "reactions",
    chat: { id: "-1007000", kind: "channel", name: "Noticias" },
    id: 9,
    reactions: [{ by: SOL, emoji: "👍", date: NOW }],
  });
  assertEquals(published.length, 2);
});

Deno.test("telegram ingest: a reaction and a delete in a muted or archived chat are silenced as its messages are", async () => {
  const views: Record<string, { muted?: boolean; archived?: boolean }> = {
    "-4100": { muted: true },
    "-1009000": { archived: true },
  };
  const { ingest, published } = harness({
    wire: fakeWire({ view: (chat: string) => views[chat] ?? {} }),
    read: () => Promise.resolve([]),
  });
  await ingest.handle({
    type: "reactions",
    chat: TEAM,
    id: 41,
    reactions: [{ by: SOL, emoji: "👍", date: NOW }],
  });
  assertEquals(published[0].extra, { muted: true });
  await ingest.handle({ type: "delete", ids: [9], chat: "-1009000" });
  assertEquals(published[1].extra, { archived: true });
  // a chat the app holds plainly marks nothing
  await ingest.handle({
    type: "reactions",
    chat: SOL,
    id: 42,
    reactions: [{ by: SOL, emoji: "👍", date: NOW }],
  });
  assertEquals(published[3].extra, undefined);
});

Deno.test("telegram ingest: the session's state lands on the account's row", async () => {
  const upserts: ConnectionRow[] = [];
  const row: ConnectionRow = {
    service: "telegram",
    address: "700100",
    extra: { state: "connected" },
  };
  const { ingest } = harness({
    store: {
      connection: () => Promise.resolve(row),
      connections: () => Promise.resolve([row]),
      upsertConnections: (rows) => {
        upserts.push(...rows);
        return Promise.resolve();
      },
    },
  });
  await ingest.handle({ type: "state", state: "connected" });
  assertEquals(upserts, []);
  await ingest.handle({ type: "state", state: "signed_out", error: "SESSION_REVOKED" });
  assertEquals(upserts[0].extra, {
    state: "signed_out",
    signed_out_at: NOW,
    error: "SESSION_REVOKED",
  });
});
