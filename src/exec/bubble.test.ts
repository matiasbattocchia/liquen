import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { type ExecGround, installExecGround } from "./bash.ts";
import { EGRESS_SOCKET, openBubble } from "./bubble.ts";

const live = () => new AbortController().signal;

const hasBwrap = (() => {
  try {
    return new Deno.Command("bwrap", { args: ["--version"], stdout: "null", stderr: "null" })
      .outputSync().success;
  } catch {
    return false;
  }
})();

interface Org {
  org: string;
  dir: string;
  /** The authorities the bubble's connections asked the proxy for. */
  asked: string[];
  ground: () => Promise<ExecGround>;
}

/** An org's folder, and the egress proxy's side of a1's socket: it refuses what names
 *  `refused.example`, and otherwise answers 200 and echoes the tunnel's bytes. */
async function withOrg(fn: (o: Org) => Promise<void>): Promise<void> {
  const org = await Deno.realPath(await Deno.makeTempDir());
  const dir = `${org}/data`;
  await Deno.writeTextFile(`${org}/config.jsonc`, "{}\n");
  await Deno.writeTextFile(`${org}/.env`, "ANTHROPIC_API_KEY=sk-secret");
  const egress = `${dir}/log/egress/a1`;
  await Deno.mkdir(egress, { recursive: true });
  const proxy = Deno.listen({ transport: "unix", path: `${egress}/${EGRESS_SOCKET}` });
  const asked: string[] = [];
  const tunnel = async (conn: Deno.Conn) => {
    const buf = new Uint8Array(1024);
    let head = "";
    while (!head.includes("\r\n\r\n")) {
      const n = await conn.read(buf);
      if (n === null) return conn.close();
      head += new TextDecoder().decode(buf.subarray(0, n));
    }
    const authority = head.split(" ")[1];
    asked.push(authority);
    if (authority.startsWith("refused.example")) {
      await conn.write(new TextEncoder().encode("HTTP/1.1 403 refused here\r\n\r\n"));
      return conn.close();
    }
    await conn.write(new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n"));
    await conn.readable.pipeTo(conn.writable).catch(() => {});
  };
  const serving = (async () => {
    for await (const conn of proxy) tunnel(conn).catch(() => {});
  })();
  const ground = () =>
    installExecGround(
      dir,
      "a1",
      undefined,
      undefined,
      () => openBubble({ dir, agentId: "a1", egress }),
    );
  try {
    await fn({ org, dir, asked, ground });
  } finally {
    proxy.close();
    await serving.catch(() => {});
    await Deno.remove(org, { recursive: true });
  }
}

type Shell = ReturnType<ExecGround["shell"]>;

const runOn = (shell: Shell) => async (command: string) => {
  const answer = await shell.exec.bash.execute({ command }, live());
  return typeof answer === "object" && answer !== null && "output" in answer
    ? String(answer.output)
    : String(answer);
};

/** One ground and a shell on it, ended with its bubbles. */
async function withBubble(
  fn: (t: Org & { run: (command: string) => Promise<string>; shell: Shell }) => Promise<void>,
): Promise<void> {
  await withOrg(async (o) => {
    const ground = await o.ground();
    const shell = ground.shell();
    try {
      await fn({ ...o, run: runOn(shell), shell });
    } finally {
      await shell.reap();
      await ground.close("end");
    }
  });
}

const groupAlive = (pgid: number) => {
  try {
    Deno.kill(-pgid, "SIGWINCH");
    return true;
  } catch {
    return false;
  }
};

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
  name: "bubble: every connection reaches the egress proxy by name, whatever it speaks",
  ignore: !hasBwrap,
  fn: () =>
    withBubble(async ({ run, asked }) => {
      // the bubble's resolver gives a name an address of its own, the same each time
      const address = await run("getent ahostsv4 example.com | head -1 | cut -d' ' -f1");
      assertMatch(address, /^127\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/);
      assertEquals(await run("getent ahostsv4 example.com | head -1 | cut -d' ' -f1"), address);
      // a connection on any egress port is a CONNECT for the name and port, and carries
      // what the client says
      assertEquals(
        await run("exec 3<>/dev/tcp/example.com/22; printf 'SSH-2.0-x' >&3; head -c 9 <&3"),
        "SSH-2.0-x",
      );
      assertEquals(
        await run("exec 3<>/dev/tcp/example.com/443; printf hi >&3; head -c 2 <&3"),
        "hi",
      );
      assertEquals(asked, ["example.com:22", "example.com:443"]);
      // a refusal reaches the client as the proxy said it
      assertEquals(
        await run(
          "exec 3<>/dev/tcp/refused.example/80; printf 'GET / HTTP/1.0\\r\\n\\r\\n' >&3; " +
            "head -1 <&3 | tr -d '\\r'",
        ),
        "HTTP/1.1 403 refused here",
      );
      // no route anywhere else, no interface but loopback
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
  name: "bubble: an egress port on loopback is the agent's own to serve",
  ignore: !hasBwrap,
  fn: () =>
    withBubble(async ({ run }) => {
      await run("getent hosts example.com >/dev/null"); // a name held: its listeners up
      assertEquals(
        await run(
          `deno eval 'const l = Deno.listen({ hostname: "127.0.0.1", port: 5432 }); ` +
            `const c = await Deno.connect({ hostname: "127.0.0.1", port: 5432 }); ` +
            `await (await l.accept()).write(new TextEncoder().encode("mine")); ` +
            `const b = new Uint8Array(4); await c.read(b); console.log(new TextDecoder().decode(b))'`,
        ),
        "mine",
      );
    }),
});

Deno.test({
  name: "bubble: a job outlives its call, in the bubble, and is reaped by its group",
  ignore: !hasBwrap,
  fn: () =>
    withBubble(async ({ run, shell, dir }) => {
      const said = await run("sleep 300 & echo started");
      assertStringIncludes(said, "started");
      const group = Number(said.match(/as group (\d+)/)![1]);
      // the group the job's files keep is the one the harness sees
      const [pgid] = [...Deno.readDirSync(`${dir}/agents/a1/.out`)]
        .filter((e) => e.name.endsWith(".pgid"))
        .map((e) => Number(Deno.readTextFileSync(`${dir}/agents/a1/.out/${e.name}`).trim()));
      assertEquals(pgid, group);
      assert((await shell.ambient()).some((l) => l.includes("sleep 300")));
      await shell.reap();
      await new Promise((r) => setTimeout(r, 200));
      assert(!groupAlive(group), "the group outlived the reap");
    }),
});

Deno.test({
  name: "bubble: a harness that leaves hands its bubble and its jobs to the next",
  ignore: !hasBwrap,
  fn: () =>
    withOrg(async ({ ground, dir }) => {
      const first = await ground();
      const said = await runOn(first.shell())("touch /tmp/here; sleep 300 & echo started");
      const group = Number(said.match(/as group (\d+)/)![1]);
      await first.close("leave");
      const next = await ground();
      try {
        // the same bubble: its own /tmp, and the job still in it
        assertEquals(await runOn(next.shell())("test -e /tmp/here && echo here"), "here");
        assert(groupAlive(group));
      } finally {
        await next.close("end");
      }
      await new Promise((r) => setTimeout(r, 200));
      assert(!groupAlive(group), "the job outlived its bubble's end");
      assertEquals(
        [...Deno.readDirSync(`${dir}/log/bubbles/a1`)].filter((e) => e.name.endsWith(".json")),
        [],
      );
    }),
});

Deno.test({
  name: "bubble: one opened for another view stays while its job runs, beside a new one",
  ignore: !hasBwrap,
  fn: () =>
    withOrg(async ({ ground, dir }) => {
      const first = await ground();
      const said = await runOn(first.shell())("touch /tmp/here; sleep 300 & echo started");
      const group = Number(said.match(/as group (\d+)/)![1]);
      await first.close("leave");
      // as another version of the harness would have opened it
      const records = `${dir}/log/bubbles/a1`;
      for (const e of Deno.readDirSync(records)) {
        if (!e.name.endsWith(".json")) continue;
        const kept = JSON.parse(Deno.readTextFileSync(`${records}/${e.name}`));
        Deno.writeTextFileSync(`${records}/${e.name}`, JSON.stringify({ ...kept, view: "old" }));
      }
      const next = await ground();
      try {
        // a bubble of its own
        assertEquals(await runOn(next.shell())("test -e /tmp/here || echo absent"), "absent");
        assert(groupAlive(group)); // the old one still holds its job
      } finally {
        await next.close("end");
      }
      await new Promise((r) => setTimeout(r, 200));
      assert(!groupAlive(group), "the old bubble outlived the end");
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
