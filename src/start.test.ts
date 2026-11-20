import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  backoffMs,
  comesBack,
  failing,
  type Kept,
  pause,
  plan,
  roster,
  specOf,
  startOnly,
} from "./start.ts";
import { REFUSAL } from "./entry.ts";
import { type ConnectorSpec, type OrgConfig, starterConfig } from "./config.ts";

Deno.test("failing: a failure and the indented trace under it, and nothing else", () => {
  const lines: [string, boolean][] = [
    ["[ingest] google:battox@gmail.com mailbox: +1 mail", false],
    ["[dispatch] FAILED → 5491155550109: Error: cannot reach localhost:8081 — refused", true],
    ["    at file:///home/matias/liquen/src/connect/http.ts:62:33", true],
    ["    at async Object.send (file:///src/connect/whatsapp/dispatch.ts:267:17)", true],
    ["[dispatch] google mail: watching /home/matias/new/data/log for outbound sends", false],
    ["TypeError: Cannot read properties of undefined (reading 'id')", true],
    ["the tick's sweep pass failed: boom", true],
    ["2026-09-29T18:36:23Z INF Starting tunnel tunnelID=85a80195", false],
    ["  an indented line under nothing", false],
    ["2026-09-29T18:36:23Z ERR failed to serve tunnel connection", true],
    ["  the cause, indented under it", true],
  ];
  let under = false;
  for (const [line, want] of lines) {
    assertEquals(under = failing(line, under), want, line);
  }
});

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

Deno.test("roster: a disabled connection runs nothing", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    const closed = { publicUrl: null, port: 8787, tunnel: null };
    const procs = roster(tmp, {
      connections: { slack: {}, whatsapp: { enabled: false } },
      edge: closed,
    });
    assertEquals(procs.map((p) => p.name), ["main", "slack", "edge"]);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("startOnly: what a process reads only at its start, and nothing it reads on each use", async () => {
  const base = catalog({ connections: { google: {}, slack: {} } });
  const procs = roster(Deno.makeTempDirSync(), base);
  const google = await specOf(procs.find((p) => p.name === "google")!);
  const slack = await specOf(procs.find((p) => p.name === "slack")!);
  const specs: Record<string, ConnectorSpec | undefined> = { google, slack };
  const changed = (cfg: OrgConfig) =>
    ["main", "google", "slack", "edge", "tunnel"].filter((n) =>
      JSON.stringify(startOnly(n, base, specs[n])) !== JSON.stringify(startOnly(n, cfg, specs[n]))
    );
  // what every process reads on each use moves nobody: the clock, the machinery's knobs,
  // a connection's knobs, the agents
  const clock = { ...base.shared, timezone: "Asia/Tokyo" };
  assertEquals(changed(catalog({ connections: base.connections, shared: clock })), []);
  const system = { ...base.system, bashWaitMs: 1 };
  assertEquals(changed(catalog({ connections: base.connections, system })), []);
  assertEquals(changed(catalog({ connections: { google: {}, slack: { botScopes: [] } } })), []);
  // a key a connection's spec reads at its start is that connection's
  assertEquals(changed(catalog({ connections: { google: { listen: ["mail"] }, slack: {} } })), [
    "google",
  ]);
  // the edge's port is the edge's, and so are the public address and the tunnel, which say
  // where it listens
  assertEquals(
    changed(catalog({ connections: base.connections, edge: { ...base.edge, port: 1 } })),
    [
      "edge",
    ],
  );
  const published = { ...base.edge, publicUrl: "https://acme.example.com" };
  assertEquals(changed(catalog({ connections: base.connections, edge: published })), ["edge"]);
  const tunnel = { ...base.edge, tunnel: ["cloudflared"] };
  assertEquals(changed(catalog({ connections: base.connections, edge: tunnel })), [
    "edge",
    "tunnel",
  ]);
  // where the store is, every liquen process but the edge's
  const deployment = { ...base.deployment, database: "postgres://x" };
  assertEquals(changed(catalog({ connections: base.connections, deployment })), [
    "main",
    "google",
    "slack",
  ]);
});

Deno.test("plan: what the store declared or enabled starts, what it dropped stops, what a start reads is owed", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    const reads = (procs: { name: string }[], over: Record<string, Record<string, string>> = {}) =>
      new Map(procs.map((p) => [p.name, over[p.name] ?? { deployment: "{}" }]));
    const before = catalog({ connections: { slack: {}, google: {} } });
    const procs = roster(tmp, before);
    const kept = new Map<string, Kept>(
      [...reads(procs)].map(([name, r]) => [name, { reads: r, refused: false }]),
    );
    // nothing changed: nothing moves
    assertEquals(plan(kept, procs, reads(procs)), { stop: [], restart: [], start: [], owed: [] });
    // google disabled, whatsapp declared, slack's knobs edited: nobody restarts
    const after = catalog({
      connections: { slack: { botScopes: [] }, google: { enabled: false }, whatsapp: {} },
    });
    const next = roster(tmp, after);
    const moves = plan(kept, next, reads(next));
    assertEquals(moves.stop, ["google"]);
    assertEquals(moves.restart, []);
    assertEquals(moves.start.map((p) => p.name), ["whatsapp"]);
    // a key read at the start moved: owed, never restarted
    const owed = plan(kept, procs, reads(procs, { google: { deployment: "{}", "x.y": "2" } }));
    assertEquals(owed.owed, []);
    kept.set("google", { reads: { deployment: "{}", "x.y": "1" }, refused: false });
    const moved = plan(kept, procs, reads(procs, { google: { deployment: "{}", "x.y": "2" } }));
    assertEquals(moved.owed, [{ path: "x.y", processes: ["google"] }]);
    assertEquals(moved.restart, []);
    // a process that refused gets another go, though the store says the same of it
    kept.set("google", { reads: { deployment: "{}" }, refused: true });
    assertEquals(plan(kept, procs, reads(procs)).restart.map((p) => p.name), ["google"]);
    // a process the poke names restarts, once
    kept.set("google", { reads: { deployment: "{}" }, refused: false });
    const named = plan(kept, procs, reads(procs), ["slack", "slack"]);
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
