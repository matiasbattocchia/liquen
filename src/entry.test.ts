import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { REFUSAL, report } from "./entry.ts";

/** Capture what `report` writes, in order. */
function said(err: unknown): string[] {
  const lines: string[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    report(err);
  } finally {
    console.error = real;
  }
  return lines;
}

Deno.test("report: a plain Error is a refusal — the sentence alone, and the code says so", () => {
  assertEquals(said(new Error("pairing timed out — run the door again")), [
    "pairing timed out — run the door again",
  ]);
  assertEquals(report(new Error("x")), REFUSAL);
  assertEquals(report(new TypeError("x")), 1);
  assertEquals(report("just a string"), 1);
});

Deno.test("report: a subclass is the runtime speaking — the stack survives", () => {
  const lines = said(new TypeError("x is not a function"));
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0], "TypeError: x is not a function");
  assertStringIncludes(lines[0], "at "); // the frames are the point
});

Deno.test("report: a Deno error keeps its stack too — the code did not mean to reach it", () => {
  const lines = said(new Deno.errors.NotFound("no such file"));
  assertStringIncludes(lines[0], "NotFound");
  assertStringIncludes(lines[0], "at ");
});

Deno.test("report: a thrown non-error says what it was", () => {
  assertEquals(said("just a string"), ["just a string"]);
  assertEquals(said(undefined), ["undefined"]);
});

/** The whole of an entry point, run as its own process — the only way to see the exit
 *  code and the terminal's two lines as a person does. */
async function ran(body: string): Promise<{ code: number; err: string }> {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/probe.ts`;
    await Deno.writeTextFile(
      path,
      `import { entry } from "${import.meta.resolve("./entry.ts")}";\n${body}\n`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", path],
      stdout: "null",
      stderr: "piped",
    }).output();
    return { code: out.code, err: new TextDecoder().decode(out.stderr) };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("entry: a refusal is one line and its own code — no frames, no `Uncaught`", async () => {
  const { code, err } = await ran(`await entry(() => {
    throw new Error("sole-bot is already a liquen org");
  });`);
  assertEquals(code, REFUSAL); // the supervisor reads this: nothing to retry
  assertEquals(err.trim(), "sole-bot is already a liquen org");
});

Deno.test("entry: a bug keeps its frames", async () => {
  const { code, err } = await ran(`await entry(() => {
    (undefined as unknown as { go: () => void }).go();
  });`);
  assertEquals(code, 1); // a fault is worth another try
  assertStringIncludes(err, "TypeError");
  assertStringIncludes(err, "at ");
});

Deno.test("entry: what escapes AFTER the body meets the same rule", async () => {
  const { code, err } = await ran(`await entry(() => {
    setTimeout(() => {
      throw new Error("the bridge went away");
    }, 1);
  });`);
  assertEquals(code, REFUSAL);
  assertEquals(err.trim(), "the bridge went away");
});

Deno.test("entry: a body that returns leaves the process alone", async () => {
  const { code, err } = await ran(`await entry(() => {
    console.error("done");
  });`);
  assertEquals(code, 0);
  assertEquals(err.trim(), "done");
});

Deno.test("entry: the body's own exit code is its own", async () => {
  const { code } = await ran(`await entry(() => {
    Deno.exit(2);
  });`);
  assertEquals(code, 2);
});

Deno.test("report: a refusal with an empty message still prints a line", () => {
  const lines = said(new Error(""));
  assertEquals(lines, [""]);
  assert(lines.length === 1);
});

Deno.test("report: what the program modeled is a sentence, what the runtime raised is a fault", () => {
  class Modeled extends Error {} // DispatchError, LeaseLost: an expected condition with a class
  assertEquals(report(new Modeled("the wire said no")), REFUSAL);
  assertEquals(report(new Deno.errors.AddrInUse("port")), 1);
  assertEquals(report(new DOMException("timed out", "TimeoutError")), 1);
  assertEquals(report(new RangeError("x")), 1);
});
