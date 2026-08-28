import { assert, assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { bashTool, installExecPlane, type Job } from "./bash.ts";

const live = () => new AbortController().signal;

/** Where a plane lands an agent: its own folder under `agents/` — the cwd IS the tree. */
const wsOf = (dir: string) => `${dir}/agents/a1`;

async function withPlane(
  fn: (t: {
    run: (command: string, timeout?: number) => Promise<string>;
    dir: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const { exec, reap } = await installExecPlane(dir, "a1");
  try {
    const run = async (command: string, timeout?: number) =>
      String(await exec.bash.execute({ command, ...(timeout ? { timeout } : {}) }, live()));
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
    const bash = bashTool({ workspace: dir, env: () => ({ GOOGLE_WORKSPACE_CLI_TOKEN: handle }) });
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

Deno.test("bash: timeout kills and reports", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/workspace`, { recursive: true });
    const bash = bashTool({ workspace: `${dir}/workspace`, defaultTimeoutMs: 300 });
    const err = await assertRejects(
      () => bash.execute({ command: "echo started; sleep 10" }, live()),
      Error,
    );
    assertStringIncludes(err.message, "started");
    assertStringIncludes(err.message, "timed out");
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

Deno.test("bash: cwd persists between calls (sticky), env does not", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/workspace/sub`, { recursive: true });
    const bash = bashTool({ workspace: `${dir}/workspace` });
    const home = await Deno.realPath(`${dir}/workspace`);
    assertEquals(String(await bash.execute({ command: "pwd" }, live())), home);
    await bash.execute({ command: "cd sub" }, live()); // cd sticks
    assertEquals(String(await bash.execute({ command: "pwd" }, live())), `${home}/sub`);
    // env does NOT persist (fresh subprocess each call)
    await bash.execute({ command: "export FOO=bar" }, live());
    assertEquals(String(await bash.execute({ command: "echo ${FOO:-unset}" }, live())), "unset");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("bash: the sentinel never leaks into output, and real exit codes survive it", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/workspace`, { recursive: true });
    const bash = bashTool({ workspace: `${dir}/workspace` });
    const out = String(await bash.execute({ command: "echo hello" }, live()));
    assertEquals(out, "hello"); // no __MU_CWD__ tail
    // a non-zero exit is still an error even though a print was appended after it
    const err = await assertRejects(
      () => bash.execute({ command: "echo oops; exit 5" }, live()),
      Error,
    );
    assertStringIncludes(err.message, "exited with code 5");
    assertStringIncludes(err.message, "oops");
    assert(!err.message.includes("__MU_CWD__"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const pgrepCount = (pattern: string): number => {
  const out = new Deno.Command("pgrep", { args: ["-fc", pattern] }).outputSync();
  return Number(new TextDecoder().decode(out.stdout).trim() || "0");
};

Deno.test("bash: a backgrounded job returns immediately (pipe not held open)", async () => {
  const dir = await Deno.makeTempDir();
  const marker = `mu_bg_${crypto.randomUUID().slice(0, 8)}`;
  try {
    await Deno.mkdir(`${dir}/workspace`, { recursive: true });
    const jobs = new Set<Job>();
    const bash = bashTool({ workspace: `${dir}/workspace`, defaultTimeoutMs: 30_000, jobs });
    const t0 = Date.now();
    // a long sleeper (uniquely named via exec -a) that would hold the pipe unless we cut it
    const out = String(
      await bash.execute({ command: `echo launched; exec -a ${marker} sleep 30 &` }, live()),
    );
    const ms = Date.now() - t0;
    assertStringIncludes(out, "launched");
    assert(ms < 5000, `backgrounded call took ${ms}ms — pipe held open`);
  } finally {
    new Deno.Command("pkill", { args: ["-f", marker] }).outputSync();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exec plane: reap() kills background jobs the agent left running (no orphans)", async () => {
  const dir = await Deno.makeTempDir();
  const { exec, reap } = await installExecPlane(dir, "a1");
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

Deno.test("exec plane: ambient() reports cwd, git, and live background jobs", async () => {
  const dir = await Deno.makeTempDir();
  const { exec, ambient, reap } = await installExecPlane(dir, "a1");
  const marker = `mu_amb_${crypto.randomUUID().slice(0, 8)}`;
  try {
    // cwd only, no repo, no jobs
    let lines = await ambient();
    assert(lines[0].startsWith("cwd: "));
    assert(lines.every((l) => !l.startsWith("git:")), "no git line outside a repo");
    assert(lines.every((l) => !l.startsWith("background")), "no jobs yet");

    // make it a git repo → git line appears; cd sticks so ambient reflects it
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
    const jobLine = lines.find((l) => l.startsWith("background jobs (1)"));
    assert(jobLine, lines.join(" | "));
    assert(/\(pid \d+, /.test(jobLine!), `job line must carry a kill handle: ${jobLine}`);
    await reap();
    lines = await ambient();
    assert(lines.every((l) => !l.startsWith("background")), "reaped job gone from ambient");
  } finally {
    new Deno.Command("pkill", { args: ["-f", marker] }).outputSync();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("exec plane: aread on a bytes file returns an ExecOutcome — path peeled, no mojibake", async () => {
  const dir = await Deno.makeTempDir();
  const { exec, reap } = await installExecPlane(dir, "a1");
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
  const { exec, reap } = await installExecPlane(dir, "a1");
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
