/**
 * transport/ — the real `ModelTransport`s: the one impure edge that talks to a model provider.
 *
 * mu stays pure by taking the model call as a parameter (see mu.ts). This is the production
 * wiring of that parameter, one transport per provider: open a streaming request, pump
 * `text`/`thinking`/`tool` deltas to the Stream via `emit`, and return the final message. Errors
 * propagate as a rejected promise — mu's boundary turns that into `{ ok: false, error }`,
 * and nu owns the retry (§2).
 *
 * The request vocabulary is the Anthropic Messages shape — what render emits and mu parses —
 * and it is the harness's own: a provider whose wire differs adapts to it here, in its
 * transport, and nothing above the transport knows which provider answered. `stop_reason`,
 * usage, content blocks all come back in that one vocabulary.
 *
 * A provider is also a set of facts the org's config is checked against at boot (§9): the
 * shape of its model names and the reasoning depths it can express. An agent declared on a
 * provider that cannot run its model at its effort fails at start, never mid-conversation.
 */

import type { ModelTransport } from "../mu.ts";
import type { UsageRow } from "../store/log.ts";
import { EFFORTS, type ProviderName } from "../config.ts";
import type { Effort } from "../types.ts";
import { anthropicClient, anthropicTransport } from "./anthropic.ts";
import { googleClient, googleTransport } from "./google.ts";

/** Re-exported: main picks a transport here, and never needs to reach into mu. */
export type { ModelTransport };

/** What the harness knows about a provider beyond its wire: the config name, the reasoning
 *  depths it can express (a subset of the catalog's `effort`), and — where the provider's
 *  model list is closed and prefixed — the shape its model names take. Anthropic's names
 *  are the API's to judge, so it declares none. */
export interface Provider {
  name: ProviderName;
  efforts: readonly Effort[];
  models?: RegExp;
}

export const ANTHROPIC: Provider = { name: "anthropic", efforts: EFFORTS };
export const GOOGLE: Provider = {
  name: "google",
  efforts: ["low", "medium", "high"], // `thinking_level`: minimal · low · medium · high
  models: /^gemini-/,
};
const PROVIDERS: readonly Provider[] = [ANTHROPIC, GOOGLE];

/** The catalog's `provider` (null ⇒ Anthropic) → the provider. */
export function providerOf(name: string | null | undefined): Provider {
  const found = PROVIDERS.find((p) => p.name === (name ?? ANTHROPIC.name));
  if (!found) throw new Error(`unknown provider "${name}"`);
  return found;
}

/** The boot check (§9): the agent's provider can run its model at its effort. */
export function checkProvider(
  agent: { agentId: string; provider?: string | null; model: string; effort?: Effort | null },
): void {
  const p = providerOf(agent.provider);
  if (p.models && !p.models.test(agent.model)) {
    throw new Error(`agent ${agent.agentId}: model "${agent.model}" is not a ${p.name} model`);
  }
  if (agent.effort && !p.efforts.includes(agent.effort)) {
    throw new Error(
      `agent ${agent.agentId}: effort "${agent.effort}" is not one ${p.name} can express ` +
        `(one of ${p.efforts.join(", ")})`,
    );
  }
}

/** The transports a process holds, one per provider, built on first use: a client is a
 *  connection pool and a credential, and every agent on the same provider shares both. */
export function transports(keys: { anthropic?: string } = {}): (p: Provider) => ModelTransport {
  const made = new Map<ProviderName, ModelTransport>();
  return (p) => {
    const had = made.get(p.name);
    if (had) return had;
    const t: ModelTransport = silenced(
      p.name === "google"
        ? googleTransport(googleClient())
        : anthropicTransport(anthropicClient(keys.anthropic)),
    );
    made.set(p.name, t);
    return t;
  };
}

/** How long a call may go without a delta before it counts as a dropped connection. A
 *  working model streams its text, thinking and tool calls throughout, however long it
 *  works, so this much silence is a peer that is gone: a stream whose end never arrived.
 *  Long enough for the one silence a working model keeps — a tool call's arguments, which a
 *  provider may send only once they are whole. Timers stop while the machine sleeps, so the
 *  count runs in time awake. */
