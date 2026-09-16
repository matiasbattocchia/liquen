import { assertEquals, assertRejects } from "@std/assert";
import { whatsappContact } from "./contact.ts";
import { DispatchError } from "../errors.ts";

/** A bridge that records the request and answers what it is told to. */
function bridge(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
  const fetchApi = ((url: string, init: RequestInit) => {
    calls.push({ url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), { status }),
    );
  }) as unknown as typeof fetch;
  return { calls, fetchApi };
}

Deno.test("whatsapp contact: one dispatch of type contact, the person as the chat", async () => {
  const { calls, fetchApi } = bridge(200, { status: "sent", name: "Vivian Rossi" });
  const port = whatsappContact("http://bridge.local", "tok", fetchApi);
  const out = await port({
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
  assertEquals(await port({ connection: "549", address: "5492604586396" }), { name: "vivi 🌸" });
  assertEquals(calls[0].body.contact, { name: "", remove: false });
  const { calls: c2, fetchApi: f2 } = bridge(200, { status: "sent", name: "" });
  assertEquals(
    await whatsappContact("http://b", "t", f2)({
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
  const err = await assertRejects(() => port({ connection: "549", address: "120363@g.us" }));
  assertEquals(err instanceof DispatchError && err.code, 422);
  assertEquals(String((err as Error).message).includes("not a person"), true);
});
