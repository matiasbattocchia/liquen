/**
 * processors.ts — the media processors (DESIGN §5): bytes the model cannot read become
 * durable, searchable text, as EVENTS. Today one runs: the audio transcriber.
 *
 * Broker machinery, not a tool and not a connector's: a log listener like the mirror,
 * composed by main, connector-neutral (whatever ingested the audio, it is a message with
 * an audio FilePart by the time it is here) and inert unless `processors.audio` is
 * configured (config.ts — the org catalog). The processor is a SHELL COMMAND — audio bytes
 * on stdin, transcript text on stdout, non-zero exit = no transcript. That command line is
 * the whole plugin interface; the repo ships `processors/qwen-asr/` as one implementation.
 *
 * WHAT IS AND ISN'T AUDIO-SPECIFIC. The machine below is generic over "bytes → text": the
 * command interface, the `action: "add"` event, both idempotence axes, the serialization,
 * the timeout kill, the live tail, the skip list. Three things bind it to audio —
 * `transcribable`'s `kind === "audio"` test, the scalar config key `processors.audio`, and
 * the output part's `kind: "transcript"`. A second modality (image OCR/caption, document
 * extraction) is therefore a DISPATCH, not a rewrite: `processors` becomes kind → command,
 * and the selector picks the first part whose kind has one. The open question is the part
 * kind: `transcript` is a lie for a
 * caption, but each new name (`caption`, `extract`) is a member of a closed union that
 * render.ts must learn — one neutral `derived` kind carrying its origin is the alternative,
 * and it changes what the model sees. Decide that before writing the map.
 *
 * The transcript is an `action: "add"` event (§3): a `transcript` text part added to the
 * audio message, `ref_external_id` pointing at it — the original row stays sealed, past
 * WUMs stay invariant, and the words render as a later `<transcript re=…>` line (§5). The
 * wake it fires is the point: the agent reads the note when the words arrive. An output
 * past `PROCESSOR_TEXT_CAP` rides as its head, and a `document` part beside it names the
 * whole, kept as a text object the event references: the agent reads on through its door.
 *
 * Idempotence, twice:
 *   the EVENT   `external_id = transcript:<audio external_id>` — deterministic, so the
 *               publish is an upsert: a crash-and-replay merges instead of duplicating,
 *               and one audio message gets exactly one transcript.
 *   the WORK    the same bytes are one object, and `refs` names every message that
 *               carries it: a note forwarded again takes the words an earlier one was
 *               given, and the model never runs twice over them.
 *
 * What never transcribes: silenced rows (history and muted chats are not news, §5), the
 * model's own voice (`turn_id` — it knows what it said), action-carrying events, mirror
 * copies (`extra.via` — the origin transcribes; fan-in carries the words to the mind), and
 * rows without an `external_id` (nothing stable to point at).
 *
 * SERIAL, one at a time — a note. Transcription is CPU-bound and a note transcribes in
 * roughly its own duration; a burst of forwarded notes is exactly when N model trees must
 * not race each other. The queue is the chain, backpressure is the log. If a GPU box ever
 * runs this, concurrency becomes a `processors` knob — not before.
 *
 * LIVE tail, like the mirror: notes that arrived while the process was down are not owed a
 * transcript — the agent read them as `<audio/>` markers, and `search` still finds the
 * conversation around them.
 */

import { saveMedia } from "./store/media.ts";
import { isStored, keyOf, type Storage } from "./store/storage.ts";
import { silenced } from "./render.ts";
import type { Appender, Reader, Subscriber } from "./store/log.ts";
import type { Draft, Event, FilePart, MessageEvent, Part } from "./types.ts";

/** A hung model must not wedge the queue (a real 0.9.1 failure mode): well past the
 *  transcribe-in-own-duration rule for the longest note a platform accepts. It is also the
 *  deadline attention holds a sealed note for (xi §2): past it, nobody is coming. */
export const PROCESSOR_TIMEOUT_MS = 10 * 60_000;

/** The most of a processor's output the event carries as words: past it, the words are its
 *  head, and the whole output is kept as an object the event references. */
export const PROCESSOR_TEXT_CAP = 4 * 1024;

export interface TranscriberDeps {
  subscribe: Subscriber["subscribe"];
  /** → the EventLog: a transcript is an ordinary published event (§3). */
  publish: Appender["publish"];
  /** The log, read: another message that references the same bytes, and its words. */
  read: Reader["read"];
  /** Where the audio's bytes are kept. */
  storage: Storage;
  /** The processor (config `processors.audio`): bytes on stdin → text on stdout. */
  command: string;
  /** The org's locale (config `locale`) — the processor's LANG. What a processor makes of
   *  it is its own business: the harness knows nothing about ASR languages, and the mapping
   *  from a locale to a model's own vocabulary belongs beside that model. */
  locale?: string | null;
  now?: () => string;
  onError?: (event: Event, err: unknown) => void;
}

