import { assertEquals } from "@std/assert";
import { describeCall } from "./describe.ts";

Deno.test("describeCall: one string argument prints bare — the argument IS the call", () => {
  assertEquals(
    describeCall({ name: "bash", input: { command: "git status" } }),
    "bash(git status)",
  );
  assertEquals(describeCall({ name: "aread", input: { path: "/etc/hosts" } }), "aread(/etc/hosts)");
  // …and no tool name appears in that rule: it is the shape of the call that decides
  assertEquals(
    describeCall({ name: "search", input: { in: "wa:x", text: "factura" } }),
    "search(in: wa:x, text: factura)",
  );
});

Deno.test("describeCall: empty arguments are not shown — a call reads as what it does", () => {
  assertEquals(
    describeCall({ name: "search", input: { in: "wa:x", text: "", files: [] } }),
    "search(wa:x)",
  );
});

Deno.test("describeCall: send says WHO — the name, with the address as the fallback", () => {
  const call = { name: "send", input: { to: "5492604586396", text: "ya salgo" } };
  assertEquals(
    describeCall(call, { resolve: (a) => a === "5492604586396" ? "Vivian" : undefined }),
    "send(to: Vivian, text: ya salgo)",
  );
  assertEquals(describeCall(call), "send(to: 5492604586396, text: ya salgo)");
});

Deno.test("describeCall: the line form bounds an argument, the card form keeps all of it", () => {
  const text = "x".repeat(200);
  const call = { name: "send", input: { to: "wa:x", text } };
  const line = describeCall(call);
  assertEquals(line.length <= 120, true);
  assertEquals(line.includes("…"), true);
  // approving is judging what will actually be said, so the card is not allowed to elide it
  assertEquals(describeCall(call, { full: true }), `send(to: wa:x, text: ${text})`);
});

Deno.test("describeCall: a tool may bring its own rendering (ExecTool.describe, §9)", () => {
  const tools = { deploy: (input: unknown) => `→ ${(input as { env: string }).env}` };
  assertEquals(
    describeCall({ name: "deploy", input: { env: "prod", sha: "abc" } }, { tools }),
    "deploy(→ prod)",
  );
});
