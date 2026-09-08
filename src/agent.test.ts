import { assertEquals, assertThrows } from "@std/assert";
import { parseAgentArgs, USAGE } from "./agent.ts";

Deno.test("mu agent: one name, the identity flags in either spelling, nothing else", () => {
  assertEquals(parseAgentArgs(["ana"]), { name: "ana", identity: {} });
  assertEquals(
    parseAgentArgs(["--name", "Ana Pérez", "ana", "--email=ana@acme.co", "--phone", "+34600"]),
    { name: "ana", identity: { name: "Ana Pérez", email: "ana@acme.co", phone: "+34600" } },
  );
  assertThrows(() => parseAgentArgs([]), Error, USAGE);
  assertThrows(() => parseAgentArgs(["ana", "bo"]), Error, USAGE);
  assertThrows(() => parseAgentArgs(["ana", "--model", "x"]), Error, "unknown flag --model");
  assertThrows(() => parseAgentArgs(["ana", "--email"]), Error, "--email needs a value");
  assertThrows(() => parseAgentArgs(["ana", "--phone="]), Error, "--phone needs a value");
});
