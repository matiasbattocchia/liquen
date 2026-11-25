import { assertEquals } from "@std/assert";
import { openLog } from "./store/log.ts";
import type { DocEntry, Where } from "./store/docs.ts";
import type { Draft, MessageEvent } from "./types.ts";
import { nameKey, oneParty, withWorn, WORN_SHOWN } from "./worn.ts";

function line(room: string, roomName: string, sender: string, name: string): Draft<MessageEvent> {
  return {
    ts: new Date().toISOString(),
    type: "message",
    envelope: {
      service: "whatsapp",
      connection_address: "5491100000000",
      conversation: {
        address: room,
        kind: room.endsWith("@g.us") ? "group" : "direct",
        name: roomName,
      },
      sender: { address: sender, name },
    },
    parts: [{ type: "text", kind: "text", text: "hola" }],
  };
}

function profile(
  name: string,
  conversations: Where[],
  fields: { keywords?: string[]; description?: string } = {},
): DocEntry {
  return {
    header: {
      scope: "agent",
      kind: "memory",
      name,
      load: "conditional",
      conversations,
      ...fields,
      handle: `/org/data/agents/a1/${name}.md`,
    },
  };
}

const wa = (address: string): Where => ({ service: "whatsapp", address });

async function withLog(fn: (log: Awaited<ReturnType<typeof openLog>>) => Promise<void>) {
  const dir = await Deno.makeTempDir();
  const log = await openLog(dir);
  await log.upsertConnections([{ service: "whatsapp", address: "5491100000000" }]);
  try {
    await fn(log);
  } finally {
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("a name's comparable form is its words, folded: case, accents and decoration aside", () => {
  assertEquals(nameKey("🇦🇷 Lautaro Motta"), "lautaro motta");
  assertEquals(nameKey("::: LEO V :::"), "leo v");
  assertEquals(nameKey("Álvaro"), "alvaro");
  assertEquals(nameKey("."), "");
});

Deno.test("a doc about one party has at most one address per service", () => {
  assertEquals(oneParty([wa("1"), { service: "instagram", address: "lucas" }]), true);
  assertEquals(oneParty([wa("1"), wa("2")]), false); // a matter: its names are its members'
  assertEquals(oneParty(undefined), false);
});

Deno.test("worn: each name once, first worn first, minus what the doc says and what is no name", async () => {
  await withLog(async (log) => {
    // the room's name and the sender's, each worn many times and spelled several ways
    await log.publish(line("549261", "Lucas Manu", "549261", "Lucas Fallet La Rocca"));
    await log.publish(line("549261", "Lucas Manu", "549261", "LUCAS FALLET LA ROCCA"));
    await log.publish(line("549261", "Lucas Manu", "549261", "Batto"));
    await log.publish(line("549261", "Lucas Manu", "549261", "Lucas Fallet La Rocca"));
    await log.publish(line("549261", "Lucas Manu", "549261", "."));
    await log.publish(line("549261", "Lucas Manu", "549261", "+54 9 261"));
    // in a group he goes by another name still; the group's own name is not his
    await log.publish(line("1203@g.us", "Abogados", "549261", "Lucas F."));
    // the matter doc's two people, and a person nobody profiled
    await log.publish(line("549262", "Megavalo", "549262", "Osvaldo Herrera"));

    const docs = [
      profile("lucas", [wa("549261")], { keywords: ["Lucas Manu"], description: "Lucas, abogado" }),
      profile("megavalo", [wa("549262")], { description: "Megavalo (Osvaldo Herrera), amigo" }),
      profile("venta", [wa("549261"), wa("549262")]),
    ];
    const out = await withWorn(docs, log);
    // the keyword's name and the description's are said; a dot and a number are no name
    assertEquals(out[0].names, ["Lucas Fallet La Rocca", "Batto", "Lucas F."]);
    assertEquals(out[1].names, undefined);
    assertEquals(out[2].names, undefined); // two addresses on one service: a matter
  });
});

Deno.test("worn: a later step reads only the new rows, and a new name joins at the end", async () => {
  await withLog(async (log) => {
    await log.publish(line("549263", "Papá", "549263", "claudio dario Battocchia"));
    await log.publish(line("549263", "Papá", "549263", "Claudio"));
    const docs = [profile("papa", [wa("549263")], { keywords: ["Papá"] })];
    assertEquals((await withWorn(docs, log))[0].names, ["claudio dario Battocchia", "Claudio"]);

    // an old name worn again moves nothing; a new one comes last, so the prefix holds still
    await log.publish(line("549263", "Papá", "549263", "Claudio"));
    await log.publish(line("549263", "Papá", "549263", "Claudio Darío B."));
    assertEquals((await withWorn(docs, log))[0].names, [
      "claudio dario Battocchia",
      "Claudio",
      "Claudio Darío B.",
    ]);

    // a profile made later reads its address's whole history the first time it is asked for
    await log.publish(line("549264", "Huevo", "549264", "Luciano Putignano"));
    const more = [...docs, profile("luciano", [wa("549264")], { keywords: ["Luciano Putignano"] })];
    assertEquals((await withWorn(more, log))[1].names, ["Huevo"]);
  });
});

Deno.test("worn: at most WORN_SHOWN names, the first worn", async () => {
  await withLog(async (log) => {
    for (let i = 0; i < WORN_SHOWN + 2; i++) {
      await log.publish(line("549265", "Ana", "549265", `Ana ${String.fromCharCode(97 + i)}`));
    }
    const [ana] = await withWorn([profile("ana", [wa("549265")], { keywords: ["Ana"] })], log);
    assertEquals(ana.names, ["Ana a", "Ana b", "Ana c", "Ana d", "Ana e"]);
  });
});
