import { assertEquals, assertStringIncludes } from "@std/assert";
import { declared, pickPorts } from "./declare.ts";
import { checkPort, type ConnectorSpec, materialize, starterConfig } from "../config.ts";

const spec = (port: number): ConnectorSpec => ({
  name: "acme",
  doc: "acme — a connector with an address",
  entries: [
    { key: "ingestPort", value: port, doc: "where the peer POSTs", check: checkPort },
    { key: "bridgeUrl", value: "http://localhost:1", doc: "the peer", check: () => null },
  ],
});

/** A port this machine is listening on for as long as `body` runs. */
async function held(body: (port: number) => Promise<void>): Promise<void> {
  const l = Deno.listen({ port: 0 });
  try {
    await body((l.addr as Deno.NetAddr).port);
  } finally {
    l.close();
  }
}

Deno.test("pickPorts: silence when the default is free — the subsection keeps the default", () => {
  const l = Deno.listen({ port: 0 });
  const free = (l.addr as Deno.NetAddr).port;
  l.close(); // nobody is on it now
  assertEquals(pickPorts(spec(free)), {});
});

Deno.test("pickPorts: a taken default is stepped over, only the port moves", async () => {
  await held(async (port) => {
    assertEquals(pickPorts(spec(port)), { ingestPort: port + 1 });
    await Promise.resolve();
  });
});

Deno.test("pickPorts: what the door already decided is the door's", async () => {
  await held(async (port) => {
    assertEquals(pickPorts(spec(port), { ingestPort: port }), {});
    await Promise.resolve();
  });
});

Deno.test("pickPorts: 0 is already any free port", () => {
  assertEquals(pickPorts(spec(0)), {});
});

Deno.test("declared: the free port lands in config.jsonc with what the door earned", async () => {
  const root = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${root}/config.jsonc`, materialize(starterConfig()));
    let taken = 0;
    await held(async (port) => {
      taken = port;
      await declared(root, spec(port), { organizationId: "acme" });
    });
    const raw = await Deno.readTextFile(`${root}/config.jsonc`);
    // the door's own knob and the port it had to move, on the one line declareIn writes
    assertStringIncludes(raw, `"acme": {"organizationId":"acme","ingestPort":${taken + 1}}`);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
