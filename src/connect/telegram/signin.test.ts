import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createTelegramSignIn } from "./signin.ts";
import type { SignInOptions } from "./client.ts";
import type { TgPeer } from "./wire.ts";
import { APP_KEY } from "./config.ts";
import { door, fakeGate, pageCtx, ticket } from "../testing.ts";

const ANA: TgPeer = {
  id: "777",
  kind: "user",
  name: "Ana",
  username: "ana",
  phone: "5492610000002",
};

/** Telegram as the library meets it: the code is 11111, and the password is asked when
 *  the account has one; a wrong one is said, then asked again. */
function telegram(opts: { password?: string; fail?: string } = {}) {
  const phones: string[] = [];
  const signIn = async (o: SignInOptions): Promise<{ session: string; self: TgPeer }> => {
    phones.push(o.phone ?? "");
    if (opts.fail) throw new Error(opts.fail);
    o.sent?.();
    while ((await o.code()) !== "11111") o.invalid?.("code");
    if (opts.password) {
      while ((await o.password()) !== opts.password) o.invalid?.("password");
    }
    return { session: "SESSION", self: ANA };
  };
  return { signIn, phones };
}

function ctxWithApp() {
  const made = pageCtx([{ agentId: "ana", phone: "+54 9 261 000-0002" }]);
  made.vault.set(APP_KEY, { key: APP_KEY, value: { api_id: "1", api_hash: "hash" } });
  return made;
}

Deno.test("Telegram page: the number, the code (a wrong one asked again), the password, and the account lands by the CLI's path", async () => {
  const { ctx, vault, connections } = ctxWithApp();
  const t = ticket("t1", {
    service: "telegram",
    agentId: "ana",
    extra: { hint: "+5492610000002" },
  });
  const gate = fakeGate([t]);
  const tg = telegram({ password: "hunter2" });
  const page = door(createTelegramSignIn({ signIn: tg.signIn }), ctx, gate);

  const first = await (await page.get("t1")).text();
  assertStringIncludes(first, "ana&#39;s Telegram account");
  assertStringIncludes(first, `value="+5492610000002"`);

  const code = await page.post("t1", { phone: "+5492610000002" });
  assertStringIncludes(await code.text(), `autocomplete="one-time-code"`);
  assertEquals(tg.phones, ["+5492610000002"]);

  const wrong = await page.post("t1", { code: "22222" });
  assertStringIncludes(await wrong.text(), "That code was wrong: try again.");
  const password = await page.post("t1", { code: "11111" });
  assertStringIncludes(await password.text(), "two-step verification password");
  const wrongPassword = await page.post("t1", { password: "nope" });
  assertStringIncludes(await wrongPassword.text(), "That password was wrong");

  const done = await page.post("t1", { password: "hunter2" });
  assertStringIncludes(await done.text(), "Telegram @ana is connected.");
  assertEquals(gate.seen.judged, [{
    ticket: "t1",
    who: { address: "777", phone: "5492610000002" },
  }]);
  assertEquals(gate.seen.landed, [{ ticket: "t1", account: "777" }]);
  assertEquals(vault.get("telegram:777")?.value, { session: "SESSION" });
  assertEquals(connections[0].agentId, "ana");
});

Deno.test("Telegram page: a failure before anyone is judged asks for the number again, the ticket open", async () => {
  const { ctx } = ctxWithApp();
  const gate = fakeGate([ticket("t1", { service: "telegram", agentId: "ana" })]);
  const page = door(
    createTelegramSignIn({ signIn: telegram({ fail: "PHONE_NUMBER_INVALID" }).signIn }),
    ctx,
    gate,
  );
  const res = await page.post("t1", { phone: "+1 555" });
  assertEquals(res.status, 400);
  const body = await res.text();
  assertStringIncludes(body, "Telegram said: PHONE_NUMBER_INVALID. Try again.");
  assertStringIncludes(body, `autocomplete="tel"`);
  assertEquals(gate.seen.failed, []);
  assertEquals((await gate.view("t1"))?.ticket, "t1");
  // a code with no sign-in waiting on it asks for the number
  const stray = await page.post("t1", { code: "11111" });
  assertStringIncludes(await stray.text(), "That step is over: give the number again.");
});

Deno.test("Telegram flow: it refuses without the app, and fills the number from the row", async () => {
  const flow = createTelegramSignIn();
  const bare = pageCtx([{ agentId: "ana", phone: "+5492610000002" }]);
  await assertRejects(
    () => flow.prepare({ service: "telegram", agent: "ana" }, bare.ctx),
    Error,
    "`liquen connect telegram app`",
  );
  const { ctx } = ctxWithApp();
  assertEquals(await flow.prepare({ service: "telegram", agent: "ana" }, ctx), {
    hint: "+54 9 261 000-0002",
  });
  // a grant for another is filled with the phone it must match
  assertEquals(
    await flow.prepare({ service: "telegram", agent: "ana", phone: "+5492610000002" }, ctx),
    { hint: "+5492610000002" },
  );
});
