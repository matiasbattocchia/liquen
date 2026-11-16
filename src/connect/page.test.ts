import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { escape, formPage } from "./page.ts";
import { createTokenSignIn } from "./token/signin.ts";
import { door, fakeGate, pageCtx, ticket } from "./testing.ts";

Deno.test("formPage: every value escaped, and a page that loads nothing, is kept nowhere, and posts only to itself", async () => {
  assertEquals(
    escape(`<a href="x">'&'</a>`),
    "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;",
  );
  const res = formPage({
    title: "A <title>",
    lines: ["for <script>alert(1)</script>"],
    list: ["*.example.com"],
    fields: [{ name: "token", label: "Token", type: "password", autocomplete: "off", value: `"x` }],
    submit: "Store it",
  }, "it <failed>");
  const body = await res.text();
  assert(!body.includes("<script>"));
  assertStringIncludes(body, "for &lt;script&gt;");
  assertStringIncludes(body, `value="&quot;x"`);
  assertStringIncludes(body, `<p class="error" role="alert">it &lt;failed&gt;</p>`);
  assertEquals(res.headers.get("cache-control"), "no-store");
  assertEquals(res.headers.get("referrer-policy"), "no-referrer");
  assertStringIncludes(res.headers.get("content-security-policy")!, "default-src 'none'");
  assertStringIncludes(res.headers.get("content-security-policy")!, "form-action 'self'");
});

const CRM = ticket("t1", {
  service: "token",
  agentId: "matias",
  extra: {
    token: {
      name: "crm",
      env: "CRM_TOKEN",
      hosts: ["api.crm.example"],
      paths: ["/v1/"],
      probe: "https://api.crm.example/v1/me",
    },
  },
});

Deno.test("token page: it says where the token goes before the paste, and a link that is over says so", async () => {
  const { ctx } = pageCtx();
  const page = door(createTokenSignIn(), ctx, fakeGate([CRM]));
  const body = await (await page.get("t1")).text();
  assertStringIncludes(body, "matias&#39;s token for crm");
  assertStringIncludes(body, "$CRM_TOKEN");
  assertStringIncludes(body, "<li>api.crm.example</li>");
  assertStringIncludes(body, "<li>under /v1/</li>");
  assertStringIncludes(body, "Try it and store it");
  const over = await page.get("nope");
  assertEquals(over.status, 410);
  assertStringIncludes(await over.text(), "Ask for a new one");
});

Deno.test("token page: an empty paste or one the probe refuses asks again, the ticket open; a good one is stored and declares nothing", async () => {
  const { ctx, vault, declared } = pageCtx();
  const probed: string[] = [];
  const flow = createTokenSignIn({
    probe: (url, token) => {
      probed.push(`${url} ${token}`);
      return Promise.resolve({ status: token === "good" ? 200 : 401 });
    },
  });
  const gate = fakeGate([CRM]);
  const page = door(flow, ctx, gate);

  const empty = await page.post("t1", { token: " " });
  assertEquals(empty.status, 400);
  assertStringIncludes(await empty.text(), "Paste the token first.");
  const bad = await page.post("t1", { token: "bad" });
  assertStringIncludes(await bad.text(), "does not open https://api.crm.example/v1/me (HTTP 401)");
  assertEquals(gate.seen.judged, []);
  assertEquals(vault.size, 0);

  const good = await page.post("t1", { token: "good" });
  assertEquals(good.status, 200);
  assertStringIncludes(await good.text(), "The token for crm is stored.");
  assertEquals(gate.seen.judged, [{ ticket: "t1", who: { address: "token:crm:matias" } }]);
  assertEquals(gate.seen.landed, [{ ticket: "t1", account: "token:crm:matias" }]);
  assertEquals(vault.get("token:crm:matias"), {
    key: "token:crm:matias",
    value: { token: "good" },
    agentId: "matias",
    extra: { env: "CRM_TOKEN", hosts: ["api.crm.example"], paths: ["/v1/"] },
  });
  // the probe was spent once per paste, never again at the write
  assertEquals(probed.length, 2);
  assertEquals(flow.declares, false);
  assertEquals(declared, []);
});

Deno.test("token flow: a token the CLI would refuse is refused before a ticket opens", async () => {
  const { ctx } = pageCtx();
  const flow = createTokenSignIn();
  let err: Error | undefined;
  try {
    await flow.prepare({
      service: "token",
      agent: "matias",
      token: {
        name: "crm",
        env: "CRM_TOKEN",
        hosts: ["api.crm.example"],
        probe: "https://evil.example/",
      },
    }, ctx);
  } catch (e) {
    err = e as Error;
  }
  assertStringIncludes(err!.message, "outside --hosts");
});
