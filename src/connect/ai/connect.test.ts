import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { connectAi, parseAiArgs, refusal } from "./connect.ts";
import { openCredentials } from "../../store/credentials.ts";
import { removeConnection } from "../remove.ts";

async function withVault(
  fn: (creds: Awaited<ReturnType<typeof openCredentials>>) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const creds = await openCredentials(dir);
  try {
    await fn(creds);
  } finally {
    await creds.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const took = () => Promise.resolve();

Deno.test("parseAiArgs: a provider; the org by default, an agent by flag; tried unless told", () => {
  assertEquals(parseAiArgs(["google"]), { provider: "google", probe: true });
  assertEquals(parseAiArgs(["anthropic", "--org"]).agentId, undefined);
  assertEquals(parseAiArgs(["google", "--agent", "ana"]).agentId, "ana");
  assertEquals(parseAiArgs(["google", "--no-probe"]).probe, false);
});

Deno.test("parseAiArgs: refuses what no transport could spend", () => {
  const bad = (argv: string[], word: string) => {
    const err = assertThrows(() => parseAiArgs(argv), Error);
    assert(err.message.includes(word), `${err.message} should mention ${word}`);
  };
  bad([], "provider is required");
  bad(["openai"], 'no provider "openai"');
  bad(["google", "anthropic"], "one provider");
  bad(["google", "--org", "--agent", "ana"], "not both");
  bad(["google", "--agent"], "needs a value");
  bad(["google", "--nope"], "unknown flag");
});

Deno.test("connectAi: the org's key, tried first, one vault row", async () => {
  await withVault(async (creds) => {
    const tried: string[] = [];
    const { key, spentBy } = await connectAi(parseAiArgs(["google"]), " AIza-1 \n", {
      creds,
      probe: (p, k) => (tried.push(`${p}:${k}`), took()),
    });
    assertEquals(key, "ai:google");
    assertEquals(tried, ["google:AIza-1"]);
    assertEquals(spentBy, "every agent on google that holds no key of its own");
    const row = await creds.get("ai:google");
    assertEquals(row?.value, { api_key: "AIza-1" });
    assertEquals(row?.agentId, undefined);
  });
});

Deno.test("connectAi: an agent's own lands under its key, owned by it", async () => {
  await withVault(async (creds) => {
    const { key } = await connectAi(parseAiArgs(["anthropic", "--agent", "ana"]), "sk", {
      creds,
      probe: took,
    });
    assertEquals(key, "ai:anthropic:ana");
    assertEquals((await creds.get(key))?.agentId, "ana");
  });
});

Deno.test("connectAi: a refused key writes nothing; --no-probe never asks", async () => {
  await withVault(async (creds) => {
    await assertRejects(
      () =>
        connectAi(parseAiArgs(["google"]), "bad", {
          creds,
          probe: () => Promise.reject(new Error("400 API key not valid")),
        }),
      Error,
      "google refused the key (400 API key not valid) — nothing written",
    );
    assertEquals(await creds.get("ai:google"), null);
    await connectAi(parseAiArgs(["google", "--no-probe"]), "untried", {
      creds,
      probe: () => Promise.reject(new Error("asked")),
    });
    assertEquals((await creds.get("ai:google"))?.value, { api_key: "untried" });
  });
});

Deno.test("connectAi: an empty key writes nothing", async () => {
  await withVault(async (creds) => {
    await assertRejects(() => connectAi(parseAiArgs(["google"]), "  ", { creds }), Error, "empty");
    assertEquals(await creds.list(""), []);
  });
});

Deno.test("a model key comes back out by its vault key", async () => {
  await withVault(async (creds) => {
    await connectAi(parseAiArgs(["google", "--agent", "ana"]), "k", { creds, probe: took });
    const said = await removeConnection("ai:google:ana", {
      store: { connections: () => Promise.resolve([]), deleteConnections: () => Promise.resolve() },
      creds,
      undeclare: () => Promise.resolve(false),
      services: ["token", "ai"],
    });
    assertEquals(said, ["ai:google:ana is out of the vault"]);
    assertEquals(await creds.get("ai:google:ana"), null);
  });
});

Deno.test("refusal: Google's JSON body says its own sentence; anything else passes as it is", () => {
  const body = JSON.stringify({ error: { code: 400, message: "API key not valid.", details: [] } });
  assertEquals(refusal(new Error(body)), "400 API key not valid.");
  assertEquals(refusal(new Error("401 invalid x-api-key")), "401 invalid x-api-key");
});
