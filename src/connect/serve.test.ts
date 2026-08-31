import { assert, assertEquals, assertThrows } from "@std/assert";
import { serveIngest } from "./serve.ts";

Deno.test("serveIngest: 0 binds a free port and announces it; a taken port names its knob", async () => {
  let bound = 0;
  const srv = serveIngest(
    "connections.x.ingestPort",
    0,
    () => new Response("ok"),
    (p) => (bound = p),
  );
  assertEquals(bound, (srv.addr as Deno.NetAddr).port);
  assert(bound > 0);
  const res = await fetch(`http://localhost:${bound}/`);
  assertEquals(await res.text(), "ok");
  assertThrows(
    () => serveIngest("connections.x.ingestPort", bound, () => new Response(null), () => {}),
    Error,
    `port ${bound} in use — another org running? set connections.x.ingestPort`,
  );
  await srv.shutdown();
});
