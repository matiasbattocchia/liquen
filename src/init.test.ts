import { assert, assertEquals, assertRejects } from "@std/assert";
import { init } from "./init.ts";
import { findRoot, readConfig } from "./config.ts";

Deno.test("init scaffolds a project the reader accepts, and refuses to do it twice", async () => {
  const tmp = await Deno.makeTempDir();
  const path = `${tmp}/acme`;
  try {
    await init(path, ["ana", "bo"]);
    // the catalog is the project marker — findRoot lands on it from anywhere inside
    assertEquals(findRoot(`${path}/data`), await Deno.realPath(path));
    const cfg = await readConfig(path);
    assertEquals(Object.keys(cfg.agents), ["ana", "bo"]);
    assert(cfg.org.timezone.length > 0); // the machine's clock, interviewed for the human
    for (
      const f of [
        "AGENTS.md",
        "Dockerfile",
        "entrypoint.sh",
        "deno.jsonc",
        ".env",
        ".gitignore",
        "connectors",
        "processors",
        "data",
      ]
    ) await Deno.stat(`${path}/${f}`);
    const mode = (await Deno.stat(`${path}/entrypoint.sh`)).mode! & 0o777;
    assertEquals(mode, 0o755);
    // the name is the folder's
    assert((await Deno.readTextFile(`${path}/AGENTS.md`)).startsWith("# acme"));
    await assertRejects(() => init(path, ["ana"]), Error, "already a mu project");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
