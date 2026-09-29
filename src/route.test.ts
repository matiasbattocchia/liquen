/**
 * route: the named sessions one row's address wakes — read off a direct address, asked of
 * the memberships for a room of its own.
 */

import { assertEquals } from "@std/assert";
import { route } from "./route.ts";
import type { Event } from "./types.ts";

const at = (address: string, over: Partial<Event> = {}): Event => ({
  id: "01" as Event["id"],
  ts: "2026-09-25T10:00:00.000Z",
  type: "message",
  envelope: { service: "local", connection_address: "agent", conversation: { address } },
  ...over,
} as Event);

/** A memberships table with one room of its own. */
const rooms = (table: Record<string, { agentId: string; sessionId: string }[]>) => ({
  membersOf: (_s: string, _c: string, conversation: string) =>
    Promise.resolve(table[conversation] ?? []),
});

const none = rooms({});

Deno.test("route: a session's own room names it; a mind's room names nobody (the minds tail their own views)", async () => {
  assertEquals(await route(at("build@ana"), none), [{ agentId: "ana", sessionId: "build" }]);
  assertEquals(await route(at("mind@ana"), none), []);
});

Deno.test("route: a direct room names its members, minus the minds — however many", async () => {
  assertEquals(await route(at("build@ana,mind@bo"), none), [{
    agentId: "ana",
    sessionId: "build",
  }]);
  assertEquals(await route(at("build@ana,mind@bo,review@cy"), none), [
    { agentId: "ana", sessionId: "build" },
    { agentId: "cy", sessionId: "review" },
  ]);
});

Deno.test("route: a room of its own is asked of the memberships", async () => {
  const table = rooms({
    "0192abc": [
      { agentId: "ana", sessionId: "build" },
      { agentId: "bo", sessionId: "mind" },
    ],
  });
  assertEquals(await route(at("0192abc"), table), [{ agentId: "ana", sessionId: "build" }]);
  assertEquals(await route(at("0192zzz"), table), []);
});

Deno.test("route: a platform room and a control row name nobody", async () => {
  assertEquals(
    await route(
      at("C123", {
        envelope: { service: "slack", connection_address: "T1", conversation: { address: "C123" } },
      }),
      none,
    ),
    [],
  );
  assertEquals(await route(at("build@ana", { type: "control" }), none), []);
});
