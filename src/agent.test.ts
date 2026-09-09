import { assertEquals, assertThrows } from "@std/assert";
import { parseAgentArgs, USAGE } from "./agent.ts";

Deno.test("mu agent: one name, the identity flags in either spelling, nothing else", () => {
  assertEquals(parseAgentArgs(["ana"]), { name: "ana", identity: {}, rest: {} });
  assertEquals(
    parseAgentArgs(["--name", "Ana Pérez", "ana", "--email=ana@acme.co", "--phone", "+34600"]),
    {
      name: "ana",
      identity: { name: "Ana Pérez", email: "ana@acme.co", phone: "+34600" },
      rest: {},
    },
  );
  assertThrows(() => parseAgentArgs([]), Error, USAGE);
  assertThrows(() => parseAgentArgs(["ana", "bo"]), Error, USAGE);
  assertThrows(() => parseAgentArgs(["ana", "--model", "x"]), Error, "unknown flag --model");
  assertThrows(() => parseAgentArgs(["ana", "--email"]), Error, "--email needs a value");
  assertThrows(() => parseAgentArgs(["ana", "--phone="]), Error, "--phone needs a value");
});

Deno.test("mu agent: --principal repeats into the list, --no-mind makes a person alone", () => {
  assertEquals(
    parseAgentArgs(["ventas", "--principal", "matias", "--principal=sol"]),
    { name: "ventas", identity: {}, rest: { principals: ["matias", "sol"] } },
  );
  assertEquals(
    parseAgentArgs(["sol", "--no-mind", "--name", "Sol"]),
    { name: "sol", identity: { name: "Sol" }, rest: { mind: false } },
  );
  assertThrows(() => parseAgentArgs(["ventas", "--principal"]), Error, "--principal needs a value");
});
