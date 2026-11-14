import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { agentTool } from "./agent.ts";
import { applyFile } from "../org.ts";
import { openStore } from "../store/mod.ts";
import type { Log } from "../store/log.ts";
import { onFiles } from "../store/seed.ts";

async function withOrg(fn: (root: string, log: Log) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/config.yaml`, "{}");
  const log = await (await openStore(root)).log();
  try {
    await applyFile(root, log);
    await fn(root, log);
  } finally {
    await log.close();
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("agent: makes the agent with its handles, lays its docs, and brings it up", async () => {
  await withOrg(async (root, log) => {
    const up: string[] = [];
    const tool = agentTool({
      root,
      log,
      docs: onFiles(`${root}/data`),
      up: (id) => {
        up.push(id);
        return Promise.resolve(`${id} up`);
      },
    });
    const said = await tool.execute(
      { id: "ana", name: "Ana", email: "ana@example.com" },
      new AbortController().signal,
    );
    assertStringIncludes(String(said), "ana made, and ana up");
    const row = (await log.agents()).find((a) => a.agentId === "ana")!;
    assertEquals([row.name, row.email, row.phone], ["Ana", "ana@example.com", undefined]);
    assertEquals(up, ["ana"]);
    await Deno.stat(`${root}/data/agents/ana/instructions.md`);
  });
});

Deno.test("agent: an id that exists is refused, and nothing changes", async () => {
  await withOrg(async (root, log) => {
    const tool = agentTool({
      root,
      log,
      docs: onFiles(`${root}/data`),
      up: () => Promise.resolve("up"),
    });
    await tool.execute({ id: "ana", email: "ana@example.com" }, new AbortController().signal);
    await assertRejects(
      () => tool.execute({ id: "ana", email: "eve@example.com" }, new AbortController().signal),
      Error,
      "changing an agent is the CLI's",
    );
    assertEquals((await log.agents()).find((a) => a.agentId === "ana")!.email, "ana@example.com");
    await assertRejects(
      () => tool.execute({ id: "Not A Name" }, new AbortController().signal),
      Error,
      "lowercase letters",
    );
  });
});
