import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { type Gateway, parseExecStream, quote, remoteShell, sandboxIdOf } from "./gateway.ts";
import type { ExecOutcome } from "../xi.ts";

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
    read: (path) => Deno.readFile(path),
    destroy: () => Promise.resolve(),
  };
}

async function withShell(
  body: (shell: ReturnType<typeof remoteShell>, workspace: string) => Promise<void>,
) {
  const workspace = await Deno.makeTempDir();
  const shell = remoteShell(localGateway(), {
    workspace,
    env: () => ({ PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin", LANG: "C.UTF-8" }),
    defaultTimeoutMs: 20_000,
  });
  try {
    await body(shell, workspace);
  } finally {
    await shell.reap();
    await Deno.remove(workspace, { recursive: true });
  }
}

const run = (shell: ReturnType<typeof remoteShell>, input: Record<string, unknown>) =>
  shell.exec.bash.execute(input as never, new AbortController().signal);

Deno.test("remote shell: the output, both streams in order; a non-zero exit is the error result", async () => {
  await withShell(async (shell) => {
    assertEquals(await run(shell, { command: "echo a; echo b >&2; echo c" }), "a\nb\nc");
    await assertRejects(
      () => run(shell, { command: "echo nope; exit 3" }),
      Error,
      "Command exited with code 3",
    );
    await assertRejects(() => run(shell, { command: "false" }), Error, "code 1");
  });
});

Deno.test("remote shell: the cwd sticks across calls, and a lost one is said once", async () => {
  await withShell(async (shell, workspace) => {
    await run(shell, { command: "mkdir -p sub/deeper && cd sub/deeper" });
    assertEquals(await run(shell, { command: "pwd" }), `${workspace}/sub/deeper`);
    assertEquals((await shell.ambient())[0], `cwd: ${workspace}/sub/deeper`);
    await Deno.remove(`${workspace}/sub`, { recursive: true });
    await assertRejects(() => run(shell, { command: "pwd" }), Error, "cannot stand there");
    assertEquals(await run(shell, { command: "pwd" }), workspace);
  });
});

Deno.test("remote shell: the environment is the issued one alone", async () => {
  await withShell(async (shell) => {
    const env = String(await run(shell, { command: "env | sort" }));
    assertEquals(
      env.split("\n").map((l) => l.split("=")[0]).filter((k) => !["PWD", "SHLVL", "_"].includes(k)),
      ["LANG", "PATH"],
    );
  });
});

Deno.test("remote shell: a timeout kills the command's whole tree and says so", async () => {
  await withShell(async (shell, workspace) => {
    await assertRejects(
      () =>
        run(shell, {
          command: `(sleep 5; touch ${quote(`${workspace}/late`)}) & sleep 5; echo never`,
          timeout: 1,
        }),
      Error,
      "timed out after 1s",
    );
    await new Promise((r) => setTimeout(r, 300));
    const left = await new Deno.Command("pgrep", { args: ["-f", `touch ${workspace}/late`] })
      .output();
    assertEquals(left.code, 1, "nothing of the tree is left running");
  });
});

Deno.test("remote shell: a background job returns the call, shows in the ambient block, and is reaped", async () => {
  await withShell(async (shell) => {
    const t0 = Date.now();
    assertEquals(await run(shell, { command: "sleep 30 & echo started" }), "started");
    assert(Date.now() - t0 < 5_000, "the call did not wait for the job");
    const lines = await shell.ambient();
    assertStringIncludes(lines.join("\n"), "background — 1 job:");
    assertStringIncludes(lines.join("\n"), "sleep 30 & echo started");
    await shell.reap();
    await new Promise((r) => setTimeout(r, 200));
    assertEquals((await shell.ambient()).some((l) => l.startsWith("background")), false);
  });
});

Deno.test("remote shell: output past the window keeps its spill in the workspace; output within it leaves none", async () => {
  await withShell(async (shell, workspace) => {
    await run(shell, { command: "seq 1 10" });
    const before = [...Deno.readDirSync(`${workspace}/.out`)];
    assertEquals(before.length, 0);
    const text = String(await run(shell, { command: "seq 1 50", max_lines: 5 }));
    assertStringIncludes(text, "46\n47\n48\n49\n50");
    const path = /full output: (\S+)\]/.exec(text)![1];
    assertEquals(
      await Deno.readTextFile(path),
      `${Array.from({ length: 50 }, (_, i) => i + 1).join("\n")}\n`,
    );
  });
});

Deno.test("remote shell: a media mark becomes an attachment", async () => {
  await withShell(async (shell) => {
    const out = await run(shell, {
      command: "echo shown; printf '__MU_MEDIA__:/workspace/pic.png\\n'",
    }) as ExecOutcome;
    assertEquals(out, { output: "shown", files: ["/workspace/pic.png"] });
  });
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
