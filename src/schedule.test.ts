/**
 * schedule: the operator's door to the timers table (§10). The flags are the whole of it —
 * a handle, one way of saying when, and the note — and a handle armed twice is one row.
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { parseScheduleArgs } from "./schedule.ts";

const BASE = ["--name", "sonar-digest", "--cron", "*/15 8-21 * * 1-5"];

Deno.test("parseScheduleArgs: a handle, a when, and the note the agent reads", () => {
  assertEquals(parseScheduleArgs([...BASE, "pull", "the", "sonar", "digest"]), {
    name: "sonar-digest",
    cron: "*/15 8-21 * * 1-5",
    note: "pull the sonar digest",
  });
  assertEquals(parseScheduleArgs(["--name", "x", "--in", "3h", "--agent", "ana", "look"]), {
    name: "x",
    in: "3h",
    agent: "ana",
    note: "look",
  });
  assertEquals(parseScheduleArgs(["--cancel", "sonar-digest"]), {
    cancel: "sonar-digest",
    note: "",
  });
});

Deno.test("parseScheduleArgs: refuses a wake nobody could re-arm or read", () => {
  const bad = (argv: string[], word: string) => {
    const err = assertThrows(() => parseScheduleArgs(argv), Error);
    assert(err.message.includes(word), `${err.message} should mention ${word}`);
  };
  bad(["--cron", "0 9 * * *", "look"], "--name is required");
  bad(["--name", "Sonar", "--in", "3h", "look"], "lowercase");
  bad(BASE, "a note is required");
  bad(["--name", "x", "--cancel", "x"], "--cancel takes a handle");
  bad(["--cancel", "x", "look"], "the note");
  bad([...BASE, "--nope", "look"], "unknown flag");
  bad(["--name"], "needs a value");
});

Deno.test("parseScheduleArgs: when is left to fireAtOf — this door only collects it", () => {
  // no `when` at all parses; the refusal is the shared reading's, in the shared words
  assertEquals(parseScheduleArgs(["--name", "x", "look"]), { name: "x", note: "look" });
  assertEquals(
    parseScheduleArgs(["--name", "x", "--at", "2026-09-01T17:00", "look"]).at,
    "2026-09-01T17:00",
  );
});
