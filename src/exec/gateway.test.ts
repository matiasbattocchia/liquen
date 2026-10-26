import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  type Gateway,
  gatewayFiles,
  gatewayFor,
  lease,
  parseExecStream,
  quote,
  remoteShell,
  sandboxIdOf,
} from "./gateway.ts";
import { newId } from "../store/id.ts";
import { pathOf } from "../store/media.ts";
import type { ExecFacts, ExecOutcome } from "../xi.ts";
import { JOB_ENV, type ShellUpdate, SPOOL_CAP } from "./jobs.ts";

const USE = { id: "u1", turn_id: "t1" };

/** A gateway whose sandbox is this machine: each script runs under the local bash, as the
 *  bridge would run it in the container. */
function localGateway(): Gateway {
  return {
    async exec(script) {
      const out = await new Deno.Command("bash", {
        args: ["-c", script],
        stdout: "piped",
        stderr: "piped",
      }).output();
      const text = new TextDecoder();
      return { stdout: text.decode(out.stdout), stderr: text.decode(out.stderr), code: out.code };
    },
    async read(path) {
      try {
        return await Deno.readFile(path);
      } catch (err) {
        if (err instanceof Deno.errors.NotFound) return null;
        throw err;
      }
    },
    destroy: () => Promise.resolve(),
  };
}

/** Where a case runs: a folder of its own on a gateway, and the environment it issues. */
interface Place {
  gateway: Gateway;
  workspace: string;
  env: Record<string, string>;
}

/** The places every case runs on: this machine through the fake, and — when
 *  `LIQUEN_TEST_SANDBOX` names a gateway, `SANDBOX_API_KEY` its token — a live sandbox,
 *  each case in a folder of its own under the container's workspace. */
