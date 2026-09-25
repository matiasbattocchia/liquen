/**
 * route: the named sessions one row's address wakes — pure over the envelope.
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

Deno.test("route: a session's own room names it; a mind's room names nobody (the minds tail their own views)", () => {
  assertEquals(route(at("build@ana")), [{ agentId: "ana", sessionId: "build" }]);
  assertEquals(route(at("mind@ana")), []);
});

Deno.test("route: a dm names both ends, minus the minds", () => {
  assertEquals(route(at("dm:build@ana:mind@bo")), [{ agentId: "ana", sessionId: "build" }]);
  assertEquals(route(at("dm:build@ana:review@bo")), [
    { agentId: "ana", sessionId: "build" },
    { agentId: "bo", sessionId: "review" },
  ]);
});

Deno.test("route: a platform room, a non-session address and a control row name nobody", () => {
  assertEquals(
    route(at("C123", {
      envelope: { service: "slack", connection_address: "T1", conversation: { address: "C123" } },
    })),
    [],
  );
  assertEquals(route(at("wa:5491100000000")), []);
  assertEquals(route(at("build@ana", { type: "control" })), []);
});
