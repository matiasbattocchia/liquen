import { assertEquals, assertStringIncludes } from "@std/assert";
import { start } from "./main.ts";
import { readConfig } from "./config.ts";
import { canned, scripted } from "./testing.ts";

Deno.test({
  name:
    "liquen cli --fail-on-tool-error: a failed call in the turn its line started exits 3; without the flag, idle is 0",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const root = await Deno.makeTempDir();
    await Deno.writeTextFile(`${root}/config.jsonc`, JSON.stringify({ agents: { ana: {} } }));
    const catalog = await readConfig(root);
    // each instruction: a call to a tool nobody has (an error result), then the closing
    const turn = () => [
      canned([{ kind: "tool_use", name: "nope", input: {} }], "tool_use"),
      canned([{ kind: "assistant", text: "no pude" }], "end_turn"),
    ];
    const fine = canned([{ kind: "assistant", text: "listo" }], "end_turn");
    const { transport } = scripted([...turn(), fine, ...turn()]);
    const main = await start(
      { dir: `${root}/data`, catalog, debounceMs: 0, model: "claude-x", maxTokens: 1024 },
      { transport },
    );
    const cli = async (...args: string[]) => {
      const out = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          new URL("./cli.ts", import.meta.url).pathname,
          "--agent",
          "ana",
          "--timeout",
          "20",
          ...args,
        ],
        cwd: root,
        stdout: "piped",
        stderr: "piped",
      }).output();
      return { code: out.code, err: new TextDecoder().decode(out.stderr) };
    };
    try {
      const failing = await cli("--fail-on-tool-error", "hacé algo");
      assertEquals(failing.code, 3, failing.err);
      assertStringIncludes(failing.err, "1 call(s) failed");
      // the flag reads the turn its own line started: the failure before it is not its own
      assertEquals((await cli("--fail-on-tool-error", "ahora sí")).code, 0);
      // and without the flag, idle over the line is the whole answer
      assertEquals((await cli("y otra")).code, 0);
    } finally {
      await main.stop();
      await Deno.remove(root, { recursive: true });
    }
  },
});
