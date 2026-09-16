import { assertEquals } from "@std/assert";
import { describeCall, nameResolver } from "./describe.ts";
import type { Event } from "./types.ts";

Deno.test("describeCall: one string argument prints bare — the argument IS the call", () => {
  assertEquals(
    describeCall({ name: "bash", input: { command: "git status" } }),
    "bash(git status)",
  );
  assertEquals(describeCall({ name: "aread", input: { path: "/etc/hosts" } }), "aread(/etc/hosts)");
  // …and no tool name appears in that rule: it is the shape of the call that decides
  assertEquals(
    describeCall({ name: "search", input: { in: "wa:x", text: "factura" } }),
    "search(in: wa:x, text: factura)",
  );
});

Deno.test("describeCall: empty arguments are not shown — a call reads as what it does", () => {
  assertEquals(
    describeCall({ name: "search", input: { in: "wa:x", text: "", files: [] } }),
    "search(wa:x)",
  );
});

Deno.test("describeCall: send says WHO — the name, with the address as the fallback", () => {
  const call = { name: "send", input: { to: "5492604586396", text: "ya salgo" } };
  const vivian = (a: string) => a === "5492604586396" ? { name: "Vivian", address: a } : undefined;
  assertEquals(
    describeCall(call, { resolve: (a) => vivian(a) }),
    "send(to: Vivian, text: ya salgo)",
  );
  // the CARD names the address too: approving is choosing a person, and a name alone
  // cannot tell two of them apart
  assertEquals(
    describeCall(call, { resolve: (a) => vivian(a), full: true }),
    "send(to: Vivian (5492604586396), text: ya salgo)",
  );
  assertEquals(describeCall(call), "send(to: 5492604586396, text: ya salgo)");
});

Deno.test("describeCall: contact says WHO is being saved — `who` is an address too", () => {
  const call = { name: "contact", input: { who: "5492604586396", name: "Vivian Rossi" } };
  const vivian = (a: string) => a === "5492604586396" ? { name: "vivi 🌸", address: a } : undefined;
  assertEquals(
    describeCall(call, { resolve: (a) => vivian(a) }),
    "contact(who: vivi 🌸, name: Vivian Rossi)",
  );
  assertEquals(
    describeCall(call, { resolve: (a) => vivian(a), full: true }),
    "contact(who: vivi 🌸 (5492604586396), name: Vivian Rossi)",
  );
});

Deno.test("describeCall: search says WHERE and WHO — `in`/`from` are addresses too", () => {
  const names: Record<string, string> = {
    "120363429869958481@g.us": "Sprinters Friends",
    "5492604586396": "Vivian Sobisch",
  };
  const resolve = (a: string) => names[a] ? { name: names[a], address: a } : undefined;
  assertEquals(
    describeCall({ name: "search", input: { in: "120363429869958481@g.us", text: "Catamarca" } }, {
      resolve,
    }),
    "search(in: Sprinters Friends, text: Catamarca)",
  );
  // the bare form resolves too — one addressed argument still IS the call
  assertEquals(
    describeCall({ name: "search", input: { in: "5492604586396" } }, { resolve }),
    "search(Vivian Sobisch)",
  );
  // these keys take a name as readily as an address, and a name resolves to nothing
  assertEquals(
    describeCall({ name: "search", input: { from: "matias", text: "hotel" } }, { resolve }),
    "search(from: matias, text: hotel)",
  );
  // an unaddressed argument is prose, never a lookup
  assertEquals(
    describeCall({ name: "search", input: { text: "5492604586396" } }, { resolve }),
    "search(5492604586396)",
  );
});

Deno.test("describeCall: the line form bounds an argument, the card form keeps all of it", () => {
  const text = "x".repeat(200);
  const call = { name: "send", input: { to: "wa:x", text } };
  const line = describeCall(call);
  assertEquals(line.length <= 120, true);
  assertEquals(line.includes("…"), true);
  // approving is judging what will actually be said, so the card is not allowed to elide it
  assertEquals(describeCall(call, { full: true }), `send(to: wa:x, text: ${text})`);
});

Deno.test("describeCall: a tool may bring its own rendering (ExecTool.describe, §9)", () => {
  const tools = { deploy: (input: unknown) => `→ ${(input as { env: string }).env}` };
  assertEquals(
    describeCall({ name: "deploy", input: { env: "prod", sha: "abc" } }, { tools }),
    "deploy(→ prod)",
  );
});

Deno.test("describeCall: the line cut never splits a character", () => {
  const line = describeCall({
    name: "bash",
    input: { command: "é".repeat(10) + "😀".repeat(80) },
  });
  assertEquals(line.endsWith("…)"), true);
  assertEquals(line.isWellFormed(), true);
});

Deno.test("nameResolver: the directory shows both halves — who, and which", async () => {
  const chat = (address: string, name: string, kind = "direct"): Event => ({
    id: `01-${address}`,
    ts: "2026-09-15T15:20:12.000Z",
    type: "message",
    envelope: {
      service: "whatsapp",
      connection_address: "5492615682044",
      conversation: { address, kind, name },
      sender: { address, name },
    },
    parts: [{ type: "text", kind: "text", text: "hola" }],
  } as unknown as Event);

  const rows = [chat("5492616104507", "Verónica Sesto"), chat("5492614696945", "Verónica Mori")];
  const read = (q: { conversation?: string; conversationName?: string }) =>
    Promise.resolve(
      q.conversation !== undefined
        ? rows.filter((r) => r.envelope.conversation.address === q.conversation)
        : rows.filter((r) =>
          (r.envelope.conversation.name ?? "").toLowerCase().includes(
            (q.conversationName ?? "").toLowerCase(),
          )
        ),
    );

  // an ADDRESS gains the name it goes by
  const byAddress = await nameResolver(read as never, [
    { name: "send", input: { to: "5492616104507" } },
  ]);
  assertEquals(byAddress("5492616104507"), { name: "Verónica Sesto", address: "5492616104507" });

  // …and a NAME renders the same, so the card says where the send will LAND, not what was typed
  const byName = await nameResolver(read as never, [
    { name: "send", input: { to: "Verónica Sesto" } },
  ]);
  assertEquals(byName("Verónica Sesto"), { name: "Verónica Sesto", address: "5492616104507" });

  // a name two conversations answer to promises nothing — the send refuses it with the list
  const ambiguous = await nameResolver(read as never, [{
    name: "send",
    input: { to: "Verónica" },
  }]);
  assertEquals(ambiguous("Verónica"), undefined);

  // an address nobody knows stands as written
  const stranger = await nameResolver(read as never, [
    { name: "send", input: { to: "5491122334455" } },
  ]);
  assertEquals(stranger("5491122334455"), undefined);
});
