import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { reload } from "./reload.ts";
import { claim, RELOAD, SUPERVISOR } from "./stop.ts";
import { materialize, starterConfig } from "./config.ts";

async function org(): Promise<string> {
  const root = await Deno.makeTempDir();
  await Deno.writeTextFile(`${root}/config.jsonc`, materialize(starterConfig()));
  return root;
}

Deno.test("reload: the run holding the supervisor's role is signalled; no run, nothing is", async () => {
  const root = await org();
  let heard = 0;
  const listener = () => heard++;
  Deno.addSignalListener(RELOAD, listener);
  try {
    assertEquals(await reload(root), null);
    const lock = claim(`${root}/data`, SUPERVISOR);
    try {
      assertEquals(await reload(root), Deno.pid);
      for (let i = 0; i < 50 && heard === 0; i++) await new Promise((r) => setTimeout(r, 10));
      assertEquals(heard, 1);
    } finally {
      if ("held" in lock) lock.held.close();
    }
  } finally {
    Deno.removeSignalListener(RELOAD, listener);
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("reload: a file boot would reject is the command's refusal, and the run is left alone", async () => {
  const root = await org();
  let heard = 0;
  const listener = () => heard++;
  Deno.addSignalListener(RELOAD, listener);
  const lock = claim(`${root}/data`, SUPERVISOR);
  try {
    await Deno.writeTextFile(`${root}/config.jsonc`, `{ "sytem": {} }`);
    const err = await assertRejects(() => reload(root));
    assertStringIncludes((err as Error).message, `unknown section "sytem"`);
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(heard, 0);
  } finally {
    if ("held" in lock) lock.held.close();
    Deno.removeSignalListener(RELOAD, listener);
    await Deno.remove(root, { recursive: true });
  }
});
