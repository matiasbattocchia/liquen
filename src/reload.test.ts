import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { moved, type Moves, owedLines, reconcile, reload, runSocket } from "./reload.ts";
import { serveSocket } from "./connect/serve.ts";
import { materialize, starterConfig } from "./config.ts";
import { readConfig } from "./org.ts";
import { openStore } from "./store/mod.ts";

async function org(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/config.yaml`, materialize(starterConfig()));
  return root;
}

const still: Moves = { stop: [], restart: [], start: [], owed: [] };

/** A run standing in for the supervisor: answers every poke with `answer`, and keeps what
 *  each asked to restart. */
async function run(root: string, answer: Moves | string) {
  const asked: string[][] = [];
  const server = await serveSocket(runSocket(root), async (req) => {
    asked.push((await req.json()).restart);
    return typeof answer === "string"
      ? new Response(answer, { status: 409 })
      : Response.json(answer);
  });
  return { asked, close: () => server.shutdown() };
}

Deno.test("reload: the file is applied here, then the run is poked and answers with what moved; no run, the moves are null", async () => {
  const root = await org();
  try {
    await Deno.writeTextFile(
      `${root}/config.yaml`,
      "shared:\n  agents:\n    model: claude-x\nagents:\n  ana:\n    identity:\n      phone: +5491155550001\n",
    );
    assertEquals(await reload(root), { conflicts: [], moves: null, agents: null });
    const cfg = await readConfig(root);
    assertEquals(cfg.shared.agents.model, "claude-x");
    // a bare phone is read as a number, and taken as its digits
    assertEquals(cfg.agents.ana.identity, { name: null, email: null, phone: "5491155550001" });
    const moves: Moves = { ...still, start: ["whatsapp"] };
    const supervisor = await run(root, moves);
    try {
      assertEquals((await reload(root)).moves, moves);
      assertEquals(await reconcile(root, ["slack"]), moves);
      assertEquals(supervisor.asked, [[], ["slack"]]);
    } finally {
      await supervisor.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reload: a key a command moved and the file moved apart is a conflict, and --overwrite takes the file's", async () => {
  const root = await org();
  try {
    await Deno.writeTextFile(`${root}/config.yaml`, "shared:\n  agents:\n    model: claude-a\n");
    await reload(root);
    const log = await (await openStore(root)).log();
    try {
      await log.setConfig([{ scope: "shared.agents", key: "model", value: "claude-cmd" }]);
    } finally {
      await log.close();
    }
    await Deno.writeTextFile(`${root}/config.yaml`, "shared:\n  agents:\n    model: claude-b\n");
    assertEquals((await reload(root)).conflicts, [
      { path: "shared.agents.model", file: "claude-b", store: "claude-cmd" },
    ]);
    assertEquals((await readConfig(root)).shared.agents.model, "claude-cmd");
    assertEquals((await reload(root, { overwrite: true })).conflicts, []);
    assertEquals((await readConfig(root)).shared.agents.model, "claude-b");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reload: a file boot would reject is the command's refusal, and the run is never asked", async () => {
  const root = await org();
  const supervisor = await run(root, still);
  try {
    await Deno.writeTextFile(`${root}/config.yaml`, `{ "sytem": {} }`);
    const err = await assertRejects(() => reload(root));
    assertStringIncludes((err as Error).message, `unknown section "sytem"`);
    assertEquals(supervisor.asked, []);
  } finally {
    await supervisor.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reconcile: what the run refuses on is thrown as its sentence", async () => {
  const root = await org();
  const supervisor = await run(root, "no process named foo — the run is main · edge");
  try {
    const err = await assertRejects(() => reconcile(root, ["foo"]));
    assertEquals((err as Error).message, "no process named foo — the run is main · edge");
  } finally {
    await supervisor.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("moved: the moves in words, or that nothing changed; what is owed, with the restart that pays it", () => {
  assertEquals(moved(still), "no process moved");
  assertEquals(
    moved({ ...still, stop: ["google"], restart: ["slack"], start: ["whatsapp"] }),
    "google stopped · slack restarted · whatsapp started",
  );
  assertEquals(owedLines([{ path: "edge.port", processes: ["edge"] }]), [
    "edge.port changed: `liquen restart edge` takes it up",
  ]);
});
