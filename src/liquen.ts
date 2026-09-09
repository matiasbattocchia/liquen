/**
 * liquen.ts — the `liquen` command: the org's `deno task`, said from anywhere inside it.
 *
 *   deno install -g -A -n liquen jsr:@liquen/liquen/liquen
 *
 *   liquen                      lists the org's tasks
 *   liquen <task> [args…]       runs one — `liquen start`, `liquen agent ana`
 *   liquen --dir <org> <task>   from outside the org
 *
 * The command holds no behaviour of its own: it finds the org (config.jsonc, upward from
 * the cwd) and runs `deno task` there, so the package that runs is the one the org's
 * deno.jsonc pins — whatever version this command was installed at, whenever. The org
 * itself is made without it: `deno run -A jsr:@liquen/liquen/init <path>`.
 *
 * The child owns the terminal: stdin, stdout and stderr are inherited, a Ctrl-C reaches
 * it through the tty and this process only waits, and a SIGTERM is passed along. Its
 * exit code is this command's.
 */

import { findRoot, orgFlag } from "./config.ts";

if (import.meta.main) {
  const org = orgFlag();
  let root: string;
  try {
    root = findRoot(org);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    Deno.exit(2);
  }
  const child = new Deno.Command(Deno.execPath(), {
    args: ["task", "--cwd", root, ...org.args],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  Deno.addSignalListener("SIGINT", () => {});
  Deno.addSignalListener("SIGTERM", () => child.kill("SIGTERM"));
  Deno.exit((await child.status).code);
}
