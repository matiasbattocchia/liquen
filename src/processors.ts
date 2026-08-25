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
 * the selector picks the first part whose kind has one, and the sidecar stops being one
 * `<hash>.txt` per file. The open question is the part kind: `transcript` is a lie for a
 * caption, but each new name (`caption`, `extract`) is a member of a closed union that
 * render.ts must learn — one neutral `derived` kind carrying its origin is the alternative,
 * and it changes what the model sees. Decide that before writing the map.
 *
 * The transcript is an `action: "add"` event (§3): a `transcript` text part added to the
 * audio message, `ref_external_id` pointing at it — the original row stays sealed, past
 * WUMs stay invariant, and the words render as a later `<transcript re=…>` line (§5). The
 * wake it fires is the point: the agent reads the note when the words arrive.
 *
 * Idempotence, twice:
 *   the EVENT   `external_id = transcript:<audio external_id>` — deterministic, so the
 *               publish is an upsert: a crash-and-replay merges instead of duplicating,
 *               and one audio message gets exactly one transcript.
 *   the WORK    a `<hash>.txt` sidecar beside the media file caches the text — the same
 *               bytes forwarded again publish a fresh event without re-running the model.
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

import { pathOf } from "./store/media.ts";
import { silenced } from "./render.ts";
import type { Appender, Subscriber } from "./store/log.ts";
import type { Draft, Event, FilePart, MessageEvent } from "./types.ts";

/** A hung model must not wedge the queue (a real 0.9.1 failure mode): well past the
 *  transcribe-in-own-duration rule for the longest note a platform accepts. */
const TIMEOUT_MS = 10 * 60_000;

export interface TranscriberDeps {
  subscribe: Subscriber["subscribe"];
  /** → the EventLog: a transcript is an ordinary published event (§3). */
  publish: Appender["publish"];
  /** The processor (config `processors.audio`): bytes on stdin → text on stdout. */
  command: string;
  /** The org's language (config `locale`), handed over as `MU_LOCALE`. What a processor
   *  makes of it is its own business — the harness knows nothing about ASR languages, and
   *  the mapping from a locale to a model's own vocabulary belongs beside that model. */
  locale?: string | null;
  timeoutMs?: number;
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
  return audio && audio.file.uri.startsWith("file://") ? audio : null;
}

async function transcribe(
  deps: TranscriberDeps,
  e: MessageEvent,
  audio: FilePart,
  now: () => string,
): Promise<void> {
  const path = pathOf(audio.file.uri);
  const sidecar = path.replace(/\.[^./]+$/, "") + ".txt";
  let text: string;
  try {
    text = (await Deno.readTextFile(sidecar)).trim(); // cached — same bytes, same words
  } catch {
    text = (await run(
      deps.command,
      await Deno.readFile(path),
      deps.timeoutMs ?? TIMEOUT_MS,
      deps.locale,
    )).trim();
    if (text) await Deno.writeTextFile(sidecar, text + "\n");
  }
  if (!text) return; // a silent clip has no words to add
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
    parts: [{ type: "text", kind: "transcript", text }],
  } as Draft<MessageEvent>);
}

/** stdin → stdout through `sh -c`. Sequential write-then-read is safe because a
 *  transcriber emits at the end; killed hard on timeout so the queue survives a hang. */
async function run(
  command: string,
  bytes: Uint8Array,
  timeoutMs: number,
  locale?: string | null,
): Promise<string> {
  const child = new Deno.Command("sh", {
    args: ["-c", command],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
    // the org's language reaches the processor as an environment variable: stdin is the
    // audio and stdout is the words, so ambient facts have nowhere else to ride
    ...(locale ? { env: { MU_LOCALE: locale } } : {}),
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
