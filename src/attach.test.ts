import { assertEquals } from "@std/assert";
import { type Reply, wire } from "./attach.ts";

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
    let timer: number | undefined;
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
