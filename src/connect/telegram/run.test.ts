import { assertEquals } from "@std/assert";
import { owedHistory } from "./run.ts";
import type { Event } from "../../types.ts";
import type { Reader } from "../../store/log.ts";

/** A log whose newest grant note for the account is dated `at`, or none. */
const notes = (at?: string): Reader["read"] =>
  ((q: { senders?: string[] }) =>
    Promise.resolve(
      at && q?.senders?.includes("telegram-connect") ? [{ ts: at } as Event] : [],
    )) as Reader["read"];

Deno.test("telegram run: an opening owes the history of a sign-in whose history is not in", async () => {
  const dir = await Deno.makeTempDir();
  const marker = `${dir}/700100.history`;
  try {
    // no sign-in on record: a resumed session
    assertEquals(await owedHistory(notes(), "700100", marker), undefined);
    // a sign-in, and no history in yet
    assertEquals(
      await owedHistory(notes("2026-11-14T10:00:00.000Z"), "700100", marker),
      "2026-11-14T10:00:00.000Z",
    );
    // its history in: a restart owes nothing
    await Deno.writeTextFile(marker, "2026-11-14T10:00:00.000Z");
    assertEquals(await owedHistory(notes("2026-11-14T10:00:00.000Z"), "700100", marker), undefined);
    // a new sign-in owes its own
    assertEquals(
      await owedHistory(notes("2026-11-15T09:00:00.000Z"), "700100", marker),
      "2026-11-15T09:00:00.000Z",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
