/**
 * sandbox: the local provider — one ground per agent, one shell per session, the file
 * scope beside it, and a close that leaves nothing running.
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { openLocalSandbox } from "./sandbox.ts";
import { storeAt } from "./store/mod.ts";

Deno.test("a session's shell is its own and kept: where one stands, its sibling does not", async () => {
  const dir = await Deno.makeTempDir();
  const sandbox = await openLocalSandbox(dir, {
    store: storeAt({ engine: "sqlite", dir }),
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
    assertEquals((await mind.files.resolve("note.md")).file.name, "note.md");
    assertEquals((await build.files.resolve("../agents/a1/note.md")).file.name, "note.md");
    await Deno.writeTextFile(`${dir}/log/log.db`, "x");
    await assertRejects(() => build.files.resolve(`${dir}/log/log.db`), Error, "outside");
    assertThrows(() => sandbox.forAgent("nobody"), Error, "no ground prepared");
  } finally {
    await sandbox.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the shell speaks through the proxy's pocket and the org's locale", async () => {
  const dir = await Deno.makeTempDir();
  const sandbox = await openLocalSandbox(dir, {
    store: storeAt({ engine: "sqlite", dir }),
    agents: ["a1"],
    locale: "es_AR.UTF-8",
  });
  try {
    const { exec } = sandbox.forAgent("a1").session("mind");
    const out = await exec.bash.execute(
      { command: "echo $LANG; echo $HTTPS_PROXY; test -r $SSL_CERT_FILE && echo trusted" },
      new AbortController().signal,
    );
    const text = typeof out === "string" ? out : (out as { output: string }).output;
    assert(text.startsWith("es_AR.UTF-8\nhttp://127.0.0.1:"), text);
    assert(text.includes("\ntrusted"), text);
  } finally {
    await sandbox.close();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an agent's shell inherits the variables it exports, as the harness holds them at the call", async () => {
  const dir = await Deno.makeTempDir();
  const sandbox = await openLocalSandbox(dir, {
    store: storeAt({ engine: "sqlite", dir }),
    agents: ["a1", "a2"],
    exports: { a1: ["LIQUEN_TEST_DISPLAY", "LIQUEN_TEST_UNSET"] },
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
