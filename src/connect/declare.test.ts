import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { declared, pickPorts, requireIngest } from "./declare.ts";
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

/** A fresh org: the catalog materialized, nothing declared. */
async function org(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/config.jsonc`, materialize(starterConfig()));
  return root;
}

Deno.test("requireIngest: a fresh org gets the declaration, then the refusal — nobody is on the port", async () => {
  const root = await org();
  try {
    const probe = Deno.listen({ port: 0 });
    const free = (probe.addr as Deno.NetAddr).port;
    probe.close();
    const err = await assertRejects(() => requireIngest(root, spec(free), {}, 30));
    assertStringIncludes((err as Error).message, `nothing is listening on :${free}`);
    assertStringIncludes((err as Error).message, "liquen start");
    // the file now says the org has acme — `liquen start` runs it from here on
    assertStringIncludes(await Deno.readTextFile(`${root}/config.jsonc`), '"acme": {}');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("requireIngest: a held port on a declared org is an open door — the door goes on", async () => {
  const root = await org();
  try {
    await held(async (port) => {
      // the org already runs acme on `port` — so the file already says so (a fresh org
      // meeting a held default would STEP OVER it: that is a sibling's, `pickPorts`)
      await declared(root, spec(port), { ingestPort: port });
      await requireIngest(root, spec(port), {}, 30); // resolves
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("requireIngest: port 0 is nobody's address — nothing to protect, nothing asked", async () => {
  const root = await org();
  try {
    await requireIngest(root, spec(0), {}, 30);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("requireIngest: it waits — an org started in the next terminal is found, not refused", async () => {
  const root = await org();
  try {
    const probe = Deno.listen({ port: 0 });
    const free = (probe.addr as Deno.NetAddr).port;
    probe.close();
    let late: Deno.Listener | undefined;
    const arrives = setTimeout(() => {
      late = Deno.listen({ port: free });
    }, 80);
    try {
      await requireIngest(root, spec(free), {}, 3_000); // resolves once the listener is up
    } finally {
      clearTimeout(arrives);
      late?.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
