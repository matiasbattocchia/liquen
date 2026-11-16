import { assertEquals, assertStringIncludes } from "@std/assert";
import { createMercadopagoSignIn } from "./signin.ts";
import type { Me } from "./connect.ts";
import { door, fakeGate, pageCtx, ticket } from "../testing.ts";

const whoami = (token: string): Promise<Me> =>
  Promise.resolve(
    token === "APP_USR-good"
      ? { id: 4242, nickname: "ACME", email: "ana@example.com" }
      : { message: "invalid access token" },
  );

Deno.test("Mercado Pago page: a token it refuses asks again; one it takes lands as the user, by the CLI's path", async () => {
  const { ctx, vault, connections, published } = pageCtx();
  const gate = fakeGate([ticket("t1", { service: "mercadopago", agentId: "ana" })]);
  const page = door(createMercadopagoSignIn({ whoami }), ctx, gate);
  assertStringIncludes(await (await page.get("t1")).text(), "ana&#39;s Mercado Pago account.");

  const bad = await page.post("t1", { token: "APP_USR-bad" });
  assertEquals(bad.status, 400);
  assertStringIncludes(await bad.text(), "Mercado Pago refused the token: invalid access token");
  assertEquals(gate.seen.judged, []);

  const good = await page.post("t1", { token: "APP_USR-good" });
  assertStringIncludes(await good.text(), "Mercado Pago ACME is connected.");
  assertEquals(gate.seen.judged, [{
    ticket: "t1",
    who: { address: "4242", email: "ana@example.com" },
  }]);
  assertEquals(gate.seen.landed, [{ ticket: "t1", account: "4242" }]);
  assertEquals(vault.get("mercadopago:4242")?.agentId, "ana");
  assertEquals(connections[0].address, "4242");
  assertEquals(published.length, 1);
});

Deno.test("Mercado Pago page: an account the judge refuses is said on the page, and nothing is written", async () => {
  const { ctx, vault, connections } = pageCtx();
  const gate = fakeGate([ticket("t1", { service: "mercadopago", agentId: "ana" })], {
    refuse: "signed in as 4242, and this sign-in was for 7: nothing was connected",
  });
  const res = await door(createMercadopagoSignIn({ whoami }), ctx, gate)
    .post("t1", { token: "APP_USR-good" });
  assertEquals(res.status, 403);
  assertStringIncludes(await res.text(), "this sign-in was for 7");
  assertEquals(vault.size, 0);
  assertEquals(connections, []);
});
