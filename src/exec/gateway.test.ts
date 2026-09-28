import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  clocked,
  type Gateway,
  gatewayFiles,
  gatewayFor,
  parseExecStream,
  quote,
  remoteShell,
  sandboxIdOf,
} from "./gateway.ts";
import { newId } from "../store/id.ts";
import { pathOf } from "../store/media.ts";
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

function cases(
  name: string,
  body: (shell: Shell, place: Place) => Promise<void>,
) {
  for (const [label, open] of PLACES) {
    Deno.test({
      name: `${label} shell: ${name}`,
      ignore: open === null,
      async fn() {
        const place = await open!();
        const shell = remoteShell(place.gateway, {
          workspace: place.workspace,
          env: () => place.env,
          defaultTimeoutMs: 20_000,
        });
        try {
          await body(shell, place);
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

cases("the cwd sticks across calls, and a lost one is said once", async (shell, place) => {
  const { workspace, gateway } = place;
  await run(shell, { command: "mkdir -p sub/deeper && cd sub/deeper" });
  assertEquals(await run(shell, { command: "pwd" }), `${workspace}/sub/deeper`);
  assertEquals((await shell.ambient())[0], `cwd: ${workspace}/sub/deeper`);
  await gateway.exec(`rm -rf ${quote(`${workspace}/sub`)}`);
  await assertRejects(() => run(shell, { command: "pwd" }), Error, "cannot stand there");
  assertEquals(await run(shell, { command: "pwd" }), workspace);
});

cases("the environment is the issued one alone", async (shell) => {
  const env = String(await run(shell, { command: "env | sort" }));
  assertEquals(
    env.split("\n").map((l) => l.split("=")[0]).filter((k) => !["PWD", "SHLVL", "_"].includes(k)),
    ["LANG", "PATH"],
  );
});

cases("a timeout kills the command's whole tree and says so", async (shell, place) => {
  const late = `${place.workspace}/late`;
  await assertRejects(
    () =>
      run(shell, {
        command: `(sleep 5; touch ${quote(late)}) & sleep 5; echo never`,
        timeout: 1,
      }),
    Error,
    "timed out after 1s",
  );
  await new Promise((r) => setTimeout(r, 300));
  const left = await place.gateway.exec(`pgrep -f ${quote(`touch ${late}`)}`);
  assertEquals(left.code, 1, "nothing of the tree is left running");
});

cases(
  "a background job returns the call, shows in the ambient block, and is reaped",
  async (shell) => {
    const t0 = Date.now();
    assertEquals(await run(shell, { command: "sleep 30 & echo started" }), "started");
    assert(Date.now() - t0 < 10_000, "the call did not wait for the job");
    const lines = (await shell.ambient()).join("\n");
    assertStringIncludes(lines, "background — 1 job:");
    assertStringIncludes(lines, "sleep 30 & echo started");
    await shell.reap();
    await new Promise((r) => setTimeout(r, 300));
    assertEquals((await shell.ambient()).some((l) => l.startsWith("background")), false);
  },
);

cases(
  "output past the window keeps its spill; output within it leaves none",
  async (shell, place) => {
    await run(shell, { command: "seq 1 10" });
    const listed = await place.gateway.exec(`ls -A ${quote(`${place.workspace}/.out`)}`);
    assertEquals(listed.stdout, "");
    const text = String(await run(shell, { command: "seq 1 50", max_lines: 5 }));
    assertStringIncludes(text, "46\n47\n48\n49\n50");
    const path = /full output: (\S+)\]/.exec(text)![1];
    assertEquals(
      new TextDecoder().decode((await place.gateway.read(path))!),
      `${Array.from({ length: 50 }, (_, i) => i + 1).join("\n")}\n`,
    );
  },
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
  } finally {
    await Deno.remove(dataDir, { recursive: true });
  }
});

Deno.test("the ambient block says when the last call closed, the window, and a restart", async () => {
  const workspace = await Deno.makeTempDir();
  let last: number | undefined;
  const shell = remoteShell(localGateway(), {
    workspace,
    env: () => ({ PATH: "/usr/bin:/bin" }),
    sleepMinutes: 10,
    lastCall: () => last,
  });
  const line = async () => (await shell.ambient())[1];
  try {
    assertEquals(
      await line(),
      "sandbox: stops 10 min after your last call — its background jobs and files go with it",
    );
    last = Date.now() - 8 * 60_000;
    assertEquals(
      await line(),
      "sandbox: last call 8m ago; it stops 10 min after one — its background jobs and files " +
        "go with it",
    );
    await Deno.remove("/tmp/.liquen-up"); // the container a sleep replaces has none
    last = Date.now() - 14 * 60_000;
    assertEquals(
      await line(),
      "sandbox: restarted since the last call, 14m ago — its background jobs and files are " +
        "gone; it stops 10 min after a call",
    );
  } finally {
    await Deno.remove(workspace, { recursive: true });
  }
});

Deno.test("clocked: a call the gateway answered stamps the clock, a refused one does not", async () => {
  let refuse = false;
  const gateway = clocked({
    ...localGateway(),
    exec: () =>
      refuse
        ? Promise.reject(new Error("sandbox gateway: exec answered 502"))
        : Promise.resolve({ stdout: "", stderr: "", code: 0 }),
  });
  assertEquals(gateway.lastCall(), undefined);
  const before = Date.now();
  await gateway.exec("true");
  const stamped = gateway.lastCall()!;
  assert(stamped >= before);
  refuse = true;
  await assertRejects(() => gateway.exec("true"), Error, "502");
  assertEquals(gateway.lastCall(), stamped);
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
