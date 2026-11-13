/**
 * sandbox: the local provider — one ground per agent, one shell per session, the file
 * scope beside it, and a close that leaves nothing running.
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { openLocalSandbox } from "./sandbox.ts";
import { storeAt } from "./store/mod.ts";
import { membersAt } from "./testing.ts";

Deno.test("a session's shell is its own and kept: where one stands, its sibling does not", async () => {
  const dir = await Deno.makeTempDir();
  const sandbox = await openLocalSandbox(dir, {
    store: storeAt({ engine: "sqlite", dir, docs: "filesystem" }),
    agents: ["a1"],
  });
  try {
    await Deno.mkdir(`${dir}/proj`);
    const mind = sandbox.forAgent("a1").session("mind");
    const build = sandbox.forAgent("a1").session("build");
    await build.stand(`${dir}/proj`);
    assertEquals((await build.ambient())[0], `cwd: ${dir}/proj`);
    assertEquals((await mind.ambient())[0], `cwd: ${dir}/agents/a1`);
    // the same session again is the same shell: the place it took stands
    assertEquals((await sandbox.forAgent("a1").session("build").ambient())[0], `cwd: ${dir}/proj`);
    assertEquals(build.home, `${dir}/agents/a1`);
    // the files port is the ground's: the agent's folder rides, the substrate is refused;
    // a relative reference is from where the session's own shell stands
    await Deno.writeTextFile(`${dir}/agents/a1/note.md`, "mine");
    assertEquals((await mind.files.resolve("note.md")).named, "note.md");
    assertEquals((await build.files.resolve("../agents/a1/note.md")).named, "note.md");
    await Deno.writeTextFile(`${dir}/log/log.db`, "x");
    await assertRejects(() => build.files.resolve(`${dir}/log/log.db`), Error, "outside");
    assertThrows(() => sandbox.forAgent("nobody"), Error, "no ground prepared");
  } finally {
    await sandbox.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the shell speaks through the proxy's pocket, in the org's locale and on its clock", async () => {
  const dir = await Deno.makeTempDir();
  const sandbox = await openLocalSandbox(dir, {
    store: storeAt({ engine: "sqlite", dir, docs: "filesystem" }),
    agents: ["a1"],
    locale: "es_AR.UTF-8",
    timezone: "Asia/Tokyo",
  });
  try {
    const { exec } = sandbox.forAgent("a1").session("mind");
    const out = await exec.bash.execute(
      {
        command: "echo $LANG; echo $HTTPS_PROXY; test -r $SSL_CERT_FILE && echo trusted; " +
          'test "$HTTP_PROXY" = "$HTTPS_PROXY" && test "$http_proxy" = "$HTTPS_PROXY" && ' +
          'test -z "${NO_PROXY+set}" && echo plain-too; ' +
          "echo $TZ; deno eval 'console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)'",
      },
      new AbortController().signal,
    );
    const text = typeof out === "string" ? out : (out as { output: string }).output;
    // the proxy URL names the agent by a nonce of its own
    assert(/^es_AR\.UTF-8\nhttp:\/\/a1:[0-9a-f]{32}@127\.0\.0\.1:\d+\n/.test(text), text);
    assert(text.includes("\ntrusted"), text);
    // plain HTTP goes through it as well, and nothing is left out of it
    assert(text.includes("\nplain-too"), text);
    // a program the agent runs reads the zone by itself: no flag, no variable of its own
    assert(text.includes("\nAsia/Tokyo\nAsia/Tokyo"), text);
  } finally {
    await sandbox.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a shell spends its own grant by the variable's name, and keeps reaching the proxy past a restart", async () => {
  const dir = await Deno.makeTempDir();
  // a local service the grant is declared for, port and all, so its token rides plain HTTP
  const origin = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen: () => {} },
    (req) => new Response(req.headers.get("authorization") ?? "-"),
  );
  const authority = `127.0.0.1:${origin.addr.port}`;
  const store = storeAt({ engine: "sqlite", dir, docs: "filesystem" });
  await membersAt(dir, "a1", "a2");
  const vault = await store.vault();
  await vault.put({
    key: "token:crm:a1",
    agentId: "a1",
    value: { token: "REAL" },
    extra: { env: "CRM_TOKEN", hosts: [authority] },
  });
  await vault.close();
  const curl = (sandbox: Awaited<ReturnType<typeof openLocalSandbox>>, agent: string) =>
    sandbox.forAgent(agent).session("mind").exec.bash.execute(
      {
        command: 'echo "$CRM_TOKEN|$NODE_USE_ENV_PROXY|$HTTPS_PROXY"; ' +
          `curl -s -H "Authorization: Bearer sentinel-CRM_TOKEN" http://${authority}/x`,
      },
      new AbortController().signal,
    ).then((out) => typeof out === "string" ? out : (out as { output: string }).output);
  try {
    let sandbox = await openLocalSandbox(dir, { store, agents: ["a1", "a2"] });
    const [said, spent] = (await curl(sandbox, "a1")).split("\n");
    const [placeholder, node, url] = said.split("|");
    assertEquals([placeholder, node, spent], ["sentinel-CRM_TOKEN", "1", "Bearer REAL"]);
    // a peer reaching for a1's variable is refused, and never reaches the service
    assertEquals(
      (await curl(sandbox, "a2")).split("\n")[1],
      "liquen proxy: CRM_TOKEN is no grant of a2's",
    );
    await sandbox.close();
    // the next harness answers at the same address, to the same nonce
    sandbox = await openLocalSandbox(dir, { store, agents: ["a1", "a2"] });
    const [again, spentAgain] = (await curl(sandbox, "a1")).split("\n");
    assertEquals(again.split("|")[2], url);
    assertEquals(spentAgain, "Bearer REAL");
    assertEquals((await Deno.stat(`${dir}/system/proxy.json`)).mode! & 0o777, 0o600);
    await sandbox.close();
  } finally {
    await origin.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an agent's shell inherits the variables it exports, as the harness holds them at the call", async () => {
  const dir = await Deno.makeTempDir();
  const sandbox = await openLocalSandbox(dir, {
    store: storeAt({ engine: "sqlite", dir, docs: "filesystem" }),
    agents: ["a1", "a2"],
    exports: (agentId) => agentId === "a1" ? ["LIQUEN_TEST_DISPLAY", "LIQUEN_TEST_UNSET"] : [],
  });
  const say = async (agent: string) => {
    const out = await sandbox.forAgent(agent).session("mind").exec.bash.execute(
      { command: 'echo "[$LIQUEN_TEST_DISPLAY] [${LIQUEN_TEST_UNSET-unset}]"' },
      new AbortController().signal,
    );
    return (typeof out === "string" ? out : (out as { output: string }).output).trim();
  };
  try {
    Deno.env.set("LIQUEN_TEST_DISPLAY", ":0");
    assertEquals(await say("a1"), "[:0] [unset]");
    assertEquals(await say("a2"), "[] [unset]"); // another agent's export is not its own
    Deno.env.set("LIQUEN_TEST_DISPLAY", ":1");
    assertEquals(await say("a1"), "[:1] [unset]");
  } finally {
    Deno.env.delete("LIQUEN_TEST_DISPLAY");
    await sandbox.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a ground is added and removed while the sandbox stands: one agent's shells end, no one else's", async () => {
  const dir = await Deno.makeTempDir();
  const sandbox = await openLocalSandbox(dir, {
    store: storeAt({ engine: "sqlite", dir, docs: "filesystem" }),
    agents: ["a1"],
  });
  try {
    assertThrows(() => sandbox.forAgent("a2"), Error, "no ground prepared");
    await sandbox.add("a2");
    await sandbox.add("a2"); // a ground already there stands
    const peer = sandbox.forAgent("a1").session("mind");
    const mine = sandbox.forAgent("a2").session("mind");
    assertEquals((await mine.ambient())[0], `cwd: ${dir}/agents/a2`);
    const state = () => Deno.readTextFile(`${dir}/system/proxy.json`).then(JSON.parse);
    await mine.exec.bash.execute({ command: "true" }, new AbortController().signal);
    assertEquals(Object.keys((await state()).nonces), ["a2"]);
    await sandbox.remove("a2");
    assertThrows(() => sandbox.forAgent("a2"), Error, "no ground prepared");
    assertEquals(Object.keys((await state()).nonces), []); // its way out is gone with it
    assertEquals((await peer.ambient())[0], `cwd: ${dir}/agents/a1`);
  } finally {
    await sandbox.close();
    await Deno.remove(dir, { recursive: true });
  }
});
