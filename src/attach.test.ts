import { assertEquals, assertThrows } from "@std/assert";
import { type Reply, tuneFlags, wire } from "./attach.ts";

Deno.test("tuneFlags: the model flags are spliced out, and a word the harness lacks fails here", () => {
  // the flags leave the argv, so a surface's own parsing sees only its own words
  const args = ["laura", "--effort", "high", "--session", "build", "--model", "claude-y"];
  assertEquals(tuneFlags(args), { model: "claude-y", effort: "high" });
  assertEquals(args, ["laura", "--session", "build"]);
  assertEquals(tuneFlags(["laura"]), {}); // none given: the roster's values stand
  // a level or a provider the harness has no word for is refused before anything attaches;
  // a model's NAME is the daemon's to judge, against the provider
  assertThrows(() => tuneFlags(["--effort", "extreme"]), Error, "one of low, medium");
  assertThrows(() => tuneFlags(["--provider", "acme"]), Error, "one of anthropic, google");
  assertThrows(() => tuneFlags(["--model"]), Error, "--model needs a word");
  assertThrows(() => tuneFlags(["--model", "--session", "x"]), Error, "--model needs a word");
});

Deno.test("wire: a request in flight when the daemon hangs up is answered, not left hanging", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/door.sock`;
  const listener = Deno.listen({ transport: "unix", path });
  const server = (async () => {
    const conn = await listener.accept();
    conn.close(); // hangs up without a word
    listener.close();
  })();
  const conn = await Deno.connect({ transport: "unix", path });
  try {
    const w = wire(conn, { event: () => {}, delta: () => {} });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reply = await Promise.race([
      w.request({ op: "tail" }),
      new Promise<string>((r) => (timer = setTimeout(() => r("hung"), 1_000))),
    ]);
    clearTimeout(timer);
    assertEquals(typeof reply, "object");
    assertEquals((reply as Reply).ok, false);
    await w.hangup;
  } finally {
    await server;
    try {
      conn.close();
    } catch { /* already closed under the pump */ }
    await Deno.remove(dir, { recursive: true });
  }
});
