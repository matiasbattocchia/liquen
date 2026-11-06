import { assert, assertEquals, assertMatch } from "@std/assert";
import { openRunLog, RUN_LOG, RUN_LOG_CAP } from "./runlog.ts";

Deno.test("the run log: each line stamped with its time and its name, plain", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const log = openRunLog(dir, false);
    log.say("main", "agents: ana");
    log.say("liquen", "slack exited (code 1)", { failure: true });
    const lines = (await Deno.readTextFile(`${dir}/${RUN_LOG}`)).trimEnd().split("\n");
    assertMatch(lines[0], /^\d\d:\d\d:\d\d \[main\] agents: ana$/);
    assertMatch(lines[1], /^\d\d:\d\d:\d\d \[liquen\] slack exited \(code 1\)$/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("the run log past its cap gives its older half back, its offsets kept", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const log = openRunLog(dir, false);
    const line = "x".repeat(1000);
    const lines = Math.ceil((RUN_LOG_CAP + 2 * 1024 * 1024) / 1000);
    for (let n = 0; n < lines; n++) log.say("main", line);
    const path = `${dir}/${RUN_LOG}`;
    const until = Date.now() + 10_000;
    let stat = await Deno.stat(path);
    while (stat.blocks! * 512 > RUN_LOG_CAP && Date.now() < until) {
      log.say("main", line);
      await new Promise((r) => setTimeout(r, 50));
      stat = await Deno.stat(path);
    }
    assert(stat.blocks! * 512 <= RUN_LOG_CAP, `${stat.blocks}`);
    assert(stat.size > RUN_LOG_CAP, `${stat.size}`); // the offsets stay
    // the newest line is whole at the end
    const file = await Deno.open(path);
    await file.seek(-1100, Deno.SeekMode.End);
    const tail = new Uint8Array(1100);
    await file.read(tail);
    file.close();
    assertMatch(new TextDecoder().decode(tail), /\[main\] x{1000}\n$/);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a process with nobody pumping its output says it in the run log, its last words included", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const script = `
      import { openRunLog, sayConsole } from ${JSON.stringify(import.meta.resolve("./runlog.ts"))};
      import { entry } from ${JSON.stringify(import.meta.resolve("./entry.ts"))};
      sayConsole(openRunLog(${JSON.stringify(dir)}, false), "main");
      await entry(() => {
        console.log("agents: ana");
        throw new Error("a main already runs here");
      });
    `;
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["eval", script],
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 2); // a refusal
    assertEquals(new TextDecoder().decode(out.stderr), "");
    const lines = (await Deno.readTextFile(`${dir}/${RUN_LOG}`)).trimEnd().split("\n");
    assertEquals(lines.map((l) => l.slice(9)), [
      "[main] agents: ana",
      "[main] a main already runs here",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
