import { assertEquals, assertStringIncludes } from "@std/assert";

const liquen = (args: string[], cwd: string) =>
  new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", new URL("./liquen.ts", import.meta.url).pathname, ...args],
    cwd,
    stdout: "piped",
    stderr: "piped",
  }).output();

Deno.test("liquen: the org's task, found upward from the cwd or named by --dir", async () => {
  const tmp = await Deno.makeTempDir();
  const org = `${tmp}/acme`;
  try {
    await Deno.mkdir(`${org}/data`, { recursive: true });
    await Deno.writeTextFile(`${org}/config.jsonc`, "{}");
    await Deno.writeTextFile(
      `${org}/deno.jsonc`,
      JSON.stringify({ tasks: { hello: "echo hello" } }),
    );

    const inside = await liquen(["hello", "world"], `${org}/data`);
    assertEquals(inside.code, 0);
    assertStringIncludes(new TextDecoder().decode(inside.stdout), "hello world");

    const outside = await liquen(["--dir", org, "hello"], tmp);
    assertEquals(outside.code, 0);
    assertStringIncludes(new TextDecoder().decode(outside.stdout), "hello");

    const nowhere = await liquen(["hello"], tmp);
    assertEquals(nowhere.code, 2);
    assertStringIncludes(new TextDecoder().decode(nowhere.stderr), "not inside a liquen org");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
