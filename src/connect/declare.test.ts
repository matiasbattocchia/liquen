import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { declared, requireEdge, requireIngest } from "./declare.ts";
import { serveIngest } from "./serve.ts";
import { claim, RELOAD, SUPERVISOR } from "../stop.ts";
import { type ConnectorSpec, materialize, starterConfig } from "../config.ts";

const spec: ConnectorSpec = {
  name: "acme",
  doc: "acme — a connector with a peer",
  entries: [
    { key: "bridgeUrl", value: "http://localhost:1", doc: "the peer", check: () => null },
  ],
};

/** A fresh org: the catalog materialized, nothing declared. */
async function org(edgePort?: number): Promise<string> {
  const root = await Deno.makeTempDir();
  const cfg = starterConfig();
  if (edgePort !== undefined) cfg.edge.port = edgePort;
  await Deno.writeTextFile(`${root}/config.jsonc`, materialize(cfg));
  return root;
}

Deno.test("declared: what the door earned lands in config.jsonc; a section the file has is left as found", async () => {
  const root = await org();
  try {
    await declared(root, spec, { organizationId: "acme" });
    const raw = await Deno.readTextFile(`${root}/config.jsonc`);
    assertStringIncludes(raw, `"acme": {"organizationId":"acme"}`);
    await declared(root, spec, { organizationId: "other" });
    assertStringIncludes(
      await Deno.readTextFile(`${root}/config.jsonc`),
      `"organizationId":"acme"`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("requireIngest: a fresh org gets the declaration, then the refusal — nobody is on the socket", async () => {
  const root = await org();
  try {
    const err = await assertRejects(() => requireIngest(root, spec, {}, 30));
    assertStringIncludes(
      (err as Error).message,
      `nothing is listening at ${root}/data/run/acme.sock`,
    );
    assertStringIncludes((err as Error).message, "liquen start");
    // the file now says the org has acme — `liquen start` runs it from here on
    assertStringIncludes(await Deno.readTextFile(`${root}/config.jsonc`), '"acme": {}');
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("requireIngest: a served socket is an open door — the door goes on", async () => {
  const root = await org();
  try {
    const srv = await serveIngest(root, "acme", () => new Response("ok"));
    try {
      await requireIngest(root, spec, {}, 30); // resolves
    } finally {
      await srv.shutdown();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("requireIngest: it waits — an org started in the next terminal is found, not refused", async () => {
  const root = await org();
  try {
    let late: Promise<Deno.HttpServer<Deno.UnixAddr>> | undefined;
    const arrives = setTimeout(() => {
      late = serveIngest(root, "acme", () => new Response("ok"));
    }, 80);
    try {
      await requireIngest(root, spec, {}, 3_000); // resolves once the listener is up
    } finally {
      clearTimeout(arrives);
      await (await late)?.shutdown();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("requireEdge: nobody on edge.port is the refusal, the edge up is the go-ahead", async () => {
  const probe = Deno.listen({ port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const root = await org(port);
  try {
    const err = await assertRejects(() => requireEdge(root, 30));
    assertStringIncludes((err as Error).message, `nothing is listening on :${port}`);
    const edge = Deno.listen({ hostname: "127.0.0.1", port });
    try {
      await requireEdge(root, 30);
    } finally {
      edge.close();
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("declared: a running org is reloaded — the run's supervisor is sent RELOAD", async () => {
  const root = await org();
  let heard = 0;
  const listener = () => heard++;
  Deno.addSignalListener(RELOAD, listener);
  // this process stands in for the run: it holds the supervisor's role
  const lock = claim(`${root}/data`, SUPERVISOR);
  try {
    await declared(root, spec);
    for (let i = 0; i < 50 && heard === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assertEquals(heard, 1);
  } finally {
    if ("held" in lock) lock.held.close();
    Deno.removeSignalListener(RELOAD, listener);
    await Deno.remove(root, { recursive: true });
  }
});
