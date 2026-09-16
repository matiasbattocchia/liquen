import { assert, assertEquals } from "@std/assert";
import { claim, holder, MAIN, running, SUPERVISOR } from "./stop.ts";

Deno.test("claim: the lock carries the pid holding it, and a second claim finds it taken", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    const first = claim(tmp, SUPERVISOR);
    assert("held" in first);
    assertEquals(Deno.readTextFileSync(`${tmp}/run/${SUPERVISOR}.pid`).trim(), String(Deno.pid));
    assertEquals(claim(tmp, SUPERVISOR), { taken: Deno.pid });
    first.held.close();
    assert("held" in claim(tmp, SUPERVISOR)); // let go, and the next run walks in
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("holder: nobody, the run, nobody again — probing hands the lock straight back", async () => {
  const tmp = Deno.makeTempDirSync();
  try {
    assertEquals(await holder(tmp, SUPERVISOR), null); // nothing has ever run here: no file at all
    const run = claim(tmp, SUPERVISOR);
    assert("held" in run);
    assertEquals(await holder(tmp, SUPERVISOR), Deno.pid);
    assertEquals(await holder(tmp, SUPERVISOR), Deno.pid); // the probe took nothing away
    run.held.close();
    assertEquals(await holder(tmp, SUPERVISOR), null);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("holder: a number no lock backs is a leftover, and is never believed", async () => {
  const tmp = Deno.makeTempDirSync();
  try {
    Deno.mkdirSync(`${tmp}/run`);
    Deno.writeTextFileSync(`${tmp}/run/${SUPERVISOR}.pid`, "4194304\n"); // past any pid
    assertEquals(await holder(tmp, SUPERVISOR), null);
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
        `claim(${JSON.stringify(tmp)}, ${JSON.stringify(SUPERVISOR)});\n` +
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
      pid = await holder(tmp, SUPERVISOR);
      if (pid === null) await new Promise((done) => setTimeout(done, 25));
    }
    assertEquals(pid, child.pid); // another process's lock refuses ours, and names itself
    child.kill("SIGKILL"); // the hardest death there is: no handler, no cleanup, no chance
    await child.status;
    assertEquals(await holder(tmp, SUPERVISOR), null);
    // the number it wrote outlives it — which is exactly why the lock, not the number, answers
    assertEquals(Deno.readTextFileSync(`${tmp}/run/${SUPERVISOR}.pid`).trim(), String(child.pid));
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("running: every live role, the supervisor first — the order a stop has to use", async () => {
  const tmp = Deno.makeTempDirSync();
  try {
    assertEquals([...await running(tmp)], []); // nothing has ever run here
    const mind = claim(tmp, MAIN), whatsapp = claim(tmp, "whatsapp");
    assert("held" in mind && "held" in whatsapp);
    // alphabetically `liquen` would fall between them; it is listed first because it is the
    // only role with children, and a child stopped before its parent earns a restart
    const boss = claim(tmp, SUPERVISOR);
    assert("held" in boss);
    assertEquals([...(await running(tmp)).keys()], [SUPERVISOR, MAIN, "whatsapp"]);
    assertEquals([...(await running(tmp)).values()], [Deno.pid, Deno.pid, Deno.pid]);
    boss.held.close(), whatsapp.held.close();
    assertEquals([...(await running(tmp)).keys()], [MAIN]); // the files stay, the locks do not
    mind.held.close();
    assertEquals([...await running(tmp)], []);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("a role is a lock: two roles never collide, the same role always does", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    const boss = claim(tmp, SUPERVISOR), mind = claim(tmp, MAIN);
    assert("held" in boss && "held" in mind); // a supervisor and its mind are not rivals
    assertEquals(claim(tmp, MAIN), { taken: Deno.pid }); // a second mind is
    mind.held.close();
    assert("held" in claim(tmp, MAIN)); // and walks in the moment the first lets go
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});
