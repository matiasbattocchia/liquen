import { assertEquals } from "@std/assert";
import { listening } from "./stop.ts";

Deno.test("listening: the named ingests start in the table's order, the rest are said once", async () => {
  const started: string[] = [];
  const said: string[] = [];
  const ingest = (name: string) => () => {
    started.push(name);
    return Promise.resolve(() => Promise.resolve());
  };
  const error = console.error;
  console.error = (line: string) => said.push(line);
  try {
    const stops = await listening("microsoft", ["teams", "calendar"], {
      calendar: ingest("calendar"),
      mail: ingest("mail"),
      teams: ingest("teams"),
    });
    assertEquals(stops.length, 2);
  } finally {
    console.error = error;
  }
  assertEquals(started, ["calendar", "teams"]);
  assertEquals(said, [
    "[ingest] microsoft mail: not listened (connections.microsoft.listen) — nothing of it reaches the log",
  ]);
});
