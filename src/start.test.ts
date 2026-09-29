import { assert, assertEquals, assertThrows } from "@std/assert";
import { backoffMs, comesBack, type Kept, pause, plan, reads, roster } from "./start.ts";
import { REFUSAL } from "./entry.ts";
import { type OrgConfig, starterConfig } from "./config.ts";

Deno.test("roster: main first, bundled connections resolve, org-local ones probe connectors/", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(`${tmp}/connectors/acme`, { recursive: true });
    Deno.writeTextFileSync(`${tmp}/connectors/acme/run.ts`, "");
    // token is a shipped door with nothing to run: declared, it is no process and no error
    const closed = { publicUrl: null, port: 8787, tunnel: null };
    const procs = roster(tmp, { connections: { slack: {}, token: {}, acme: {} }, edge: closed });
    assertEquals(procs.map((p) => p.name), ["main", "slack", "acme", "edge"]);
    assertEquals(procs[1].argv.slice(0, 3), [Deno.execPath(), "run", "-A"]);
    assert(procs[1].argv[3].endsWith("/connect/slack/run.ts"));
    assertEquals(procs[2].argv[3], `${tmp}/connectors/acme/run.ts`);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("roster: the edge always stands, and the tunnel is the argv the catalog says", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    const closed = { publicUrl: null, port: 8787, tunnel: null };
    let procs = roster(tmp, { connections: {}, edge: closed });
    assertEquals(procs.map((p) => p.name), ["main", "edge"]);
    assert(procs[1].argv[3].endsWith("/edge.ts"));
    const tunnel = ["cloudflared", "tunnel", "run", "acme"];
    procs = roster(tmp, {
      connections: {},
      edge: { publicUrl: "https://acme.example.com", port: 8787, tunnel },
    });
    assertEquals(procs.map((p) => p.name), ["main", "edge", "tunnel"]);
    assertEquals(procs[2].argv, tunnel);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("roster: a declared connection with no run.ts is a boot error", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    const closed = { publicUrl: null, port: 8787, tunnel: null };
    assertThrows(
      () => roster(tmp, { connections: { ghost: {} }, edge: closed }),
      Error,
      'connection "ghost"',
    );
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

/** An org's catalog: the starter's, with `connections` and `edge` as given. */
function catalog(over: Partial<OrgConfig> = {}): OrgConfig {
  return { ...starterConfig(), ...over };
}

Deno.test("reads: each process restarts on its own part of the file and nothing else", () => {
  const base = catalog({ connections: { slack: {}, whatsapp: {} } });
  const changed = (cfg: OrgConfig) =>
    ["main", "slack", "whatsapp", "edge", "tunnel"].filter((n) => reads(n, base) !== reads(n, cfg));
  // a connection's own section touches that connection alone
  assertEquals(changed(catalog({ connections: { slack: { botScopes: [] }, whatsapp: {} } })), [
    "slack",
  ]);
  // the bridge's address is main's too: it speaks to the bridge itself
  assertEquals(
    changed(catalog({ connections: { slack: {}, whatsapp: { bridgeUrl: "http://b:1" } } })),
    ["main", "whatsapp"],
  );
  // the roster is main's alone
  const agents = { ana: { mind: true } } as unknown as OrgConfig["agents"];
  assertEquals(changed(catalog({ connections: base.connections, agents })), ["main"]);
  // the edge: every connection reads it, main does not
  const edge = { ...base.edge, publicUrl: "https://acme.example.com" };
  assertEquals(changed(catalog({ connections: base.connections, edge })), [
    "slack",
    "whatsapp",
    "edge",
  ]);
  // a shared section is every liquen process's
  const system = { ...base.system, bashTimeoutMs: 1 };
  assertEquals(changed(catalog({ connections: base.connections, system })), [
    "main",
    "slack",
    "whatsapp",
  ]);
});

Deno.test("plan: what the edit touched restarts, what it declared starts, what it dropped stops", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    const before = catalog({ connections: { slack: {}, google: {} } });
    const kept = new Map<string, Kept>(
      roster(tmp, before).map((p) => [p.name, { reads: reads(p.name, before), refused: false }]),
    );
    // nothing changed: nothing moves
    assertEquals(plan(kept, roster(tmp, before), before), { stop: [], restart: [], start: [] });
    // google dropped, whatsapp declared, slack's section edited
    const after = catalog({ connections: { slack: { botScopes: [] }, whatsapp: {} } });
    const moves = plan(kept, roster(tmp, after), after);
    assertEquals(moves.stop, ["google"]);
    assertEquals(moves.restart.map((p) => p.name), ["slack"]);
    assertEquals(moves.start.map((p) => p.name), ["whatsapp"]);
    // a process that refused gets another go, though the file says the same of it
    kept.set("google", { reads: reads("google", before), refused: true });
    assertEquals(plan(kept, roster(tmp, before), before).restart.map((p) => p.name), ["google"]);
    // a process the reload names restarts whatever the file says of it — once
    kept.set("google", { reads: reads("google", before), refused: false });
    const named = plan(kept, roster(tmp, before), before, ["slack", "slack"]);
    assertEquals(named.restart.map((p) => p.name), ["slack"]);
    assertEquals(named.start, []);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("backoffMs doubles from 1s and caps at 60s", () => {
  assertEquals(backoffMs(1), 1_000);
  assertEquals(backoffMs(2), 2_000);
  assertEquals(backoffMs(4), 8_000);
  assertEquals(backoffMs(20), 60_000);
});

Deno.test("pause: a stop cuts the restart backoff short", async () => {
  const halt = new AbortController();
  const t0 = Date.now();
  const p = pause(60_000, halt.signal);
  halt.abort();
  await p;
  assert(Date.now() - t0 < 1_000);
  // an already-stopped supervisor never waits at all
  const t1 = Date.now();
  await pause(60_000, halt.signal);
  assert(Date.now() - t1 < 1_000);
});

Deno.test("comesBack: a crash returns, a refusal stays down", () => {
  const exited = (code: number, signal: Deno.Signal | null = null): Deno.CommandStatus => ({
    success: code === 0,
    code,
    signal,
  });
  assert(comesBack(exited(1))); // a fault — the frames are on stderr, try again
  assert(comesBack(exited(0))); // a process that ended without being asked to
  assert(comesBack(exited(137))); // OOM-killed, reported as a code
  assert(!comesBack(exited(REFUSAL))); // the sentence is on stderr; rerunning reprints it
  // a signalled child reports the KILLER's code, so the signal decides, not the number
  assert(comesBack(exited(REFUSAL, "SIGTERM")));
});
