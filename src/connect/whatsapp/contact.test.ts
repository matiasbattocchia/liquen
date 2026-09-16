import { assertEquals, assertRejects } from "@std/assert";
import { whatsappContact } from "./contact.ts";
import { DispatchError } from "../errors.ts";

/** A bridge that records the request and answers what it is told to. A read carries no
 *  body, so `body` stands only for the calls that have one. */
function bridge(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetchApi = ((url: string, init: RequestInit = {}) => {
    calls.push({
      url,
      init,
      body: init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {},
    });
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    );
  }) as unknown as typeof fetch;
  return { calls, fetchApi };
}

Deno.test("whatsapp contact: one dispatch of type contact, the person as the chat", async () => {
  const { calls, fetchApi } = bridge(200, { status: "sent", name: "Vivian Rossi" });
  const port = whatsappContact("http://bridge.local", "tok", fetchApi);
  const out = await port.write!({
    connection: "5491100000000",
    address: "5492604586396",
    name: "Vivian Rossi",
  });
  assertEquals(out, { name: "Vivian Rossi" });
  assertEquals(calls[0].url, "http://bridge.local/dispatch");
  assertEquals((calls[0].init.headers as Record<string, string>).authorization, "Bearer tok");
  assertEquals(calls[0].body, {
    type: "contact",
    record: { organization_address: "5491100000000", conversation_address: "5492604586396" },
    contact: { name: "Vivian Rossi", remove: false },
  });
});

Deno.test("whatsapp contact: a nameless save asks the bridge for the wire's word; a remove carries none", async () => {
  const { calls, fetchApi } = bridge(200, { status: "sent", name: "vivi 🌸" });
  const port = whatsappContact("http://bridge.local", "tok", fetchApi);
  assertEquals(
    await port.write!({ connection: "549", address: "5492604586396" }),
    { name: "vivi 🌸" },
  );
  assertEquals(calls[0].body.contact, { name: "", remove: false });
  const { calls: c2, fetchApi: f2 } = bridge(200, { status: "sent", name: "" });
  assertEquals(
    await whatsappContact("http://b", "t", f2).write!({
      connection: "549",
      address: "5492604586396",
      remove: true,
    }),
    {},
  );
  assertEquals(c2[0].body.contact, { name: "", remove: true });
});

Deno.test("whatsapp contact: the bridge's refusal is the call's failure, class and all", async () => {
  const { fetchApi } = bridge(
    422,
    "120363@g.us is not a person — only a direct chat has an address-book entry",
  );
  const port = whatsappContact("http://bridge.local", "tok", fetchApi);
  const err = await assertRejects(() => port.write!({ connection: "549", address: "120363@g.us" }));
  assertEquals(err instanceof DispatchError && err.code, 422);
  assertEquals(String((err as Error).message).includes("not a person"), true);
});

Deno.test("whatsapp contact: a lookup reads the account's book, and a nameless entry is none", async () => {
  const { calls, fetchApi } = bridge(200, {
    contacts: [
      { address: "5492616104507", extra: { name: "Verónica Sesto" } },
      { address: "5491155512345" }, // no name: known to the wire, not saved in the book
    ],
  });
  const port = whatsappContact("http://bridge.local", "tok", fetchApi);
  assertEquals(await port.lookup!({ connection: "5491100000000", query: "veró nica" }), [
    { name: "Verónica Sesto", address: "5492616104507" },
  ]);
  assertEquals(
    calls[0].url,
    "http://bridge.local/contacts/5491100000000?q=ver%C3%B3%20nica",
  );
  assertEquals((calls[0].init.headers as Record<string, string>).authorization, "Bearer tok");
  assertEquals(calls[0].init.method, undefined); // a read is a GET
});

Deno.test("whatsapp contact: a book that refuses fails the lookup, class and all", async () => {
  const { fetchApi } = bridge(404, "unknown session");
  const port = whatsappContact("http://bridge.local", "tok", fetchApi);
  const err = await assertRejects(() => port.lookup!({ connection: "549", query: "ana" }));
  assertEquals(err instanceof DispatchError && err.code, 404);
});
