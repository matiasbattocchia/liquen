import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type ExecGround, installExecGround } from "./bash.ts";
import { openBubble } from "./bubble.ts";

const live = () => new AbortController().signal;

const hasBwrap = (() => {
  try {
    return new Deno.Command("bwrap", { args: ["--version"], stdout: "null", stderr: "null" })
      .outputSync().success;
  } catch {
    return false;
  }
})();

/** The bubble's way out answers a CONNECT the way the egress proxy does, and says who asked. */
const PORT = 18_080;

async function withBubble(
  fn: (t: {
    run: (command: string) => Promise<string>;
    org: string;
    dir: string;
    shell: ReturnType<ExecGround["shell"]>;
  }) => Promise<void>,
): Promise<void> {
  // an org's folder: its declaration and its secrets beside the data root
  const org = await Deno.realPath(await Deno.makeTempDir());
  const dir = `${org}/data`;
  await Deno.writeTextFile(`${org}/config.jsonc`, "{}\n");
  await Deno.writeTextFile(`${org}/.env`, "ANTHROPIC_API_KEY=sk-secret");
  await Deno.mkdir(`${dir}/log`, { recursive: true });
  const socket = `${dir}/log/egress.sock`;
  const proxy = Deno.listen({ transport: "unix", path: socket });
  // the proxy's side of a tunnel: it reads the CONNECT head, answers, and holds the line
  // until the client lets go
  const tunnel = async (conn: Deno.Conn) => {
    const buf = new Uint8Array(1024);
    let head = "";
    while (!head.includes("\r\n\r\n")) {
      const n = await conn.read(buf);
      if (n === null) return conn.close();
      head += new TextDecoder().decode(buf.subarray(0, n));
    }
    await conn.write(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"));
    while (await conn.read(buf) !== null) { /* the tunnel's bytes: nobody to carry them */ }
    conn.close();
  };
  const serving = (async () => {
    for await (const conn of proxy) tunnel(conn).catch(() => {});
  })();
  const ground = await installExecGround(
    dir,
    "a1",
    undefined,
    undefined,
    () => openBubble({ dir, agentId: "a1", socket, port: PORT }),
  );
  const shell = ground.shell();
  try {
    const run = async (command: string) => {
      const answer = await shell.exec.bash.execute({ command }, live());
      return typeof answer === "object" && answer !== null && "output" in answer
        ? String(answer.output)
        : String(answer);
    };
    await fn({ run, org, dir, shell });
  } finally {
    await shell.reap();
    await ground.close("end");
    proxy.close();
    await serving.catch(() => {});
    await Deno.remove(org, { recursive: true });
  }
}

Deno.test({
  name: "bubble: the shell sees its folder, the shared floor and the system — and no more",
  ignore: !hasBwrap,
  fn: () =>
    withBubble(async ({ run, dir }) => {
      const home = `${dir}/agents/a1`;
      await Deno.mkdir(`${dir}/agents/a2`, { recursive: true });
      await Deno.writeTextFile(`${dir}/agents/a2/note.md`, "a peer's");
      await Deno.writeTextFile(`${dir}/log/log.db`, "the substrate");
      assertEquals(await run("pwd"), home);
      assertEquals(await run("echo $HOME"), home);
      assertEquals(await run("echo mine > note.md && cat note.md"), "mine");
      assertEquals(await run(`echo ours > ${dir}/shared/x && cat ${dir}/shared/x`), "ours");
      assertEquals(await run(`touch ${dir}/system/x 2>/dev/null || echo refused`), "refused");
      assertEquals(await run(`test -e ${dir}/agents/a2 || echo absent`), "absent");
      assertEquals(await run(`test -e ${dir}/log || echo absent`), "absent");
      // the harness and its peers are not in the shell's process table
      assertEquals(await run(`test -e /proc/${Deno.pid} || echo absent`), "absent");
    }),
});

Deno.test({
  name: "bubble: the network is the egress proxy and nothing else",
  ignore: !hasBwrap,
  fn: () =>
    withBubble(async ({ run }) => {
      const answer = await run(
        `exec 3<>/dev/tcp/127.0.0.1/${PORT}; printf 'CONNECT example.com:443 HTTP/1.1\\r\\n\\r\\n' >&3; head -1 <&3`,
      );
      assertStringIncludes(answer, "200 Connection Established");
      // no route anywhere else: no resolver, no interface but loopback
      await assertRejects(() => run("exec 3<>/dev/tcp/1.1.1.1/443"), Error);
      assertEquals(
        await run(
          "ls /sys/class/net 2>/dev/null || cat /proc/net/dev | tail -n +3 | cut -d: -f1 | tr -d ' '",
        ),
        "lo",
      );
    }),
});

Deno.test({
  name: "bubble: a job outlives its call, in the bubble, and is reaped by its group",
  ignore: !hasBwrap,
  fn: () =>
    withBubble(async ({ run, shell }) => {
      const said = await run("sleep 300 & echo started");
      assertStringIncludes(said, "started");
      assertStringIncludes(said, "left running as group");
      const group = Number(said.match(/as group (\d+)/)![1]);
      assert((await shell.ambient()).some((l) => l.includes("sleep 300")));
      await shell.reap();
      await new Promise((r) => setTimeout(r, 200));
      let alive = true;
      try {
        Deno.kill(-group, "SIGWINCH");
      } catch {
        alive = false;
      }
      assert(!alive, "the group outlived the reap");
    }),
});

Deno.test({
  name: "bubble: standing in the org's folder shows its code, never its state or its .env",
  ignore: !hasBwrap,
  fn: () =>
    withBubble(async ({ run, org, dir, shell }) => {
      await Deno.mkdir(`${dir}/agents/a2`, { recursive: true });
      await Deno.writeTextFile(`${dir}/log/log.db`, "the substrate");
      await shell.stand(org);
      assertEquals(await run("pwd"), org);
      assertEquals(
        await run("cat config.jsonc && echo '{ }' > config.jsonc && cat config.jsonc"),
        "{}\n{ }",
      );
      assertEquals(await run("cat .env 2>/dev/null || echo refused"), "refused");
      assertEquals(await run("test -e data/log || echo absent"), "absent");
      assertEquals(await run("test -e data/agents/a2 || echo absent"), "absent");
      assertEquals(await run("ls data/agents"), "a1");
      // the session's next bubble is the agent's own again
      await shell.stand();
      assertEquals(await run("pwd"), `${dir}/agents/a1`);
    }),
});

Deno.test({
  name: "bubble: a stand the bubble cannot hold is refused at the stand",
  ignore: !hasBwrap,
  fn: () =>
    withBubble(async ({ run, shell }) => {
      await assertRejects(() => shell.stand("/nowhere/at/all"), Error, "cannot stand there");
      await assertRejects(() => shell.stand("/"), Error, "root of the filesystem");
      // the shell never moved
      assertEquals(await run("pwd"), String(await run("echo $HOME")));
    }),
});
