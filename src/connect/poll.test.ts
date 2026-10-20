import { assertEquals } from "@std/assert";
import { unreached } from "./poll.ts";
import { said } from "./http.ts";
import { SignedOut } from "./errors.ts";

Deno.test("unreached: only the wire not being there counts toward a wedge — any answer is the wire there", async () => {
  // what the runtime says of a request that went nowhere
  assertEquals(unreached(new TypeError("fetch failed")), true);
  assertEquals(unreached(new DOMException("timed out", "TimeoutError")), true);
  // the same, said as a sentence
  const nowhere = said(() => Promise.reject(new TypeError("fetch failed")), 1_000);
  const err = await nowhere("https://graph.microsoft.com/v1.0/me").catch((e) => e);
  assertEquals(unreached(err), true);
  // answers: an HTTP refusal a poll threw, an issuer ending the grant
  assertEquals(unreached(new Error("calendar delta 404: MailboxNotEnabledForRESTAPI")), false);
  assertEquals(unreached(new SignedOut("invalid_grant")), false);
});