const PLACES: [string, (() => Promise<Place>) | null][] = [
  ["local", async () => ({
    gateway: localGateway(),
    workspace: await Deno.makeTempDir(),
    env: { PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
  })],
  [
    "live",
    Deno.env.get("LIQUEN_TEST_SANDBOX")
      ? async () => {
        const gateway = gatewayFor(
          Deno.env.get("LIQUEN_TEST_SANDBOX")!,
          Deno.env.get("SANDBOX_API_KEY") ?? "",
          sandboxIdOf("liquen-test"),
        );
        const workspace = `/workspace/t-${newId()}`;
        await gateway.exec(`mkdir -p ${quote(workspace)}`);
        return {
          gateway,
          workspace,
          env: { PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8" },
        };
      }
      : null,
  ],
];

type Shell = ReturnType<typeof remoteShell>;

/** Waits for the n-th of `updates`. */
async function nth(updates: ShellUpdate[], n: number, ms = 15_000): Promise<ShellUpdate> {
  const until = Date.now() + ms;
  while (updates.length < n && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
  assert(updates.length >= n, `told ${updates.length} of ${n}: ${JSON.stringify(updates)}`);
  return updates[n - 1];
}

function cases(
  name: string,
  body: (shell: Shell, place: Place, updates: ShellUpdate[]) => Promise<void>,
  only?: string,
) {
  for (const [label, open] of PLACES) {
    if (only && label !== only) continue;
    Deno.test({
      name: `${label} shell: ${name}`,
      ignore: open === null,
      async fn() {
        const place = await open!();
        const updates: ShellUpdate[] = [];
        const shell = remoteShell(place.gateway, {
          workspace: place.workspace,
          env: () => place.env,
          defaultWaitMs: 20_000,
        }, (u) => updates.push(u));
        try {
          await body(shell, place, updates);
        } finally {
          await shell.reap();
          await place.gateway.exec(`rm -rf ${quote(place.workspace)}`);
        }
      },
    });
  }
}

const run = (shell: Shell, input: Record<string, unknown>) =>
  shell.exec.bash.execute(input as never, new AbortController().signal);

cases("the output, both streams in order; a non-zero exit is the error result", async (shell) => {
  assertEquals(await run(shell, { command: "echo a; echo b >&2; echo c" }), "a\nb\nc");
  await assertRejects(
    () => run(shell, { command: "echo nope; exit 3" }),
    Error,
    "Command exited with code 3",
  );
  await assertRejects(() => run(shell, { command: "false" }), Error, "code 1");
});

cases("a run reports its exit code and the bytes it printed", async (shell) => {
  const facts: ExecFacts[] = [];
  const report = (f: ExecFacts) => facts.push(f);
  await shell.exec.bash.execute({ command: "echo hi" }, new AbortController().signal, report);
  await assertRejects(() =>
    shell.exec.bash.execute({ command: "exit 4" }, new AbortController().signal, report)
  );
  assertEquals(facts, [{ exit_code: 0, bytes: 3 }, { exit_code: 4, bytes: 0 }]);
});

cases(
  "a cd lasts its call, the shell is stood, and a lost place is said once",
  async (shell, place) => {
    const { workspace, gateway } = place;
    await run(shell, { command: "mkdir -p sub/deeper && cd sub/deeper" });
    assertEquals(await run(shell, { command: "pwd" }), workspace); // the cd was the call's
    await shell.stand(`${workspace}/sub/deeper`);
    assertEquals(await run(shell, { command: "pwd" }), `${workspace}/sub/deeper`);
    assertEquals((await shell.ambient())[0], `cwd: ${workspace}/sub/deeper`);
    await gateway.exec(`rm -rf ${quote(`${workspace}/sub`)}`);
    await assertRejects(() => run(shell, { command: "pwd" }), Error, "cannot stand there");
    assertEquals(await run(shell, { command: "pwd" }), workspace);
  },
);

cases("the environment is the issued one alone, and the call's id", async (shell) => {
  const env = String(await run(shell, { command: "env | sort" }));
  assertEquals(
    env.split("\n").map((l) => l.split("=")[0]).filter((k) => !["PWD", "SHLVL", "_"].includes(k)),
    ["LANG", "LIQUEN_JOB", "PATH"],
  );
});

cases(
  "a wait run out answers async, the job runs on, and its end and its wake lines are told",
  async (shell, _place, updates) => {
    const answer = await shell.exec.bash.execute(
      {
        // the probe looks every 5s: the wake line is seen while the job still runs
        command: "echo early; sleep 1.5; echo 'ERROR one'; sleep 5; echo done; exit 3",
        wait: 1,
        wake: "^ERROR",
      },
      new AbortController().signal,
      undefined,
      USE,
    ) as ExecOutcome;
    assertEquals(answer.async, true);
    assert(
      /^early\n\n\[still running after 1s as group \d+: what it prints goes on in \S+\/\.out\/bash-u1\.log, and you are told when it ends\]$/
        .test(String(answer.output)),
      String(answer.output),
    );
    const woke = await nth(updates, 1);
    assertEquals([woke.use, woke.output, woke.final], [USE, "ERROR one", undefined]);
    const end = await nth(updates, 2);
    assertEquals([end.final, end.is_error], [true, true]);
    assert(/^exited 3 after \d+s\nERROR one\ndone$/.test(end.output), end.output);
  },
);

cases(
  "a log past the cap drops its older half, keeps every later byte, and is told once",
  async (shell, place, updates) => {
    const xs = SPOOL_CAP + 4 * 1024 * 1024;
    await shell.exec.bash.execute(
      { command: `head -c ${xs} /dev/zero | tr '\\0' x | fold -w 99; echo; echo end`, wait: 0 },
      new AbortController().signal,
      undefined,
      USE,
    );
    const end = await nth(updates, 1, 120_000);
    assert(
      /\nx+\nend\n\n\[its last lines — full output: \S+\]\n\n\[its output passed 50 MB: the older half of \S+ was dropped and reads as zero bytes\]$/
        .test(end.output),
      end.output.slice(-300),
    );
    assertEquals(updates.length, 1);
    const log = quote(`${place.workspace}/.out/bash-u1.log`);
    const stat = await place.gateway.exec(`stat -c '%s %b' ${log}`);
    const [size, blocks] = stat.stdout.trim().split(" ").map(Number);
    assertEquals(size, xs + Math.ceil(xs / 99) - 1 + 5);
    assert(blocks * 512 < SPOOL_CAP, `${blocks}`);
  },
);

cases(
  "a background job returns the call, shows in the ambient block, and is reaped",
  async (shell, _place, updates) => {
    const t0 = Date.now();
    const answer = await shell.exec.bash.execute(
      { command: "sleep 30 & echo started" },
      new AbortController().signal,
      undefined,
      USE,
    ) as ExecOutcome;
    assert(Date.now() - t0 < 10_000, "the call did not wait for the job");
    assertEquals(answer.async, true);
    const said = String(answer.output);
    assert(said.startsWith("started\n\n[left running as group "), said);
    const lines = (await shell.ambient()).join("\n");
    assertStringIncludes(lines, "background — 1 job:");
    // by its live process, wearing the last line its log holds
    assert(/^· sleep 30 — running \d+s, last line "started" · pid \d+$/m.test(lines), lines);
    await shell.reap();
    assertEquals(updates.length, 1);
    assert(/^killed after \d+s when the org was stopped/.test(updates[0].output));
    assertEquals((await shell.ambient()).some((l) => l.startsWith("background")), false);
  },
);

cases(
  "a job outlives the shell that left it, and the next one finds it by the call",
  async (shell, place) => {
    const later: ShellUpdate[] = [];
    const next = remoteShell(place.gateway, {
      workspace: place.workspace,
      env: () => place.env,
    }, (u) => later.push(u));
    // long enough to outlast a live sandbox's round trips: the next shell finds it running
    const runs = { command: "echo early; sleep 6; echo late", wait: 0 };
    try {
      await shell.exec.bash.execute(runs, new AbortController().signal, undefined, USE);
      shell.leave();
      const answer = await next.exec.bash.recover!(runs, USE) as ExecOutcome;
      assertEquals(answer.async, true, JSON.stringify(answer));
      assert(
        /^early\n\n\[the harness went down while it ran; it runs on as group \d+/.test(
          String(answer.output),
        ),
        String(answer.output),
      );
      const end = await nth(later, 1);
      assert(/^exited 0 after \d+s\nlate$/.test(end.output), end.output);
      assertEquals(await next.resume({ id: "u9", turn_id: "t1" }, runs), false);
    } finally {
      await next.reap();
    }
  },
);

cases(
  "output past the window keeps its spill; output within it leaves none",
  async (shell, place) => {
    await run(shell, { command: "seq 1 10" });
    const listed = await place.gateway.exec(`ls -A ${quote(`${place.workspace}/.out`)}`);
    assertEquals(listed.stdout, "");
    const text = String(await run(shell, { command: "seq 1 50", max_lines: 5 }));
    assert(text.startsWith("1\n2\n"), text);
    assertStringIncludes(text, "\n48\n49\n50\n");
    const path = /full output: (\S+)\]/.exec(text)![1];
    assertEquals(
      new TextDecoder().decode((await place.gateway.read(path))!),
      `${Array.from({ length: 50 }, (_, i) => i + 1).join("\n")}\n`,
    );
  },
);

cases(
  "a finished job's log goes a week after its last word; a running one's stays",
  async (shell, place) => {
    const out = `${place.workspace}/.out`;
    const q = (id: string, ext: string) => quote(`${out}/bash-${id}.${ext}`);
    const pid = (await place.gateway.exec([
      `mkdir -p ${quote(out)}`,
      ...["old", "fresh", "running", "left"].map((id) => `echo x > ${q(id, "log")}`),
      `echo 0 > ${q("old", "end")}`,
      // a job of its own group that carries its call's mark
      `setsid env ${JOB_ENV}=running sleep 30 > /dev/null 2>&1 & echo $! > ${q("running", "pgid")}`,
      // a group file its harness never took away, naming a group that is not the job's
      `echo 1 > ${q("left", "pgid")}`,
      ...["old", "running", "left"].map((id) => `touch -d '8 days ago' ${q(id, "log")}`),
      `cat ${q("running", "pgid")}`,
    ].join("\n"))).stdout.trim();
    try {
      await run(shell, { command: "true" }); // a call sweeps as it starts
      const listed = await place.gateway.exec(`ls ${quote(out)}`);
      assertEquals(listed.stdout.trim().split("\n"), [
        "bash-fresh.log",
        "bash-running.log",
        "bash-running.pgid",
      ]);
    } finally {
      await place.gateway.exec(`kill -- -${pid}`);
    }
  },
);

cases(
  "a sandbox replaced under a running job tells it lost, once",
  async (shell, place, updates) => {
    await shell.exec.bash.execute(
      { command: "echo started; sleep 120", wait: 0 },
      new AbortController().signal,
      undefined,
      USE,
    );
    await place.gateway.destroy();
    const lost = await nth(updates, 1, 60_000);
    assertEquals([lost.final, lost.is_error], [true, true]);
    assert(/^lost after \d+s: the sandbox it ran in stopped or was replaced/.test(lost.output));
    assertEquals(await shell.ambient(), [`cwd: ${place.workspace}`]);
    assertEquals(updates.length, 1);
  },
  "live", // the fake has no container to replace
);

cases("a media mark becomes an attachment", async (shell) => {
  const out = await run(shell, {
    command: "echo shown; printf '__MU_MEDIA__:/workspace/pic.png\\n'",
  }) as ExecOutcome;
  assertEquals(out, { output: "shown", files: ["/workspace/pic.png"] });
});

cases("a file the agent attaches lands on the conversation's shelf", async (shell, place) => {
  const dataDir = await Deno.makeTempDir();
  try {
    await run(shell, { command: "printf '\\x89PNG\\r\\n\\x1a\\nrest' > pic.png" });
    const files = gatewayFiles(place.gateway, {
      home: place.workspace,
      dataDir,
      conversation: "ada",
    });
    const part = await files.resolve("pic.png");
    assertEquals(part.kind, "image");
    assertEquals(part.file.mime_type, "image/png");
    assertEquals(part.file.name, "pic.png");
    assert(pathOf(part.file.uri).startsWith(`${dataDir}/conversations/ada/media/`));
    assertEquals((await files.snapshot(part))?.media_type, "image/png");
    await assertRejects(() => files.resolve("gone.png"), Error, "no such file");
    await assertRejects(() => files.resolve("/etc/passwd"), Error, "outside your files");
    // with the shell's cwd, a relative reference is from where the shell stands
    await run(shell, { command: "mkdir -p shots && cp pic.png shots/b.png" });
    await shell.stand(`${place.workspace}/shots`);
    const standing = gatewayFiles(place.gateway, {
      home: place.workspace,
      cwd: shell.cwd,
      dataDir,
      conversation: "ada",
    });
    assertEquals((await standing.resolve("b.png")).file.name, "b.png");
    await assertRejects(() => standing.resolve("../../etc/passwd"), Error, "outside your files");
  } finally {
    await Deno.remove(dataDir, { recursive: true });
  }
});

/** A gateway that counts what reaches it, and a clock the case moves by hand. */
function counted() {
  const inner = localGateway();
  const calls = { exec: 0, destroy: 0 };
  const gateway: Gateway = {
    exec: (script, signal) => (calls.exec++, inner.exec(script, signal)),
    read: (path) => inner.read(path),
    destroy: () => (calls.destroy++, Promise.resolve()),
  };
  let t = 1_000_000;
  return { gateway, calls, now: () => t, pass: (minutes: number) => t += minutes * 60_000 };
}

Deno.test("lease: a bash answer starts the window, a step past it stops the sandbox once", async () => {
  const { gateway, calls, now, pass } = counted();
  const l = lease(gateway, 10, now);
  assertEquals([l.on(), l.warm()], [false, false]);
  await assertRejects(() => l.bash(() => Promise.reject(new Error("exec answered 502"))));
  assertEquals(l.on(), false, "a refused call never reached a container");
  let release!: () => void;
  const running = l.bash(() => new Promise<void>((r) => release = r));
  assertEquals([l.on(), l.warm()], [true, false]);
  pass(30);
  await l.settle();
  assertEquals(calls.destroy, 0, "a running call holds the sandbox on");
  release();
  await running;
  pass(9);
  assertEquals([l.on(), l.warm(), l.leftMs()], [true, true, 60_000]);
  await l.settle();
  assertEquals(calls.destroy, 0);
  pass(1);
  const before = l.generation();
  await l.settle();
  await l.settle();
  assertEquals([calls.destroy, l.on(), l.generation()], [1, false, before + 1]);
});

Deno.test("the ambient block: off without a probe, idle with its countdown, a restart said once", async () => {
  const workspace = await Deno.makeTempDir();
  const { gateway, calls, now, pass } = counted();
  const l = lease(gateway, 10, now);
  const shell = remoteShell(gateway, {
    workspace,
    env: () => ({ PATH: "/usr/bin:/bin" }),
    lease: l,
  });
  const line = async () => (await shell.ambient())[1];
  try {
    assertEquals(await line(), "sandbox: off · a bash call starts it");
    assertEquals(calls.exec, 0, "off, nothing reaches the gateway");
    await run(shell, { command: "echo started" });
    assertEquals(await line(), "sandbox: idle · stops in 10m · jobs and files go with it");
    pass(4);
    assertEquals(await line(), "sandbox: idle · stops in 6m · jobs and files go with it");
    pass(1);
    assertEquals(
      await line(),
      "sandbox: idle · stops in 5m · jobs and files go with it",
      "the probe keeps nothing on",
    );
    // a job followed holds the sandbox on, however long it runs
    await run(shell, { command: "sleep 3 & echo started" });
    pass(30);
    assertEquals(
      await line(),
      "sandbox: busy · on while a job runs, then 10m · jobs and files go with it",
    );
    assertStringIncludes((await shell.ambient()).join("\n"), "background — 1 job:");
    await Deno.remove("/tmp/.liquen-up"); // the container a restart brings has none
    assertEquals(
      await line(),
      "sandbox: restarted · stops in 10m · earlier jobs and files are gone",
    );
    assertEquals((await shell.ambient()).some((l) => l.startsWith("background")), false);
    assertEquals(await line(), "sandbox: idle · stops in 10m · jobs and files go with it");
    pass(5);
    await Deno.remove("/tmp/.liquen-up");
    assertEquals(await run(shell, { command: "echo again" }), "again", "the marker is no output");
    assertEquals(
      await line(),
      "sandbox: restarted · stops in 10m · earlier jobs and files are gone",
    );
    pass(10);
    assertEquals(await line(), "sandbox: off · a bash call starts it");
    assertEquals(calls.destroy, 1);
    await Deno.remove("/tmp/.liquen-up"); // the stop took it: a new start is no restart
    await run(shell, { command: "true" });
    assertEquals(await line(), "sandbox: idle · stops in 10m · jobs and files go with it");
  } finally {
    await shell.reap();
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("gatewayFor: every call carries the token and the sandbox's sleep", async () => {
  const seen: { path: string; auth: string | null; sleep: string | null }[] = [];
  const server = Deno.serve({ port: 0, onListen() {} }, (req) => {
    seen.push({
      path: new URL(req.url).pathname,
      auth: req.headers.get("authorization"),
      sleep: req.headers.get("x-sleep-after"),
    });
    return req.method === "POST"
      ? new Response(`event: exit\ndata: {"exit_code": 0}\n\n`)
      : new Response("bytes");
  });
  try {
    const url = `http://localhost:${server.addr.port}`;
    const gateway = gatewayFor(url, "tok", "mfsgc", 45);
    await gateway.exec("true");
    await gateway.read("/workspace/a.txt");
    assertEquals(seen, [
      { path: "/v1/sandbox/mfsgc/exec", auth: "Bearer tok", sleep: "45m" },
      { path: "/v1/sandbox/mfsgc/file/workspace/a.txt", auth: "Bearer tok", sleep: "45m" },
    ]);
    seen.length = 0;
    await gatewayFor(url, "tok", "mfsgc").exec("true");
    assertEquals(seen[0].sleep, null);
  } finally {
    await server.shutdown();
  }
});

Deno.test("parseExecStream: base64 chunks per stream, then the exit", () => {
  const b64 = (s: string) => btoa(s);
  const text = [
    `event: stdout\ndata: ${b64("hel")}`,
    `event: stderr\ndata: ${b64("warn")}`,
    `event: stdout\ndata: ${b64("lo")}`,
    `event: exit\ndata: {"exit_code": 2}`,
  ].join("\n\n") + "\n\n";
  assertEquals(parseExecStream(text), { stdout: "hello", stderr: "warn", code: 2 });
  assertThrows(
    () => parseExecStream(`event: stdout\ndata: ${b64("x")}\n\n`),
    Error,
    "ended without an exit",
  );
  assertThrows(
    () => parseExecStream(`event: error\ndata: {"error": "no container", "code": "x"}\n\n`),
    Error,
    "no container",
  );
});

Deno.test("sandboxIdOf: the agent's id in the bridge's alphabet, one per agent", () => {
  assertEquals(sandboxIdOf("ada"), "mfsgc");
  assert(/^[a-z2-7]+$/.test(sandboxIdOf("Ada Lovelace_01")));
  assert(sandboxIdOf("ada") !== sandboxIdOf("adb"));
});
