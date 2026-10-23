import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { type ExecGround, installExecGround } from "./bash.ts";
import { type BubbleOptions, mountOf, openBubble, partialToolHomes } from "./bubble.ts";

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
  ground: () => Promise<ExecGround>;
}

/** An org's folder, and a1's ground on it, in bubbles. */
async function withOrg(
  fn: (o: Org) => Promise<void>,
  opts: Partial<Pick<BubbleOptions, "mounts">> = {},
): Promise<void> {
  const org = await Deno.realPath(await Deno.makeTempDir());
  const dir = `${org}/data`;
  await Deno.writeTextFile(`${org}/config.jsonc`, "{}\n");
  await Deno.writeTextFile(`${org}/.env`, "ANTHROPIC_API_KEY=sk-secret");
  await Deno.mkdir(`${dir}/log`, { recursive: true });
  const ground = () =>
    installExecGround(
      dir,
      "a1",
      undefined,
      undefined,
      () => openBubble({ dir, agentId: "a1", ...opts }),
    );
  try {
    await fn({ org, dir, ground });
  } finally {
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
  opts: Partial<Pick<BubbleOptions, "mounts">> = {},
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
  }, opts);
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
  name: "bubble: the network is the machine's — its loopback answers, and the bubble's own server",
  ignore: !hasBwrap,
  fn: () =>
    withBubble(async ({ run, dir }) => {
      // a server on this machine's loopback, reached from inside
      const outside = Deno.listen({ hostname: "127.0.0.1", port: 0 });
      const port = (outside.addr as Deno.NetAddr).port;
      const answering = (async () => {
        const c = await outside.accept();
        await c.write(new TextEncoder().encode("hi"));
        c.close();
      })();
      try {
        assertEquals(await run(`exec 3<>/dev/tcp/127.0.0.1/${port}; head -c 2 <&3`), "hi");
      } finally {
        outside.close();
        await answering.catch(() => {});
      }
      // a server the agent runs, reached from outside
      await run(
        `deno eval 'const l = Deno.listen({ hostname: "127.0.0.1", port: 0 }); ` +
          `console.log((l.addr as Deno.NetAddr).port); ` +
          `const c = await l.accept(); await c.write(new TextEncoder().encode("mine"))' ` +
          "> port.txt &",
      );
      let theirs = 0;
      for (let i = 0; i < 100 && !theirs; i++) {
        await new Promise((r) => setTimeout(r, 100));
        theirs = Number(await Deno.readTextFile(`${dir}/agents/a1/port.txt`).catch(() => ""));
      }
      assert(theirs, "the agent's server never said its port");
      const c = await Deno.connect({ hostname: "127.0.0.1", port: theirs });
      const buf = new Uint8Array(4);
      await c.read(buf);
      c.close();
      assertEquals(new TextDecoder().decode(buf), "mine");
    }),
});

Deno.test({
  name: "bubble: the org's mounts show read-only, and none may touch the org's folder",
  ignore: !hasBwrap,
  fn: async () => {
    const tools = await Deno.realPath(await Deno.makeTempDir());
    const repo = await Deno.realPath(await Deno.makeTempDir());
    await Deno.writeTextFile(`${tools}/lib.txt`, "beside the bin");
    try {
      await withBubble(async ({ run }) => {
        assertEquals(await run(`cat ${tools}/lib.txt`), "beside the bin");
        assertEquals(await run(`touch ${tools}/x 2>/dev/null || echo refused`), "refused");
        assertEquals(await run(`echo ok > ${repo}/x && cat ${repo}/x`), "ok");
      }, { mounts: [tools, `${repo}:rw`] });
      await withOrg(async ({ org, dir }) => {
        const open = (mounts: string[]) => openBubble({ dir, agentId: "a1", mounts });
        await assertRejects(() => open([org]), Error, "holds the org's folder");
        await assertRejects(() => open([`${org}/connectors`]), Error, "lies in the org's folder");
        await assertRejects(() => open([`${org}:rw`]), Error, "holds the org's folder");
      });
    } finally {
      await Deno.remove(tools, { recursive: true });
      await Deno.remove(repo, { recursive: true });
    }
  },
});

Deno.test("mountOf: a path, read-only unless it ends in :rw", () => {
  const was = Deno.env.get("HOME");
  try {
    Deno.env.set("HOME", "/home/u");
    assertEquals(mountOf("~/.nvm"), { path: "/home/u/.nvm", mode: "ro" });
    assertEquals(mountOf("/srv/repo:rw"), { path: "/srv/repo", mode: "rw" });
  } finally {
    was === undefined ? Deno.env.delete("HOME") : Deno.env.set("HOME", was);
  }
});

Deno.test("partialToolHomes: a tool folder PATH reaches into, until a mount shows it whole", () => {
  const was = { HOME: Deno.env.get("HOME"), PATH: Deno.env.get("PATH") };
  try {
    Deno.env.set("HOME", "/home/u/");
    Deno.env.set("PATH", "/home/u/.local/share/mise/installs/python/3.12/bin:/usr/bin");
    assertEquals(partialToolHomes([]), ["~/.local/share/mise"]);
    assertEquals(partialToolHomes(["~/.local/share/mise"]), []);
    assertEquals(partialToolHomes(["/home/u/.local/share"]), []);
    assertEquals(partialToolHomes(["~/.local/share/mise/installs"]), ["~/.local/share/mise"]);
    assertEquals(partialToolHomes(["~/.local/share/mise:rw"]), []);
  } finally {
    for (const [k, v] of Object.entries(was)) {
      v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
    }
  }
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
