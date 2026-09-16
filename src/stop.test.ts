import { assert, assertEquals } from "@std/assert";
import { claim, holder, LOCK } from "./stop.ts";

Deno.test("claim: the lock carries the pid holding it, and a second claim finds it taken", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    const first = claim(tmp);
    assert("held" in first);
    assertEquals(Deno.readTextFileSync(`${tmp}/${LOCK}`).trim(), String(Deno.pid));
    assertEquals(claim(tmp), { taken: Deno.pid });
    first.held.close();
    assert("held" in claim(tmp)); // let go, and the next run walks in
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("holder: nobody, the run, nobody again — probing hands the lock straight back", async () => {
  const tmp = Deno.makeTempDirSync();
  try {
    assertEquals(await holder(tmp), null); // nothing has ever run here: no file at all
    const run = claim(tmp);
    assert("held" in run);
    assertEquals(await holder(tmp), Deno.pid);
    assertEquals(await holder(tmp), Deno.pid); // the probe took nothing away
    run.held.close();
    assertEquals(await holder(tmp), null);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("holder: a number no lock backs is a leftover, and is never believed", async () => {
  const tmp = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(`${tmp}/${LOCK}`, "4194304\n"); // past any pid: nothing to signal
    assertEquals(await holder(tmp), null);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("the lock dies with its holder, however it dies — the kernel is what releases it", async () => {
  const tmp = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      `${tmp}/hold.ts`,
      `import { claim } from ${JSON.stringify(import.meta.resolve("./stop.ts"))};\n` +
        `claim(${JSON.stringify(tmp)});\n` +
        // a real pending timer: a promise nothing can settle is a deadlock Deno exits on
        `await new Promise((done) => setTimeout(done, 60_000));\n`,
    );
    const child = new Deno.Command(Deno.execPath(), {
      // the script sits outside the package, so the import map has to be named for it
      args: [
        "run",
        "-A",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        `${tmp}/hold.ts`,
      ],
      stdout: "null",
      stderr: "null",
    }).spawn();
    let pid: number | null = null;
    for (let i = 0; i < 200 && pid === null; i++) {
      pid = await holder(tmp);
      if (pid === null) await new Promise((done) => setTimeout(done, 25));
    }
    assertEquals(pid, child.pid); // another process's lock refuses ours, and names itself
    child.kill("SIGKILL"); // the hardest death there is: no handler, no cleanup, no chance
    await child.status;
    assertEquals(await holder(tmp), null);
    // the number it wrote outlives it — which is exactly why the lock, not the number, answers
    assertEquals(Deno.readTextFileSync(`${tmp}/${LOCK}`).trim(), String(child.pid));
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});
