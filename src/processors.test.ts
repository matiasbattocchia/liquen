import { assert, assertEquals } from "@std/assert";
import { createTranscriber, transcribable } from "./processors.ts";
import { openLog } from "./store/log.ts";
import type { Draft, Event, MessageEvent } from "./types.ts";

/** A live org with the transcriber on a REAL log — the upsert idempotence is half the
 *  contract. The "model" is a shell one-liner over stdin, which is the whole interface. */
async function withTranscriber(
  command: string,
  fn: (t: {
    publish: (e: Draft<Event>) => Promise<Event>;
    transcripts: () => Promise<MessageEvent[]>;
    waitFor: (cond: () => boolean | Promise<boolean>, ms?: number) => Promise<void>;
    media: string; // a real .ogg on disk for FileParts to point at
  }) => Promise<void>,
  org: { locale?: string } = {},
): Promise<void> {
  const dir = await Deno.makeTempDir();
  const log = await openLog(`${dir}/log`);
  log.upsertConnections([{ service: "whatsapp", address: "549" }]);
  const media = `${dir}/note.ogg`;
  await Deno.writeTextFile(media, "not really ogg bytes");
  const errors: unknown[] = [];
  const stop = createTranscriber({
    subscribe: (l, o) => log.subscribe(l, o),
    publish: log.publish,
    command,
    ...org,
    onError: (_e, err) => errors.push(err),
  });
  const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 20_000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`waitFor timeout${errors.length ? ` (errors: ${errors.join("; ")})` : ""}`);
  };
  try {
    await new Promise((r) => setTimeout(r, 50)); // let the subscription arm
    await fn({
      publish: (e) => log.publish(e) as Promise<Event>,
      transcripts: async () =>
        (await log.read({ types: ["message"] }) as MessageEvent[])
          .filter((e) => e.payload?.action === "add"),
      waitFor,
      media,
    });
  } finally {
    stop();
    await log.close();
    await Deno.remove(dir, { recursive: true });
  }
}

const voiceNote = (
  media: string,
  over: Partial<{
    external_id: string;
    extra: Record<string, unknown>;
    payload: MessageEvent["payload"];
  }> = {},
): Draft<MessageEvent> => ({
  ts: new Date().toISOString(),
  type: "message",
  envelope: {
    service: "whatsapp",
    connection_address: "549",
    conversation: { address: "wa:sol", kind: "direct" },
    sender: { address: "5495", name: "sol" },
    external_id: over.external_id ?? "wa:note1",
  },
  parts: [{
    type: "file",
    kind: "audio",
    file: { mime_type: "audio/ogg", uri: `file://${media}`, name: "PTT.ogg" },
  }],
  ...(over.extra ? { extra: over.extra } : {}),
  ...(over.payload ? { payload: over.payload } : {}),
});

Deno.test("a voice note gets a transcript add-event; the sidecar caches the words", async () => {
  // the command reads stdin (the audio bytes) and answers words — the stdin→stdout contract
  await withTranscriber("wc -c > /dev/null && echo 'hola, ¿viste el set?'", async (t) => {
    const note = await t.publish(voiceNote(t.media));
    await t.waitFor(async () => (await t.transcripts()).length === 1);
    const [tr] = await t.transcripts();
    assertEquals(tr.parts, [{ type: "text", kind: "transcript", text: "hola, ¿viste el set?" }]);
    assertEquals(tr.payload?.ref_external_id, "wa:note1"); // → the audio message
    assertEquals(tr.envelope.external_id, "transcript:wa:note1"); // deterministic: exactly-once
    assertEquals(tr.envelope.conversation.address, note.envelope.conversation.address);
    assertEquals(tr.envelope.sender, undefined); // nobody spoke — the harness derived it
    assertEquals(tr.agent, undefined); // …which also keeps it off dispatch's predicate (§4)
    // the sidecar landed beside the media file: the durable text, and the work cache
    const sidecar = t.media.replace(/\.ogg$/, ".txt");
    assertEquals((await Deno.readTextFile(sidecar)).trim(), "hola, ¿viste el set?");
    // the same bytes forwarded again (a new message) publish from the CACHE — the command
    // would now fail, so a second transcript proves the model never re-ran
    await Deno.writeTextFile(sidecar, "palabras cacheadas\n");
    await t.publish(voiceNote(t.media, { external_id: "wa:note2" }));
    await t.waitFor(async () => (await t.transcripts()).length === 2);
    const again = (await t.transcripts()).find((e) => e.payload?.ref_external_id === "wa:note2")!;
    assertEquals(again.parts[0], { type: "text", kind: "transcript", text: "palabras cacheadas" });
  });
});

Deno.test("the org's locale reaches the processor as LANG — its own business there", async () => {
  // stdin is the audio and stdout is the words, so the org's locale rides the environment
  // under the name every program reads. The harness knows no ASR vocabulary: the processor
  // maps the language to its own.
  await withTranscriber(
    'cat > /dev/null; printf "%s" "$LANG"',
    async (t) => {
      await t.publish(voiceNote(t.media));
      await t.waitFor(async () => (await t.transcripts()).length === 1);
      const [tr] = await t.transcripts();
      assertEquals(tr.parts[0], { type: "text", kind: "transcript", text: "es_AR.UTF-8" });
    },
    { locale: "es_AR.UTF-8" },
  );
});

Deno.test("an org without a locale leaves the processor the harness's own", async () => {
  await withTranscriber(
    'cat > /dev/null; printf "%s" "${LANG-unset}"',
    async (t) => {
      await t.publish(voiceNote(t.media));
      await t.waitFor(async () => (await t.transcripts()).length === 1);
      const [tr] = await t.transcripts();
      assertEquals(tr.parts[0], {
        type: "text",
        kind: "transcript",
        text: Deno.env.get("LANG") ?? "unset",
      });
    },
  );
});

Deno.test("a failing or silent processor publishes nothing", async () => {
  await withTranscriber("exit 3", async (t) => {
    await t.publish(voiceNote(t.media));
    await new Promise((r) => setTimeout(r, 200));
    assertEquals(await t.transcripts(), []);
    // and no sidecar either — a failure is not an empty transcript
    await Deno.lstat(t.media.replace(/\.ogg$/, ".txt")).then(
      () => {
        throw new Error("sidecar written on failure");
      },
      () => {},
    );
  });
});

Deno.test("transcribable: silenced, actions, the model's voice, copies and wireless rows skip", () => {
  const base = voiceNote("/tmp/x.ogg") as MessageEvent;
  assert(transcribable({ ...base, id: "e1" }));
  assert(!transcribable({ ...base, id: "e1", extra: { backfill: true } })); // silenced (§5)
  assert(!transcribable({ ...base, id: "e1", extra: { via: { event: "e0" } } })); // a copy
  assert(!transcribable({ ...base, id: "e1", payload: { action: "edit" } }));
  assert(!transcribable({ ...base, id: "e1", payload: { turn_id: "T1" } })); // its own voice
  const wireless = { ...base, id: "e1", envelope: { ...base.envelope } };
  delete wireless.envelope.external_id;
  assert(!transcribable(wireless));
  const textual = {
    ...base,
    id: "e1",
    parts: [{ type: "text", kind: "text", text: "hola" }],
  } as MessageEvent;
  assert(!transcribable(textual)); // no audio part — nothing to hear
});
