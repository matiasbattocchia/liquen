import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { moved, type Moves, reload, runSocket } from "./reload.ts";
import { serveSocket } from "./connect/serve.ts";
import { materialize, starterConfig } from "./config.ts";
import { readConfig } from "./org.ts";

async function org(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/config.yaml`, materialize(starterConfig()));
  return root;
}

/** A run standing in for the supervisor: answers every reload with `answer`, and keeps
 *  what each asked to restart. */
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

Deno.test("reload: the run is asked over its socket and answers with what moved; no run, the file is applied here and the answer is null", async () => {
  const root = await org();
  try {
    await Deno.writeTextFile(
      `${root}/config.yaml`,
      "shared:\n  agents:\n    model: claude-x\nagents:\n  ana:\n    identity:\n      phone: +5491155550001\n",
    );
    assertEquals(await reload(root), null);
    const cfg = await readConfig(root);
    assertEquals(cfg.shared.agents.model, "claude-x");
    // a bare phone is read as a number, and taken as its digits
    assertEquals(cfg.agents.ana.identity, { name: null, email: null, phone: "5491155550001" });
    const moves = { stop: [], restart: ["slack"], start: ["whatsapp"] };
    const supervisor = await run(root, moves);
    try {
      assertEquals(await reload(root), moves);
      assertEquals(await reload(root, ["slack"]), moves);
      assertEquals(supervisor.asked, [[], ["slack"]]);
    } finally {
      await supervisor.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reload: a file boot would reject is the command's refusal, and the run is never asked", async () => {
  const root = await org();
  const supervisor = await run(root, { stop: [], restart: [], start: [] });
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

Deno.test("reload: what the run refuses on is thrown as its sentence", async () => {
  const root = await org();
  const supervisor = await run(root, "no process named foo — the run is main · edge");
  try {
    const err = await assertRejects(() => reload(root, ["foo"]));
    assertEquals((err as Error).message, "no process named foo — the run is main · edge");
  } finally {
    await supervisor.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("moved: the moves in words, or that nothing changed", () => {
  assertEquals(moved({ stop: [], restart: [], start: [] }), "no process moved");
  assertEquals(
    moved({ stop: ["google"], restart: ["slack"], start: ["whatsapp"] }),
    "google stopped · slack restarted · whatsapp started",
  );
});