/** Wire the transcriber to the log. Returns unsubscribe. Serialized — see the header. */
export function createTranscriber(deps: TranscriberDeps): () => void {
  const now = deps.now ?? (() => new Date().toISOString());
  let chain: Promise<void> = Promise.resolve();
  return deps.subscribe((e) => {
    const audio = transcribable(e);
    if (!audio) return;
    chain = chain.then(() => transcribe(deps, e as MessageEvent, audio, now))
      .catch((err) => deps.onError?.(e, err));
  });
}

/** The audio part of a message that wants words, or null — the skip list in the header. */
export function transcribable(e: Event): FilePart | null {
  if (e.type !== "message" || silenced(e)) return null;
  if (e.payload?.action || e.payload?.turn_id || e.extra?.via) return null;
  if (!e.envelope.external_id) return null;
  const audio = e.parts.find((p): p is FilePart => p.type === "file" && p.kind === "audio");
  return audio && isStored(audio.file.uri) ? audio : null;
}

async function transcribe(
  deps: TranscriberDeps,
  e: MessageEvent,
  audio: FilePart,
  now: () => string,
): Promise<void> {
  const parts = await heard(deps, audio.file.uri) ??
    await partsOf(deps.storage, await hear(deps, audio.file.uri));
  if (!parts) return; // a silent clip, or bytes gone: no words to add
  const { service, connection_address, conversation, external_id } = e.envelope;
  await deps.publish({
    ts: now(),
    type: "message",
    // no sender and no agent: the harness derived it — which is also what keeps it off the
    // wire (dispatch wants `agent` + no external_id) and out of fan-in's absorb guard (§4)
    envelope: {
      service,
      connection_address,
      conversation,
      external_id: `transcript:${external_id}`,
    },
    payload: { action: "add", ref_external_id: external_id },
    parts,
  } as Draft<MessageEvent>);
}

/** A processor's output as a transcript's parts: the words whole, or, past the cap, their
 *  head beside the whole output kept as a text object. */
async function partsOf(storage: Storage, text: string): Promise<Part[] | undefined> {
  if (!text) return undefined;
  if (text.length <= PROCESSOR_TEXT_CAP) return [{ type: "text", kind: "transcript", text }];
  const whole = await saveMedia(storage, new TextEncoder().encode(text), {
    mime_type: "text/plain",
  });
  return [
    { type: "text", kind: "transcript", text: headOf(text, PROCESSOR_TEXT_CAP) },
    { type: "file", kind: "document", file: whole },
  ];
}

/** The text's first `cap` characters, cut at a word where one is near, marked as cut. */
function headOf(text: string, cap: number): string {
  const cut = text.slice(0, cap);
  const space = cut.search(/\s\S*$/);
  return `${space > cap * 0.8 ? cut.slice(0, space) : cut}…`;
}

/** The transcript already made of these bytes: another message that references the same
 *  object (`refs`, §8) and has one, its words and the whole output it kept. A note
 *  forwarded again is one object, so the model hears it once. */
async function heard(deps: TranscriberDeps, uri: string): Promise<Part[] | undefined> {
  for (const e of await deps.read({ uri, types: ["message"] })) {
    const id = e.envelope.external_id;
    if (!id) continue;
    const [words] = await deps.read({ externalId: `transcript:${id}`, limit: 1 });
    const parts = words?.type === "message" ? words.parts : [];
    const text = parts.find((p) => p.type === "text" && p.kind === "transcript");
    if (text?.type === "text" && text.text) {
      return parts.filter((p) => p === text || p.type === "file");
    }
  }
  return undefined;
}

/** The processor run over the object's bytes. */
async function hear(deps: TranscriberDeps, uri: string): Promise<string> {
  const bytes = await deps.storage.get(keyOf(uri));
  if (!bytes) return "";
  return (await run(deps.command, bytes, PROCESSOR_TIMEOUT_MS, processorEnv(deps))).trim();
}

/** stdin → stdout through `sh -c`. Sequential write-then-read is safe because a
 *  transcriber emits at the end; killed hard on timeout so the queue survives a hang. */
/** The org's locale under the name every program reads: stdin is the audio and stdout is
 *  the words, so an ambient fact has nowhere but the environment to ride. */
function processorEnv(org: { locale?: string | null }): Record<string, string> {
  return org.locale ? { LANG: org.locale } : {};
}

async function run(
  command: string,
  bytes: Uint8Array,
  timeoutMs: number,
  env: Record<string, string>,
): Promise<string> {
  const child = new Deno.Command("sh", {
    args: ["-c", command],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    env,
  }).spawn();
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch { /* already exited */ }
  }, timeoutMs);
  try {
    const stdin = child.stdin.getWriter();
    await stdin.write(bytes).catch(() => {}); // an early-exiting command closes the pipe
    await stdin.close().catch(() => {});
    const out = await child.output();
    if (!out.success) {
      const err = new TextDecoder().decode(out.stderr).trim().slice(0, 400);
      throw new Error(`processors.audio exit ${out.code}${err ? `: ${err}` : ""}`);
    }
    return new TextDecoder().decode(out.stdout);
  } finally {
    clearTimeout(timer);
  }
}