export const SILENCE_MS = 300_000;

/** The deadline a call is left with once the machine wakes. A short sleep leaves the
 *  connection standing and the stream picks up where it was; a long one leaves a peer that
 *  hung up while its goodbye had nowhere to land, and the reader never learns of it. So the
 *  wake does not cut the call: it gives the stream this long to say something. */
export const WAKE_MS = 30_000;

/** How often a call in flight looks at the wall clock, and how far past a tick the clock
 *  must have run to count as a sleep — a stalled event loop runs late by less. */
const TICK_MS = 5_000;
const SLEPT_MS = 10_000;

/** The clocks `silenced` reads, a test's to fake. */
export interface Silence {
  silenceMs?: number;
  wakeMs?: number;
  tickMs?: number;
  /** The wall clock: it runs while the machine sleeps, where timers do not. */
  now?: () => number;
}

/**
 * Give a transport a silence deadline: every delta it emits re-arms it, and a call that goes
 * `silenceMs` without one is aborted through the signal the transport was handed, beside the
 * turn's interrupt. The call then fails with no status, which nu retries as weather (§2) —
 * the SDKs set no limit of their own that a stream mid-flight would hit.
 *
 * A wake shortens the wait: a tick that finds the wall clock far ahead of its interval
 * means the machine slept, and the deadline drops to `wakeMs` — the next delta restores it.
 */
export function silenced(
  transport: ModelTransport,
  { silenceMs = SILENCE_MS, wakeMs = WAKE_MS, tickMs = TICK_MS, now = Date.now }: Silence = {},
): ModelTransport {
  return async (params, emit, meta, signal) => {
    const silence = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let woke = false; // the deadline running is the wake's
    const arm = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => silence.abort(), ms);
    };
    arm(silenceMs);
    let ticked = now();
    const ticker = setInterval(() => {
      const t = now();
      if (t - ticked > tickMs + SLEPT_MS) {
        woke = true;
        arm(wakeMs);
      }
      ticked = t;
    }, tickMs);
    try {
      return await transport(
        params,
        (d) => {
          woke = false;
          arm(silenceMs);
          emit?.(d);
        },
        meta,
        signal ? AbortSignal.any([signal, silence.signal]) : silence.signal,
      );
    } catch (err) {
      if (silence.signal.aborted && !signal?.aborted) {
        throw new Error(
          woke
            ? `no word from the model in ${wakeMs / 1000}s after the machine woke: ` +
              `the connection died while it slept`
            : `no word from the model in ${silenceMs / 1000}s: the connection is gone`,
        );
      }
      throw err;
    } finally {
      clearTimeout(timer);
      clearInterval(ticker);
    }
  };
}

/**
 * Meter a transport: record every model call's spend — turns, compaction checkpoints,
 * whatever passes through — into the usage table (§2: telemetry, not the log). This is THE
 * seam for it: every call crosses the transport, and the response already carries `usage`,
 * so no layer above changes. Wrapped per agent in main, which is what attributes the spend.
 *
 * The row also carries the call's `turn_id` and `kind` (`CallMeta`, both set by nu before
 * the request): spend is telemetry, but a turn is a log key, so "what did this conversation
 * cost" is a join rather than a guess from timestamps, and "what has maintenance cost" reads
 * the kind rather than inferring it from the shape of the numbers.
 */
export function metered(
  transport: ModelTransport,
  meter: (row: UsageRow) => void,
  agentId?: string,
): ModelTransport {
  return async (params, emit, meta, signal) => {
    const message = await transport(params, emit, meta, signal); // a failed call spends nothing meterable
    try {
      meter({
        created_at: new Date().toISOString(),
        agent_id: agentId,
        ...(meta?.turn_id ? { turn_id: meta.turn_id } : {}),
        ...(meta?.kind ? { kind: meta.kind } : {}),
        model: params.model,
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cache_read_tokens: message.usage.cache_read_input_tokens ?? undefined,
        cache_write_tokens: message.usage.cache_creation_input_tokens ?? undefined,
      });
    } catch { /* telemetry must never fail the call */ }
    return message;
  };
}
