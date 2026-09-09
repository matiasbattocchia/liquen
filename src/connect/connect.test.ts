import { assert, assertEquals, assertThrows } from "@std/assert";
import { available, resolveConnect } from "./connect.ts";

/** A fake org: a custom connector with a connect door, and one without. */
async function withOrg(fn: (org: string) => void): Promise<void> {
  const org = await Deno.makeTempDir();
  const put = async (rel: string) => {
    const p = `${org}/${rel}`;
    await Deno.mkdir(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(p, "// door");
  };
  try {
    await put("connectors/acme/connect.ts");
    await put("connectors/hooks/ingest.ts"); // a connector WITHOUT a connect door
    fn(org);
  } finally {
    await Deno.remove(org, { recursive: true });
  }
}

Deno.test("a shipped service resolves beside the front door — no filesystem probe", async () => {
  await withOrg((org) => {
    assertEquals(
      resolveConnect("slack", org),
      new URL("./slack/connect.ts", import.meta.url).href,
    );
    // shipped names resolve by the map, not by stat: the fake org holds none of them
    assertEquals(
      resolveConnect("github", org),
      new URL("./github/connect.ts", import.meta.url).href,
    );
  });
});

Deno.test("a custom connector resolves at <org>/connectors/<name>/connect.ts", async () => {
  await withOrg((org) => {
    assertEquals(resolveConnect("acme", org), `${org}/connectors/acme/connect.ts`);
  });
});

Deno.test("a path with a slash passes through as given", () => {
  assertEquals(resolveConnect("./anywhere/connect.ts", "/nowhere"), "./anywhere/connect.ts");
});

Deno.test("an unknown name fails listing every door that exists", async () => {
  await withOrg((org) => {
    const err = assertThrows(() => resolveConnect("nope", org), Error);
    assert(err.message.includes("acme"), "custom doors are advertised");
    assert(err.message.includes("slack"), "shipped doors are advertised");
    assert(!err.message.includes("hooks"), "a connector without a connect door is not");
  });
});

Deno.test("available = shipped + custom doors, doorless connectors excluded", async () => {
  await withOrg((org) => {
    assertEquals(available(org), ["slack", "google", "whatsapp", "github", "acme"]);
  });
});
