import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { bashTool, installExecGround, localHost, shippedAt, sweepLogs } from "./bash.ts";
import { JOB_ENV, Jobs, type ShellUpdate, SPOOL_CAP } from "./jobs.ts";
import type { ExecFacts, ExecOutcome } from "../xi.ts";

const live = () => new AbortController().signal;

/** Where a plane lands an agent: its own folder under `agents/` — the cwd IS the tree. */
const wsOf = (dir: string) => `${dir}/agents/a1`;

async function withPlane(
  fn: (t: {
    run: (command: string) => Promise<string>;
    dir: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const { exec, reap } = (await installExecGround(dir, "a1")).shell();
  try {
    const run = async (command: string) => String(await exec.bash.execute({ command }, live()));
    await fn({ run, dir });
  } finally {
    await reap(); // kill any background jobs a test left running
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("bash: runs in the workspace, merges stdout+stderr", async () => {
  await withPlane(async ({ run, dir }) => {
    assertEquals(await run("pwd"), await Deno.realPath(wsOf(dir)));
    const both = await run("echo out; echo err >&2");
    assertStringIncludes(both, "out");
    assertStringIncludes(both, "err");
  });
});

Deno.test("bash: PATH widens by scope — the agent's own bin cannot shadow the shipped one", async () => {
  await withPlane(async ({ run, dir }) => {
    // same name in every writable layer: whoever answers is the one PATH reaches first
    for (const at of [`${dir}/shared/bin`, `${wsOf(dir)}/bin`]) {
      await Deno.writeTextFile(`${at}/whose`, `#!/bin/sh\necho ${at}\n`);
      await Deno.chmod(`${at}/whose`, 0o755);
    }
    assertEquals(await run("whose"), `${dir}/shared/bin`);
    assertEquals(
      await run("command -v aread"),
      `${dir}/system/bin/aread`,
    );
    // the shim reads the harness's cache and never fetches: the agent's uid has no cache
    // of its own and no road to the registry
    const shim = await Deno.readTextFile(`${dir}/system/bin/aread`);
    assertStringIncludes(shim, "env DENO_DIR='");
    assertStringIncludes(shim, "--cached-only");
    // fetch is laid the same way; the liquen CA it trusts rides the environment
    const http = await Deno.readTextFile(`${dir}/system/bin/fetch`);
    assertStringIncludes(http, "--cached-only --allow-net");
    const path = (await run("echo $PATH")).split(":");
    assert(
      path.indexOf(`${dir}/shared/bin`) < path.indexOf(`${wsOf(dir)}/bin`),
      "the org's bin must precede the agent's",
    );
  });
});

Deno.test("bash: bins lists each PATH directory's executables in PATH order", async () => {
  const dir = await Deno.makeTempDir();
  const plane = (await installExecGround(dir, "a1")).shell();
  try {
    await Deno.writeTextFile(`${dir}/shared/bin/gws`, "#!/bin/sh\n");
    await Deno.chmod(`${dir}/shared/bin/gws`, 0o755);
    // a plain file is not a program, and the agent's empty bin is left out
    await Deno.writeTextFile(`${dir}/system/bin/log.db`, "");
    assertEquals(await plane.bins!(), [
      // the harness's own carry their usage from the source; nothing is run to learn it
      shippedAt(`${dir}/system/bin`),
      { dir: `${dir}/shared/bin`, programs: [{ name: "gws" }] },
    ]);
    assertEquals(shippedAt("/b").programs.map((p) => p.name), [
      "aedit",
      "aread",
      "awrite",
      "fetch",
    ]);
    assertEquals(
      shippedAt("/b").programs[1].usage,
      "aread <path> [offset] [limit] [maxBytes]",
    );
  } finally {
    await plane.reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: user space starts with an empty pocket — the harness env never leaks", async () => {
  Deno.env.set("MU_TEST_SECRET", "xoxp-leak");
  try {
    await withPlane(async ({ run }) => {
      const env = await run("env");
      assert(!env.includes("MU_TEST_SECRET"), "harness env leaked into user space");
      assertStringIncludes(env, "HOME="); // the allowlist still issues what tools need
      assertStringIncludes(env, "PATH=");
      assertStringIncludes(env, "TERM=dumb");
    });
  } finally {
    Deno.env.delete("MU_TEST_SECRET");
  }
});

Deno.test("bash: the env hook issues extra vars into the spawn (the proxy handoff)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    let handle = "mu-grant-first";
    const bash = bashTool({
      workspace: dir,
      env: () => Promise.resolve({ GOOGLE_WORKSPACE_CLI_TOKEN: handle }),
    });
    const run = async () =>
      String(await bash.execute({ command: "echo $GOOGLE_WORKSPACE_CLI_TOKEN" }, live()));
    assertStringIncludes(await run(), "mu-grant-first");
    handle = "mu-grant-rotated"; // evaluated per call — a rotated placeholder is picked up
    assertStringIncludes(await run(), "mu-grant-rotated");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: non-zero exit → error carrying output + code", async () => {
  await withPlane(async ({ run }) => {
    const err = await assertRejects(() => run("echo boom; exit 3"), Error);
    assertStringIncludes(err.message, "boom");
    assertStringIncludes(err.message, "exited with code 3");
  });
});

/** A shell whose updates are kept, for a test to read: `told()` waits for the n-th. */
function telling() {
  const updates: ShellUpdate[] = [];
  const jobs = new Jobs(localHost(), (u) => updates.push(u));
  const told = async (n: number, ms = 5000) => {
    const until = Date.now() + ms;
    while (updates.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    assert(updates.length >= n, `told ${updates.length} of ${n}: ${JSON.stringify(updates)}`);
    return updates[n - 1];
  };
  return { jobs, updates, told };
}

const USE = { id: "u1", turn_id: "t1" };

Deno.test("bash: a command still running at its wait is answered async, and its end is told", async () => {
  const dir = await Deno.makeTempDir();
  const { jobs, updates, told } = telling();
  try {
    const bash = bashTool({ workspace: dir, defaultWaitMs: 300, jobs });
    const answer = await bash.execute(
      { command: "echo started; sleep 0.6; echo done; exit 3" },
      live(),
      undefined,
      USE,
    ) as { output: string; async?: true };
    assertEquals(answer.async, true);
    assertStringIncludes(answer.output, "started");
    assertMatch(answer.output, /still running after 0\.3s as group \d+: what it prints goes on/);
    assert(!answer.output.includes("done"));
    const end = await told(1);
    assertEquals(end.use, USE);
    assertMatch(end.output, /^exited 3 after \d+s\ndone$/); // what it printed since the answer
    assertEquals(end.is_error, true);
    assertEquals(end.final, true); // nothing it started runs on
    // the log, named by the call, holds the whole of it, and outlives the job's record
    const path = /goes on in (\S+),/.exec(answer.output)![1];
    assertEquals(path, `${dir}/.out/bash-u1.log`);
    assertEquals(await Deno.readTextFile(path), "started\ndone\n");
    assertEquals((await Array.fromAsync(Deno.readDir(`${dir}/.out`))).map((e) => e.name), [
      "bash-u1.log",
    ]);
    assertEquals(jobs.size, 0);
    assertEquals(updates.length, 1); // told once
  } finally {
    await jobs.reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: the lines a call wakes on are told as they come, a few at a time", async () => {
  const dir = await Deno.makeTempDir();
  const { jobs, updates, told } = telling();
  try {
    const bash = bashTool({ workspace: dir, jobs });
    const command =
      'for i in 1 2 3 4 5; do echo "step $i"; [ $i = 2 ] && echo "ERROR at $i"; sleep 0.3; done';
    const answer = await bash.execute({ command, wait: 0, wake: "^ERROR" }, live(), undefined, USE);
    assertEquals((answer as { async?: true }).async, true);
    const woke = await told(1);
    assertEquals(woke.output, "ERROR at 2");
    assertEquals(woke.final, undefined); // it runs on
    const end = await told(2);
    assertEquals(end.final, true);
    assertStringIncludes(end.output, "step 3");
    assertEquals(updates.length, 2);
  } finally {
    await jobs.reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: a wake that is not a pattern is refused before anything runs", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bash = bashTool({ workspace: dir });
    await assertRejects(
      () => bash.execute({ command: "touch ran", wake: "(" }, live()),
      Error,
      "wake:",
    );
    assertEquals(await Deno.stat(`${dir}/ran`).then(() => true, () => false), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: abort kills and reports", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/workspace`, { recursive: true });
    const bash = bashTool({ workspace: `${dir}/workspace` });
    const ctl = new AbortController();
    const pending = bash.execute({ command: "sleep 10" }, ctl.signal);
    setTimeout(() => ctl.abort(), 100);
    const err = await assertRejects(() => pending, Error);
    assertStringIncludes(err.message, "aborted");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: tail-truncation persists the full output and points at it", async () => {
  await withPlane(async ({ run, dir }) => {
    const out = await run("seq 1 3000");
    assertStringIncludes(out, "3000"); // the tail survives
    assert(!out.includes("\n500\n")); // the head is gone
    const m = out.match(/full output: (\S+)]/);
    assert(m, "footer names the persisted file");
    const full = await Deno.readTextFile(m![1]);
    assertStringIncludes(full, "\n500\n"); // nothing silently lost
    assert(m![1].startsWith(`${wsOf(dir)}/.out/`));
  });
});

Deno.test("bash: the spill lands under the workspace wherever the shell stands", async () => {
  await withPlane(async ({ run, dir }) => {
    await Deno.mkdir(`${dir}/elsewhere`);
    const out = await run(`cd ${dir}/elsewhere && seq 1 3000`);
    const m = out.match(/full output: (\S+)]/);
    assert(m, "footer names the persisted file");
    assert(m![1].startsWith(`${wsOf(dir)}/.out/`), m![1]);
  });
});

Deno.test("exec plane: stand() refuses a place the shell cannot stand in, and moves nothing", async () => {
  const dir = await Deno.makeTempDir();
  const plane = (await installExecGround(dir, "a1")).shell();
  try {
    const run = async (command: string) =>
      String(await plane.exec.bash.execute({ command }, live()));
    const gone = await assertRejects(() => plane.stand(`${dir}/nowhere`), Error);
    assertStringIncludes(gone.message, `${dir}/nowhere`);
    assertStringIncludes(gone.message, "cannot stand there");
    if (Deno.uid() !== 0) { // root enters anything: the closed door is only a door to others
      await Deno.mkdir(`${dir}/closed`);
      await Deno.chmod(`${dir}/closed`, 0o000);
      const closed = await assertRejects(() => plane.stand(`${dir}/closed`), Error);
      assertStringIncludes(closed.message, `${dir}/closed`);
      await Deno.chmod(`${dir}/closed`, 0o700);
    }
    assertEquals(await run("pwd"), await Deno.realPath(wsOf(dir))); // still home
  } finally {
    await plane.reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exec plane: stand() moves where the next call starts; bare, it is the workspace", async () => {
  const dir = await Deno.makeTempDir();
  const plane = (await installExecGround(dir, "a1")).shell();
  try {
    const run = async (command: string) =>
      String(await plane.exec.bash.execute({ command }, live()));
    await Deno.mkdir(`${dir}/proj`);
    await plane.stand(`${dir}/proj`);
    assertEquals(await run("pwd"), await Deno.realPath(`${dir}/proj`));
    await run("cd .."); // a cd lasts its call (STICKY_CWD off)
    assertEquals(await run("pwd"), await Deno.realPath(`${dir}/proj`));
    await plane.stand();
    assertEquals(await run("pwd"), await Deno.realPath(wsOf(dir)));
  } finally {
    await plane.reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exec ground: two sessions' shells share the folder, never the place or the jobs", async () => {
  const dir = await Deno.makeTempDir();
  const ground = await installExecGround(dir, "a1");
  const mind = ground.shell();
  const build = ground.shell();
  try {
    const run = (shell: typeof mind) => async (command: string) =>
      String(await shell.exec.bash.execute({ command }, live()));
    await Deno.mkdir(`${dir}/proj`);
    await build.stand(`${dir}/proj`);
    assertEquals(await run(build)("pwd"), await Deno.realPath(`${dir}/proj`));
    assertEquals(await run(mind)("pwd"), await Deno.realPath(wsOf(dir))); // unmoved
    await run(build)("sleep 30 &");
    assert((await build.ambient()).some((l) => l.startsWith("background — 1 job")));
    assert(!(await mind.ambient()).some((l) => l.startsWith("background —")));
  } finally {
    await mind.reap();
    await build.reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: a cwd the shell cannot stand in is said once, and the next call is home", async () => {
  const dir = await Deno.makeTempDir();
  const shell = (await installExecGround(dir, "a1")).shell();
  try {
    const run = async (command: string) =>
      String(await shell.exec.bash.execute({ command }, live()));
    await Deno.mkdir(`${dir}/gone`);
    await shell.stand(`${dir}/gone`);
    await Deno.remove(`${dir}/gone`);
    const err = await assertRejects(() => run("pwd"), Error);
    assertStringIncludes(err.message, `${dir}/gone`);
    assertStringIncludes(err.message, wsOf(dir));
    assertEquals(await run("pwd"), await Deno.realPath(wsOf(dir)));
  } finally {
    await shell.reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: an issued LANG stands over the inherited one", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/workspace`, { recursive: true });
    const bash = bashTool({
      workspace: `${dir}/workspace`,
      env: () => Promise.resolve({ LANG: "es_AR.UTF-8" }),
    });
    const out = String(await bash.execute({ command: 'echo "$LANG"' }, live()));
    assertEquals(out, "es_AR.UTF-8");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: the model can override the truncation limits", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/workspace`, { recursive: true });
    const bash = bashTool({ workspace: `${dir}/workspace` });
    // narrower than the default: keep only the last 5 lines
    const narrow = String(await bash.execute({ command: "seq 1 100", max_lines: 5 }, live()));
    assertStringIncludes(narrow, "100");
    assert(!narrow.includes("\n90\n"));
    assertStringIncludes(narrow, "showing lines 96-100 of 100");
    // one line past the byte cap: the footer says only its end is shown
    const long = String(
      await bash.execute(
        { command: "echo head; printf 'x%.0s' $(seq 1 3000)", max_bytes: 1000 },
        live(),
      ),
    );
    assertMatch(long, /\[showing only the end of line 2 of 2: its last \d+ B of 2\.9 kB — full/);
    assert(!long.includes("head"));
    // wider than the default: 3000 lines fit when asked for
    const wide = String(
      await bash.execute({ command: "seq 1 3000", max_lines: 5000, max_bytes: 500_000 }, live()),
    );
    assert(wide.startsWith("1\n")); // the head survived — no tail-truncation
    assertStringIncludes(wide, "3000");
    assert(!wide.includes("full output:")); // nothing truncated, nothing persisted
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("binaries: fetch through bash — a loopback answer, pretty, and a 404 as an error", async () => {
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen() {} }, (req) => {
    if (new URL(req.url).pathname === "/ok") {
      return Response.json({ got: req.headers.get("authorization"), method: req.method });
    }
    return new Response("nothing here", { status: 404 });
  });
  const base = `http://127.0.0.1:${server.addr.port}`;
  try {
    await withPlane(async ({ run }) => {
      // the header rides as written: a $VAR the environment holds is the proxy's to swap
      const out = await run(
        `export TOK=mu-grant-x; fetch -H "Authorization: Bearer $TOK" ${base}/ok`,
      );
      assertStringIncludes(out, '"got": "Bearer mu-grant-x"');
      assertStringIncludes(out, '"method": "GET"');
      // a status outside 2xx is the command failing: the is_error path, body included
      await assertRejects(() => run(`fetch ${base}/miss`), Error, "HTTP 404\nnothing here");
    });
  } finally {
    await server.shutdown();
  }
});

Deno.test("binaries: awrite → aread → aedit roundtrip through bash", async () => {
  await withPlane(async ({ run }) => {
    await run("awrite notes/a.txt <<'EOF'\nhello world\nsecond line\nEOF");
    assertEquals(await run("aread notes/a.txt"), "hello world\nsecond line");

    await run("aedit notes/a.txt <<'EOF'\n<<<<<<<\nhello world\n=======\nhola mundo\n>>>>>>>\nEOF");
    assertEquals(await run("cat notes/a.txt"), "hola mundo\nsecond line");

    // aread paging: offset/limit + continuation footer
    const page = await run("aread notes/a.txt 1 1");
    assertStringIncludes(page, "hola mundo");
    assertStringIncludes(page, "continue: aread notes/a.txt 2");

    // aread byte-cap override: a cap smaller than the first line says so honestly
    const capped = await run("aread notes/a.txt 1 2 5");
    assertStringIncludes(capped, "exceeds the byte cap");
  });
});

Deno.test("binaries: atomic replace preserves the file's mode and leaves no temp residue", async () => {
  await withPlane(async ({ run }) => {
    await run("awrite s.sh <<'EOF'\n#!/bin/sh\necho hi\nEOF");
    await run("chmod 755 s.sh");
    await run("aedit s.sh <<'EOF'\n<<<<<<<\necho hi\n=======\necho hola\n>>>>>>>\nEOF");
    // the temp+rename commit must carry the ORIGINAL mode, not the temp's default
    assertStringIncludes(await run("stat -c %a s.sh"), "755");
    await run("awrite s.sh <<'EOF'\nreplaced\nEOF"); // overwrite path preserves mode too
    assertStringIncludes(await run("stat -c %a s.sh"), "755");
    assertEquals(await run("ls -A | grep -c tmp || true"), "0"); // no .tmp droppings
  });
});

Deno.test("binaries: aedit failure surfaces as a bash error the agent can read", async () => {
  await withPlane(async ({ run }) => {
    await run("awrite f.txt <<'EOF'\ndup dup\nEOF");
    const err = await assertRejects(
      () => run("aedit f.txt <<'EOF'\n<<<<<<<\ndup\n=======\nx\n>>>>>>>\nEOF"),
      Error,
    );
    assertStringIncludes(err.message, "more than once");
  });
});

Deno.test("bash: a cd lasts its call (STICKY_CWD off), and so does env", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/workspace/sub`, { recursive: true });
    const bash = bashTool({ workspace: `${dir}/workspace` });
    const home = await Deno.realPath(`${dir}/workspace`);
    assertEquals(String(await bash.execute({ command: "pwd" }, live())), home);
    assertEquals(String(await bash.execute({ command: "cd sub && pwd" }, live())), `${home}/sub`);
    assertEquals(String(await bash.execute({ command: "pwd" }, live())), home); // not kept
    // env does NOT persist (fresh subprocess each call)
    await bash.execute({ command: "export FOO=bar" }, live());
    assertEquals(String(await bash.execute({ command: "echo ${FOO:-unset}" }, live())), "unset");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: the exit status rides beside the output, and a call that ended leaves nothing", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/workspace`, { recursive: true });
    const bash = bashTool({ workspace: `${dir}/workspace` });
    const out = String(await bash.execute({ command: "echo hello" }, live()));
    assertEquals(out, "hello");
    // a non-zero exit is an error, whether the command ran to its end or called exit
    for (const command of ["echo oops; false; (exit 5)", "echo oops; exit 5"]) {
      const err = await assertRejects(() => bash.execute({ command }, live()), Error);
      assertStringIncludes(err.message, "exited with code 5");
      assertStringIncludes(err.message, "oops");
    }
    assertEquals(await Array.fromAsync(Deno.readDir(`${dir}/workspace/.out`)), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: a run reports its exit code and the bytes it printed — the whole of them, past any window", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/workspace`, { recursive: true });
    const bash = bashTool({ workspace: `${dir}/workspace` });
    const facts: ExecFacts[] = [];
    const report = (f: ExecFacts) => facts.push(f);
    await bash.execute({ command: "printf 'héllo'" }, live(), report);
    // a narrowed window shows 5 lines; the run printed every one of them
    await bash.execute({ command: "seq 1 1000", max_lines: 5 }, live(), report);
    await assertRejects(() => bash.execute({ command: "echo oops; exit 5" }, live(), report));
    assertEquals(facts, [
      { exit_code: 0, bytes: 6 },
      { exit_code: 0, bytes: 3893 },
      { exit_code: 5, bytes: 5 },
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const pgrepCount = (pattern: string): number => {
  const out = new Deno.Command("pgrep", { args: ["-fc", pattern] }).outputSync();
  return Number(new TextDecoder().decode(out.stdout).trim() || "0");
};

Deno.test("bash: a backgrounded job returns the call at once", async () => {
  const dir = await Deno.makeTempDir();
  const marker = `mu_bg_${crypto.randomUUID().slice(0, 8)}`;
  const jobs = new Jobs(localHost());
  try {
    await Deno.mkdir(`${dir}/workspace`, { recursive: true });
    const bash = bashTool({ workspace: `${dir}/workspace`, defaultWaitMs: 30_000, jobs });
    const t0 = Date.now();
    // a long sleeper (uniquely named via exec -a) that holds the log
    const answer = await bash.execute(
      { command: `echo launched; exec -a ${marker} sleep 30 &` },
      live(),
    ) as { output: string; async?: true };
    const ms = Date.now() - t0;
    const out = answer.output;
    assertEquals(answer.async, true); // its end is owed, as one past its wait
    assertStringIncludes(out, "launched");
    assertMatch(out, /\[left running as group \d+: what it prints goes on in \S+; you are told/);
    assert(ms < 5000, `backgrounded call took ${ms}ms — waited on the job`);
  } finally {
    await jobs.reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: a job the call left prints on into its log, told at its end", async () => {
  const dir = await Deno.makeTempDir();
  const { jobs, told } = telling();
  try {
    const bash = bashTool({ workspace: dir, jobs });
    // no redirect: the job writes where the call's output went, after the call answered
    const command = "(for i in 1 2 3; do echo tick $i; sleep 0.3; done; touch finished) &";
    const answer = await bash.execute({ command }, live(), undefined, USE) as { output: string };
    assertStringIncludes(answer.output, "left running as group");
    const end = await told(1);
    assertEquals(end.final, true);
    assertMatch(end.output, /^what it left running ended after \d+s \(group \d+\); its exit/);
    assertStringIncludes(end.output, "tick 3"); // read on, so the job lived to print it
    assertEquals(await Deno.stat(`${dir}/finished`).then(() => true, () => false), true);
  } finally {
    await jobs.reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exec plane: reap() kills background jobs the agent left running (no orphans)", async () => {
  const dir = await Deno.makeTempDir();
  const { exec, reap } = (await installExecGround(dir, "a1")).shell();
  const marker = `mu_reap_${crypto.randomUUID().slice(0, 8)}`;
  try {
    // a detached background job that outlives the call — argv carries the marker (exec -a)
    await exec.bash.execute({ command: `exec -a ${marker} sleep 300 &` }, live());
    await new Promise((r) => setTimeout(r, 300));
    assert(pgrepCount(marker) >= 1, "bg job should survive the call");
    await reap(); // shutdown — nothing should outlive the harness
    await new Promise((r) => setTimeout(r, 200));
    assertEquals(pgrepCount(marker), 0);
  } finally {
    new Deno.Command("pkill", { args: ["-f", marker] }).outputSync();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exec plane: a background job that ends is told once, ambient look or not", async () => {
  const dir = await Deno.makeTempDir();
  const updates: ShellUpdate[] = [];
  const { exec, ambient, reap } = (await installExecGround(dir, "a1")).shell((u) =>
    updates.push(u)
  );
  try {
    await exec.bash.execute({ command: "sleep 0.5 > /dev/null 2>&1 &" }, live(), undefined, USE);
    assertEquals(updates, []); // still running
    await new Promise((r) => setTimeout(r, 900));
    await ambient(); // the every-think look settles it before the probe does
    await new Promise((r) => setTimeout(r, 2500)); // …and the probe finds nothing left
    assertEquals(updates.length, 1);
    assertEquals(updates[0].command, "sleep 0.5 > /dev/null 2>&1 &");
    assertEquals(updates[0].final, true);
    assertMatch(updates[0].output, /its exit status is not known, and it printed nothing more$/);
  } finally {
    await reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exec plane: reap kills each job and tells it the org was stopped", async () => {
  const dir = await Deno.makeTempDir();
  const updates: ShellUpdate[] = [];
  const { exec, reap } = (await installExecGround(dir, "a1")).shell((u) => updates.push(u));
  try {
    await exec.bash.execute({ command: "sleep 300", wait: 0 }, live(), undefined, USE);
    await reap();
    assertEquals(updates.length, 1);
    assertMatch(updates[0].output, /^killed after \d+s when the org was stopped \(group \d+\)$/);
    assertEquals(updates[0].final, true);
    await new Promise((r) => setTimeout(r, 300)); // the killed bash's own end is not told again
    assertEquals(updates.length, 1);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Waits for the n-th of `updates`. */
async function nth(updates: ShellUpdate[], n: number, ms = 5000): Promise<ShellUpdate> {
  const until = Date.now() + ms;
  while (updates.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
  assert(updates.length >= n, `told ${updates.length} of ${n}: ${JSON.stringify(updates)}`);
  return updates[n - 1];
}

Deno.test("exec plane: a job outlives the harness that left it, and the next one tells its end", async () => {
  const dir = await Deno.makeTempDir();
  const ground = await installExecGround(dir, "a1");
  const before: ShellUpdate[] = [];
  const after: ShellUpdate[] = [];
  const first = ground.shell((u) => before.push(u));
  const next = ground.shell((u) => after.push(u));
  const ended = { command: "echo started; sleep 0.5; echo done; exit 4", wait: 0 };
  const runs = { command: "sleep 1; echo late", wait: 0 };
  const U2 = { id: "u2", turn_id: "t1" };
  try {
    await first.exec.bash.execute(ended, live(), undefined, USE);
    await first.exec.bash.execute(runs, live(), undefined, U2);
    first.leave(); // the harness goes down: the jobs run on, and nobody follows them
    await new Promise((r) => setTimeout(r, 800));
    assertEquals(before, []);
    // one ended meanwhile: its end is told at once, from what it wrote
    assertEquals(await next.resume(USE, ended), true);
    const end = await nth(after, 1);
    assertEquals([end.use, end.final, end.is_error], [USE, true, true]);
    assertEquals(end.output, "exited 4 while the harness was down\nstarted\ndone");
    // one still running is followed on, and its end told when it comes
    assertEquals(await next.resume(U2, runs), true);
    const late = await nth(after, 2);
    assertEquals(late.use, U2);
    assertMatch(late.output, /^exited 0 after 1s\nlate$/);
    // a call that left no job is not found
    assertEquals(await next.resume({ id: "u9", turn_id: "t1" }, runs), false);
  } finally {
    await first.reap();
    await next.reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exec plane: a call a crashed turn left unanswered is answered from its job", async () => {
  const dir = await Deno.makeTempDir();
  const ground = await installExecGround(dir, "a1");
  const updates: ShellUpdate[] = [];
  const first = ground.shell();
  const next = ground.shell((u) => updates.push(u));
  const runs = { command: "echo early; sleep 0.8; echo late", wait: 0 };
  const failed = { command: "echo quick; sleep 0.2; exit 2", wait: 0 };
  const U2 = { id: "u2", turn_id: "t1" };
  let stranger: Deno.ChildProcess | undefined;
  try {
    await first.exec.bash.execute(runs, live(), undefined, USE);
    await first.exec.bash.execute(failed, live(), undefined, U2);
    first.leave();
    await new Promise((r) => setTimeout(r, 400));
    // still running: answered async with what it printed, and followed on
    const answer = await next.exec.bash.recover!(runs, USE) as ExecOutcome;
    assertEquals(answer.async, true);
    assertMatch(
      String(answer.output),
      /^early\n\n\[the harness went down while it ran; it runs on as group \d+: what it prints/,
    );
    const end = await nth(updates, 1);
    assertMatch(end.output, /^exited 0 after \d+s\nlate$/); // what it printed since the answer
    // ended meanwhile: answered with how it ended
    const err = await assertRejects(() => next.exec.bash.recover!(failed, U2), Error);
    assertStringIncludes(
      err.message,
      "quick\n\n[the harness went down while it ran, and it ended]",
    );
    assertStringIncludes(err.message, "Command exited with code 2");
    // a group that took the job's number is a stranger's: the job is gone
    stranger = new Deno.Command("setsid", { args: ["sleep", "30"] }).spawn();
    await Deno.writeTextFile(`${dir}/agents/a1/.out/bash-u7.pgid`, `${stranger.pid}\n`);
    const gone = await assertRejects(
      () => next.exec.bash.recover!({ command: "x" }, { id: "u7", turn_id: "t1" }),
      Error,
    );
    assertStringIncludes(gone.message, "killed before its exit status was written");
    // a call that left nothing is the caller's to answer
    assertEquals(
      await next.exec.bash.recover!({ command: "x" }, { id: "u9", turn_id: "t1" }),
      undefined,
    );
  } finally {
    stranger?.kill("SIGKILL");
    await stranger?.status;
    await next.reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: a log past the cap drops its older half, and the agent is told once", async () => {
  const dir = await Deno.makeTempDir();
  const { jobs, updates, told } = telling();
  try {
    const bash = bashTool({ workspace: dir, jobs });
    const command = `head -c ${SPOOL_CAP + 4 * 1024 * 1024} /dev/zero | tr '\\0' x | fold -w 99; ` +
      "echo; sleep 0.5; echo end";
    await bash.execute({ command, wait: 0 }, live(), undefined, USE);
    const end = await told(1, 20_000);
    assertMatch(
      end.output,
      /\nx+\nend\n\n\[its last lines — full output: \S+\]\n\n\[its output passed 50 MB: the older half of \S+ was dropped and reads as zero bytes\]$/,
    );
    assertEquals(updates.length, 1);
    // every byte the job wrote is still counted: the x's, fold's newlines, "\nend\n"
    const xs = SPOOL_CAP + 4 * 1024 * 1024;
    const log = await Deno.stat(`${dir}/.out/bash-u1.log`);
    assertEquals(log.size, xs + Math.ceil(xs / 99) - 1 + 5);
    assert(log.blocks! * 512 < SPOOL_CAP, `${log.blocks}`);
  } finally {
    await jobs.reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: a finished job's log goes a week after its last word; a running one's stays", async () => {
  const out = await Deno.makeTempDir();
  // a job of its own group that carries its call's mark
  const job = new Deno.Command("setsid", {
    args: ["sleep", "30"],
    env: { [JOB_ENV]: "running" },
  }).spawn();
  try {
    const old = new Date(Date.now() - 8 * 86_400_000);
    for (const id of ["old", "fresh", "running", "left"]) {
      await Deno.writeTextFile(`${out}/bash-${id}.log`, "x\n");
    }
    await Deno.writeTextFile(`${out}/bash-old.end`, "0\n");
    await Deno.writeTextFile(`${out}/bash-running.pgid`, `${job.pid}\n`);
    // a group file its harness never took away, naming a group that is not the job's
    await Deno.writeTextFile(`${out}/bash-left.pgid`, "1\n");
    for (const id of ["old", "running", "left"]) {
      await Deno.utime(`${out}/bash-${id}.log`, old, old);
    }
    await sweepLogs(out);
    assertEquals((await Array.fromAsync(Deno.readDir(out))).map((e) => e.name).sort(), [
      "bash-fresh.log",
      "bash-running.log",
      "bash-running.pgid",
    ]);
  } finally {
    job.kill();
    await job.status;
    await Deno.remove(out, { recursive: true });
  }
});

Deno.test("exec plane: a job's line wears the last line it printed", async () => {
  const dir = await Deno.makeTempDir();
  const { exec, ambient, reap } = (await installExecGround(dir, "a1")).shell();
  try {
    await exec.bash.execute({
      command: "printf 'building\\n10%%\\r50%%\\r90%%'; sleep 300",
      wait: 0.3,
    }, live());
    await new Promise((r) => setTimeout(r, 200));
    const line = (await ambient()).find((l) => l.startsWith("· "));
    assertMatch(line!, /— running \d+s, last line "90%" · pid \d+/);
  } finally {
    await reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exec plane: ambient() reports cwd, git, and live background jobs", async () => {
  const dir = await Deno.makeTempDir();
  const { exec, ambient, reap } = (await installExecGround(dir, "a1")).shell();
  const marker = `mu_amb_${crypto.randomUUID().slice(0, 8)}`;
  try {
    // cwd only, no repo, no jobs
    let lines = await ambient();
    assert(lines[0].startsWith("cwd: "));
    assert(lines.every((l) => !l.startsWith("git:")), "no git line outside a repo");
    assert(lines.every((l) => !l.startsWith("background")), "no jobs yet");

    // make it a git repo → git line appears
    await exec.bash.execute({
      command: "git init -q && git config user.email a@b.c && git config user.name a",
    }, live());
    await exec.bash.execute({ command: "echo hi > f.txt" }, live()); // an uncommitted change
    lines = await ambient();
    assert(lines.some((l) => l.startsWith("git:") && l.includes("uncommitted")), lines.join(" | "));

    // launch a background job → appears; reap → gone
    await exec.bash.execute({ command: `exec -a ${marker} sleep 300 &` }, live());
    await new Promise((r) => setTimeout(r, 200));
    lines = await ambient();
    assert(lines.some((l) => l.startsWith("background — 1 job")), lines.join(" | "));
    const jobLine = lines.find((l) => l.startsWith("· "));
    assert(jobLine, lines.join(" | "));
    assert(/ · pid \d+$/.test(jobLine!), `job line must carry a kill handle: ${jobLine}`);
    assert(jobLine!.startsWith(`· ${marker} `), `the job is named by its live process: ${jobLine}`);
    assert(!jobLine!.includes("exec -a"), `not by the call that launched it: ${jobLine}`);
    await reap();
    lines = await ambient();
    assert(lines.every((l) => !l.startsWith("background")), "reaped job gone from ambient");
  } finally {
    new Deno.Command("pkill", { args: ["-f", marker] }).outputSync();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exec plane: a job whose leader is gone is named by the member alive, with its pid", async () => {
  // the session's case: a write that ended with `(vite &)` was listed as the write, running on
  const dir = await Deno.makeTempDir();
  const { exec, ambient, reap } = (await installExecGround(dir, "a1")).shell();
  const marker = `mu_sub_${crypto.randomUUID().slice(0, 8)}`;
  try {
    await exec.bash.execute(
      { command: `echo hi > f.txt; (exec -a ${marker} sleep 300 &)` },
      live(),
    );
    await new Promise((r) => setTimeout(r, 200));
    const jobLine = (await ambient()).find((l) => l.startsWith("· "));
    assert(jobLine, "the job shows");
    const m = /^· (\S+) 300 — running \d+s · pid (\d+)$/.exec(jobLine!);
    assert(m, `named by its live process, with its pid: ${jobLine}`);
    assertEquals(m![1], marker);
    const ps = new TextDecoder().decode(
      new Deno.Command("ps", { args: ["-o", "args=", "-p", m![2]] }).outputSync().stdout,
    );
    assertStringIncludes(ps, marker); // the pid is the member's, a kill handle that works
  } finally {
    await reap();
    new Deno.Command("pkill", { args: ["-f", marker] }).outputSync();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exec plane: aread on a bytes file returns an ExecOutcome — path peeled, no mojibake", async () => {
  const dir = await Deno.makeTempDir();
  const { exec, reap } = (await installExecGround(dir, "a1")).shell();
  try {
    const png = `${wsOf(dir)}/dot.png`;
    await Deno.writeFile(png, new Uint8Array([137, 80, 78, 71]));
    const out = await exec.bash.execute({ command: "aread dot.png" }, live());
    const outcome = out as { output: string; files: string[] };
    assertEquals(outcome.files, [png]);
    assert(outcome.output.includes("[media image/png · 4 bytes]"));
    assert(!outcome.output.includes("__MU_MEDIA__")); // the mark never reaches the model
    // a text file stays a plain string result — no outcome wrapper
    await Deno.writeTextFile(`${wsOf(dir)}/a.txt`, "hola");
    assertEquals(await exec.bash.execute({ command: "aread a.txt" }, live()), "hola");
  } finally {
    await reap();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exec plane: aread classifies by bytes when the extension says nothing", async () => {
  const dir = await Deno.makeTempDir();
  const { exec, reap } = (await installExecGround(dir, "a1")).shell();
  try {
    // an extension-less PNG: sniffed → media mark → attachment
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await Deno.writeFile(`${wsOf(dir)}/snapshot`, png);
    const out = await exec.bash.execute({ command: "aread snapshot" }, live());
    const outcome = out as { output: string; files: string[] };
    assertEquals(outcome.files, [`${wsOf(dir)}/snapshot`]);
    assert(outcome.output.includes("[media image/png"));
    // an unknown binary (NUL bytes, no signature): a notice, never mojibake, no attachment
    await Deno.writeFile(`${wsOf(dir)}/blob.xyz`, new Uint8Array([1, 0, 2, 0, 3]));
    const blob = await exec.bash.execute({ command: "aread blob.xyz" }, live());
    assertEquals(blob, "[binary · 5 bytes — not a text file]");
  } finally {
    await reap();
    await Deno.remove(dir, { recursive: true });
  }
});
