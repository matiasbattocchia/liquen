import { assert, assertEquals, assertThrows } from "@std/assert";
import { backoffMs, comesBack, pause, roster } from "./start.ts";
import { REFUSAL } from "./entry.ts";

Deno.test("roster: main first, bundled connections resolve, org-local ones probe connectors/", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(`${tmp}/connectors/acme`, { recursive: true });
    Deno.writeTextFileSync(`${tmp}/connectors/acme/run.ts`, "");
    // token is a shipped door with nothing to run: declared, it is no process and no error
    const closed = { publicUrl: null, port: 8787, tunnel: null };
    const procs = roster(tmp, { connections: { slack: {}, token: {}, acme: {} }, edge: closed });
    assertEquals(procs.map((p) => p.name), ["main", "slack", "acme"]);
    assertEquals(procs[1].argv.slice(0, 3), [Deno.execPath(), "run", "-A"]);
    assert(procs[1].argv[3].endsWith("/connect/slack/run.ts"));
    assertEquals(procs[2].argv[3], `${tmp}/connectors/acme/run.ts`);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("roster: a public address adds the edge, and the tunnel is the argv the catalog says", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    const open = { publicUrl: "https://acme.example.com", port: 8787, tunnel: null };
    let procs = roster(tmp, { connections: {}, edge: open });
    assertEquals(procs.map((p) => p.name), ["main", "edge"]);
    assert(procs[1].argv[3].endsWith("/edge.ts"));
    const tunnel = ["cloudflared", "tunnel", "run", "acme"];
    procs = roster(tmp, { connections: {}, edge: { ...open, tunnel } });
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
