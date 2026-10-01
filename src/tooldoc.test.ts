import { assertEquals, assertRejects, assertStringIncludes, assertThrows } from "@std/assert";
import { checkToolDocs, type ToolShape, worded, wordedAll } from "./tooldoc.ts";
import { OWN_TOOLS } from "./xi.ts";
import { bashShape } from "./exec/bash.ts";
import { DOC_TOOLS } from "./exec/docs.ts";
import { openFileDocs } from "./store/docs.ts";
import { onFiles, seedOrg } from "./store/seed.ts";

const PIN: ToolShape = {
  spec: {
    name: "pin",
    input_schema: {
      type: "object",
      properties: {
        at: { type: "string" },
        limit: { type: "integer" },
        place: {
          type: "object",
          properties: { lat: { type: "number" }, label: { type: "string" } },
          required: ["lat"],
        },
      },
      required: ["at"],
    },
  },
  vars: { cap: 50 },
};

const DOC = `Drop a pin somewhere. The first
paragraph wraps.

Two ways:
- here, by default
- there, when asked

- at: where it lands, wrapped
  over two lines
- limit: how many (default {{cap}})
- place: the spot
  - label: what it says
`;

Deno.test("worded: prose unwraps, list lines keep theirs, items fill the schema", () => {
  const t = worded(PIN, DOC);
  assertEquals(
    t.description,
    "Drop a pin somewhere. The first paragraph wraps.\n\n" +
      "Two ways:\n- here, by default\n- there, when asked",
  );
  const props = t.input_schema.properties as Record<string, Record<string, unknown>>;
  assertEquals(props.at, { type: "string", description: "where it lands, wrapped over two lines" });
  assertEquals(props.limit.description, "how many (default 50)");
  assertEquals(props.place.description, "the spot");
  // a nested field is described where the doc names it, and left bare where it does not
  assertEquals((props.place.properties as Record<string, unknown>).label, {
    type: "string",
    description: "what it says",
  });
  assertEquals((props.place.properties as Record<string, unknown>).lat, { type: "number" });
  // the schema the handler reads is untouched
  assertEquals(t.input_schema.required, ["at"]);
  assertEquals(props.place.required as string[], ["lat"]);
});

Deno.test("worded: any disagreement with the schema is an error naming the file", () => {
  const fails = (text: string, msg: string) =>
    assertStringIncludes(
      assertThrows(() => worded(PIN, text), Error).message,
      `system/instructions/tools/pin.md: ${msg}`,
    );
  fails("A pin.\n\n- at: x\n- limit: y", "no item for `place`");
  fails("A pin.\n\n- at: x\n- limit: y\n- place: z\n- color: w", "`color` is not a parameter");
  fails("A pin.\n\n- at: x\n- limit: {{max}}\n- place: z", "no value for {{max}}");
  fails("A pin.\n\n- at: x\n  - deep: y\n- limit: y\n- place: z", "`at` has no fields");
  fails("A pin.\n\n- at: x\nlimit: y\n- place: z", "`limit: y` is not a parameter item");
  fails("- at: x\n- limit: y\n- place: z", "no description before the parameters");
});

Deno.test("worded: a tool with no parameters is prose alone", () => {
  const shape = { spec: { name: "ping", input_schema: { type: "object" as const } } };
  assertEquals(worded(shape, "Say hi.\n").description, "Say hi.");
});

Deno.test("wordedAll: a missing doc is named", async () => {
  await assertRejects(
    () => wordedAll([PIN], () => Promise.resolve(null)),
    Error,
    "system/instructions/tools/pin.md is missing",
  );
});

Deno.test("the seeded docs word every builtin tool, the numbers filled from code", async () => {
  const root = await Deno.makeTempDir();
  try {
    await seedOrg(onFiles(root));
    const docs = openFileDocs(root);
    const read = (name: string) =>
      docs.read({ agent: "a" }, { scope: "system", kind: "instruction", name });
    const shapes = [...OWN_TOOLS, bashShape(120_000), ...Object.values(DOC_TOOLS)];
    await checkToolDocs(shapes, read);
    const tools = await wordedAll(shapes, read);
    const bash = tools.find((t) => t.name === "bash")!;
    assertStringIncludes(bash.description!, "Default timeout 120s");
    assertStringIncludes(bash.description!, "last 2000 lines / 50KB");
    assertStringIncludes(bash.description!, "\n- aedit, over sed -i/perl -pi:");
    const search = tools.find((t) => t.name === "search")!;
    assertStringIncludes(search.description!, "(50 unless you set `limit`)");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});
