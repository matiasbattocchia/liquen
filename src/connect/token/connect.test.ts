import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { connectToken, contention, parseTokenArgs, tokenKey } from "./connect.ts";
import { openCredentials } from "../../store/credentials.ts";
import { frontedFor } from "../../proxy/grants.ts";

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

const BASE = ["crm", "--env", "CRM_TOKEN", "--hosts", "api.crm.io,*.crm.io"];

Deno.test("parseTokenArgs: name, env, hosts; the org by default, an agent by flag", () => {
  assertEquals(parseTokenArgs(BASE), {
    name: "crm",
    env: "CRM_TOKEN",
    hosts: ["api.crm.io", "*.crm.io"],
  });
  assertEquals(parseTokenArgs([...BASE, "--org"]).agentId, undefined);
  assertEquals(parseTokenArgs([...BASE, "--agent", "ana"]).agentId, "ana");
  assertEquals(
    parseTokenArgs([...BASE, "--probe", "https://api.crm.io/me"]).probe,
    "https://api.crm.io/me",
  );
});

Deno.test("parseTokenArgs: refuses what the proxy could not front", () => {
  const bad = (argv: string[], word: string) => {
    const err = assertThrows(() => parseTokenArgs(argv), Error);
    assert(err.message.includes(word), `${err.message} should mention ${word}`);
  };
  bad(["--env", "X", "--hosts", "a.io"], "name is required");
  bad(["Crm", "--env", "X", "--hosts", "a.io"], "lowercase");
  bad(["crm", "--hosts", "a.io"], "--env is required");
  bad(["crm", "--env", "crm-token", "--hosts", "a.io"], "environment variable");
  bad(["crm", "--env", "X"], "--hosts is required");
  bad(["crm", "--env", "X", "--hosts", "not a host"], "hostnames");
  bad([...BASE, "--org", "--agent", "ana"], "not both");
  bad([...BASE, "--probe", "nope"], "is a URL");
  bad([...BASE, "--probe", "https://evil.io/echo"], "outside --hosts");
  bad([...BASE, "--nope"], "unknown flag");
  bad([...BASE, "other"], "one name");
  bad(["crm", "--env"], "needs a value");
});

Deno.test("tokenKey: the org's by name, an agent's by name and id", () => {
  assertEquals(tokenKey("crm"), "token:crm");
  assertEquals(tokenKey("crm", "ana"), "token:crm:ana");
});

Deno.test("connectToken: one vault row — static token, env + hosts on the sidecar", async () => {
  await withVault(async (creds) => {
    const { key, contention } = await connectToken(parseTokenArgs(BASE), " tok-1 \n", { creds });
    assertEquals(key, "token:crm");
    assertEquals(contention, undefined);
    const row = await creds.get("token:crm");
    assertEquals(row?.value, { token: "tok-1" });
    assertEquals(row?.agentId, undefined);
    assertEquals(row?.extra, { env: "CRM_TOKEN", hosts: ["api.crm.io", "*.crm.io"] });
    // what main fronts: the org's row, in every pocket
    assertEquals(frontedFor([row!], "ana").map((r) => r.key), ["token:crm"]);
    assertEquals(frontedFor([row!], "bo").map((r) => r.key), ["token:crm"]);
  });
});

Deno.test("connectToken: an agent's own is fronted in its pocket alone", async () => {
  await withVault(async (creds) => {
    const { key } = await connectToken(parseTokenArgs([...BASE, "--agent", "ana"]), "tok-a", {
      creds,
    });
    assertEquals(key, "token:crm:ana");
    const row = await creds.get(key);
    assertEquals(row?.agentId, "ana");
    assertEquals(frontedFor([row!], "ana").map((r) => r.key), ["token:crm:ana"]);
    assertEquals(frontedFor([row!], "bo"), []);
  });
});

Deno.test("connectToken: the probe spends the token first, and a refusal writes nothing", async () => {
  await withVault(async (creds) => {
    const seen: [string, string][] = [];
    const args = parseTokenArgs([...BASE, "--probe", "https://api.crm.io/me"]);
    await assertRejects(
      () =>
        connectToken(args, "bad", {
          creds,
          probe: (url, token) => {
            seen.push([url, token]);
            return Promise.resolve({ status: 401 });
          },
        }),
      Error,
      "HTTP 401",
    );
    assertEquals(seen, [["https://api.crm.io/me", "bad"]]);
    assertEquals(await creds.get("token:crm"), null);
    await connectToken(args, "good", { creds, probe: () => Promise.resolve({ status: 200 }) });
    assertEquals((await creds.get("token:crm"))?.value.token, "good");
  });
});

Deno.test("connectToken: an empty token writes nothing", async () => {
  await withVault(async (creds) => {
    await assertRejects(() => connectToken(parseTokenArgs(BASE), "  ", { creds }), Error, "empty");
    assertEquals(await creds.list("token:"), []);
  });
});

Deno.test("contention: says what frontedFor will do with the var", () => {
  const org = { key: "token:crm", extra: { env: "T" } };
  const org2 = { key: "github:org", extra: { env: "T" } };
  const ana = { key: "token:crm:ana", agentId: "ana", extra: { env: "T" } };
  const ana2 = { key: "token:x:ana", agentId: "ana", extra: { env: "T" } };
  const bo = { key: "token:crm:bo", agentId: "bo", extra: { env: "T" } };
  const other = { key: "token:y", extra: { env: "U" } };
  assertEquals(contention([org, other, bo], org), undefined);
  assertEquals(contention([ana, bo, other], ana), undefined);
  assert(contention([org, org2], org)?.includes("nobody gets either"));
  assert(contention([org, ana], ana)?.includes("never fronted"));
  assert(contention([ana, ana2], ana)?.includes("neither"));
});

Deno.test("connectToken: names the contention on the row it wrote", async () => {
  await withVault(async (creds) => {
    await creds.put({
      key: "github:org",
      value: { token: "g" },
      extra: { env: "GH_TOKEN", hosts: [] },
    });
    const { contention } = await connectToken(
      parseTokenArgs(["gh", "--env", "GH_TOKEN", "--hosts", "api.github.com", "--agent", "ana"]),
      "t",
      { creds },
    );
    assert(contention?.includes("github:org"), contention);
  });
});
