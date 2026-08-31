import { assert, assertEquals, assertThrows } from "@std/assert";
import { backoffMs, roster } from "./start.ts";

Deno.test("roster: main first, bundled connections resolve, org-local ones probe connectors/", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(`${tmp}/connectors/acme`, { recursive: true });
    Deno.writeTextFileSync(`${tmp}/connectors/acme/run.ts`, "");
    const procs = roster(tmp, { slack: {}, acme: {} });
    assertEquals(procs.map(([n]) => n), ["main", "slack", "acme"]);
    assert(procs[1][1].endsWith("/connect/slack/run.ts"));
    assertEquals(procs[2][1], `${tmp}/connectors/acme/run.ts`);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("roster: a declared connection with no run.ts is a boot error", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    assertThrows(() => roster(tmp, { ghost: {} }), Error, 'connection "ghost"');
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
