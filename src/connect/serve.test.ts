import { assert, assertEquals, assertThrows } from "@std/assert";
import { ingestUp, serveIngest } from "./serve.ts";

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

Deno.test("ingestUp: a served port answers, a free one does not", async () => {
  // a free port: the door asking about an org nobody started
  const probe = Deno.listen({ port: 0 });
  const free = (probe.addr as Deno.NetAddr).port;
  probe.close();
  assertEquals(await ingestUp(free), false);

  // the same port once an ingest holds it
  const srv = serveIngest("connections.x.ingestPort", free, () => new Response("ok"), () => {});
  try {
    assertEquals(await ingestUp(free), true);
  } finally {
    await srv.shutdown();
  }
});
