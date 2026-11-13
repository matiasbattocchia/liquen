import { assertEquals, assertThrows } from "@std/assert";
import { listed, parseAgentArgs, USAGE } from "./agent.ts";

Deno.test("liquen agent: no name lists; one name, the identity flags in either spelling", () => {
  assertEquals(parseAgentArgs([]), { list: true });
  assertEquals(parseAgentArgs(["ana"]), { name: "ana", change: {} });
  assertEquals(
    parseAgentArgs(["--name", "Ana Pérez", "ana", "--email=ana@acme.co", "--phone", "+34600"]),
    {
      name: "ana",
      change: { identity: { name: "Ana Pérez", email: "ana@acme.co", phone: "+34600" } },
    },
  );
  assertThrows(() => parseAgentArgs(["ana", "bo"]), Error, USAGE);
  assertThrows(() => parseAgentArgs(["--email", "x@y"]), Error, USAGE); // a change needs a name
  assertThrows(() => parseAgentArgs(["ana", "--colour", "x"]), Error, "unknown flag --colour");
  assertThrows(() => parseAgentArgs(["ana", "--email"]), Error, "--email needs a value");
  assertThrows(() => parseAgentArgs(["ana", "--phone="]), Error, "--phone needs a value");
});

Deno.test("liquen agent: --principal repeats into the list, '*' is anyone, --no-mind a person alone", () => {
  assertEquals(
    parseAgentArgs(["ventas", "--principal", "matias", "--principal=sol"]),
    { name: "ventas", change: { principals: ["matias", "sol"] } },
  );
  assertEquals(parseAgentArgs(["sonar", "--principal", "*"]), {
    name: "sonar",
    change: { principals: "*" },
  });
  assertEquals(parseAgentArgs(["bot", "--no-principals"]), {
    name: "bot",
    change: { principals: [] },
  });
  assertEquals(
    parseAgentArgs(["sol", "--no-mind", "--name", "Sol"]),
    { name: "sol", change: { identity: { name: "Sol" }, set: { mind: false } } },
  );
  assertEquals(parseAgentArgs(["sol", "--mind"]), { name: "sol", change: { set: { mind: true } } });
  assertThrows(() => parseAgentArgs(["ventas", "--principal"]), Error, "--principal needs a value");
});

Deno.test("liquen agent: a flag per setting, its value read as YAML; --unset makes a key inherit again", () => {
  assertEquals(
    parseAgentArgs([
      "ana",
      "--model",
      "claude-x",
      "--maxTokens=4096",
      "--tools",
      "[send, bash]",
      "--sleepHours",
      "null",
      "--effort",
      "high",
    ]),
    {
      name: "ana",
      change: {
        set: {
          model: "claude-x",
          maxTokens: 4096,
          tools: ["send", "bash"],
          sleepHours: null,
          effort: "high",
        },
      },
    },
  );
  assertEquals(
    parseAgentArgs(["ana", "--unset", "model", "--unset=email", "--unset", "principals"]),
    { name: "ana", change: { unset: ["model"], identity: { email: null }, principals: null } },
  );
  assertThrows(() => parseAgentArgs(["ana", "--unset", "colour"]), Error, "not a setting");
});

Deno.test("liquen agent --remove: one name, and nothing else on the line", () => {
  assertEquals(parseAgentArgs(["--remove", "ana"]), { remove: "ana" });
  assertEquals(parseAgentArgs(["--remove=ana"]), { remove: "ana" });
  assertThrows(() => parseAgentArgs(["--remove", "ana", "bo"]), Error, USAGE);
  assertThrows(() => parseAgentArgs(["--remove", "ana", "--no-mind"]), Error, USAGE);
  assertThrows(() => parseAgentArgs(["--remove"]), Error, "--remove needs a value");
});

Deno.test("liquen agent: the list says whose word each agent is, whether it runs, and its last turn", () => {
  assertEquals(listed([]), ["no agents — `liquen agent <name>` makes one"]);
  assertEquals(
    listed([
      { agentId: "ana", declared: true, runs: true, last: "2026-11-12T10:30:00.000Z" },
      { agentId: "sonar", declared: false, runs: false },
    ]),
    [
      "ana    declared in config.yaml  runs    last turn 2026-11-12 10:30Z",
      "sonar  made at runtime          paused  no turn yet",
    ],
  );
});
