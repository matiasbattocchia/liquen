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

import type Anthropic from "@anthropic-ai/sdk";
import type { ModelTransport } from "../mu.ts";
import type { UsageRow } from "../store/log.ts";
import type { Credentials } from "../store/credentials.ts";
import { DEFAULT_WARM_HOURS, EFFORTS, type ProviderName } from "../config.ts";
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
  cache: CacheKind;
}

/** How a provider's cache reads a request back. `marked`: from the blocks an earlier
 *  request marked, wherever they fall (Anthropic's `cache_control`). `implicit`: only as far
 *  as an earlier request ran, give or take its last couple of thousand tokens (Gemini). */
export type CacheKind = "marked" | "implicit";

export const ANTHROPIC: Provider = { name: "anthropic", efforts: EFFORTS, cache: "marked" };
export const GOOGLE: Provider = {
  name: "google",
  cache: "implicit",
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

/** The vault key a provider's API key is stored under: the org's, or one agent's own
 *  (`liquen connect ai`). */
export function aiKey(provider: ProviderName, agentId?: string): string {
  return agentId ? `ai:${provider}:${agentId}` : `ai:${provider}`;
}

/** The API key a call spends, looked up at every call: undefined leaves it to the SDK's own
 *  chain, the environment's (`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, an `ant auth login`). */
export type KeyOf = (provider: ProviderName, agentId?: string) => Promise<string | undefined>;

/** The vault's keys: the agent's own row before the org's. */
export function vaultKeys(creds: Pick<Credentials, "get">): KeyOf {
  return async (provider, agentId) => {
    const own = agentId ? await creds.get(aiKey(provider, agentId)) : null;
    const row = own ?? await creds.get(aiKey(provider));
    return row?.value.api_key || undefined;
  };
}

/** The transports a process holds: one client per provider and credential, built on first
 *  use — a client is a connection pool and a credential, and every agent spending the same
 *  key on the same provider shares both. The key is looked up at every call (`keyOf`), so a
 *  key connected or rotated while the org runs is spent from the next call, and a client
 *  whose key was rotated away is simply never asked again. An explicit `anthropic` key (a
 *  test's, a library caller's) wins over all of it. */
export function transports(
  keys: { anthropic?: string; keyOf?: KeyOf } = {},
  make: (p: Provider, key: string | undefined) => ModelTransport = clientTransport,
): (p: Provider, agentId?: string) => ModelTransport {
  const made = new Map<string, ModelTransport>();
  const built = (p: Provider, key: string | undefined): ModelTransport => {
    const id = `${p.name}\0${key ?? ""}`;
    let t = made.get(id);
    if (!t) {
      t = make(p, key);
      made.set(id, t);
    }
    return t;
  };
  return (p, agentId) => {
    const fixed = p.name === "anthropic" ? keys.anthropic : undefined;
    const keyOf = keys.keyOf;
    if (fixed || !keyOf) return silenced(built(p, fixed));
    return silenced(async (params, emit, meta, signal) =>
      built(p, await keyOf(p.name, agentId))(params, emit, meta, signal)
    );
  };
}

/** The provider's own client behind a transport: `key` undefined is the SDK's chain. */
function clientTransport(p: Provider, key: string | undefined): ModelTransport {
  return p.name === "google"
    ? googleTransport(googleClient(key))
    : anthropicTransport(anthropicClient(key));
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

/** How long a cache mark holds what it marked: the hour every mark asks for (render),
 *  counted from the start of the request that last read it. */
export const CACHE_HOUR_MS = 60 * 60_000;

/** How long after the start of the call that last read a session's cache the keeper reads
 *  it again: the hour, less the margin a ping needs to land inside it. */
export const WARM_MS = 55 * 60_000;

/** How often an armed keeper reads the wall clock. A timer counts on a clock that stands
 *  still while the machine is suspended, so a ping never waits on one long timer: each beat
 *  sets the next against the wall clock, and a ping falls due within a beat of its time. */
export const WARM_BEAT_MS = 60_000;

/** The ping a session's cache is owed: the request to read again, the start of the read
 *  its hour runs from, and the start of the session's last call, which the run's horizon
 *  counts from. A keeper hands it over when it stops, and the next one takes it up. */
export interface Owed {
  params: Parameters<ModelTransport>[0];
  started: number;
  since: number;
  /** The id of the session's last response, so the next run's first call can name it and
   *  hear whether a restart changed the prefix. */
  previous?: string;
}

/** A session's keeper: its transport passes `through` it, and `stop` ends it for good,
 *  handing back the ping still owed while its hour runs. A transport that is not `kept` (a
 *  provider with no hour cache) stands the armed ping down, so a ping never outlives the
 *  session's move to it. */
export interface Warmth {
  through(transport: ModelTransport, kept?: boolean): ModelTransport;
  stop(): Owed | undefined;
}

/**
 * Keep a quiet session's cache warm (§5). A turn's call (`think`) arms a ping `everyMs`
 * after its start: the same request with `max_tokens: 0`, which reads the whole prefix,
 * answers nothing and starts the hour again. It goes through the transport the call went
 * through, metered as `keepalive`, and arms the next, for as long as `horizonMs` past the
 * start of the session's last call. A call that answers takes the timer over, and a
 * checkpoint arms none, since the next turn renders past it. A call that fails read
 * nothing, so the ping armed before it stays armed.
 *
 * An armed keeper beats every `beatMs` on the wall clock, so a machine woken from a suspend
 * sends the ping within a beat, and a beat that lands late says how long the machine
 * slept. A ping whose hour ran out stands down: it would write the prefix, not read it,
 * and the next turn writes it anyway. A failed ping ends the run, and so does the horizon.
 *
 * `owed` is the ping a stopped keeper handed over: the first kept transport through this
 * one arms it, so a restart inside the hour keeps the cache.
 *
 * Every kept call, ping or turn, names the session's call before it (cache diagnostics),
 * and the API answers where the two requests diverged. A call that reads nothing back, or
 * that the API says changed its prefix, is said through `say`, with what it read and
 * wrote; so is a ping that stands down, one taken up from the last run, one that failed,
 * a run the horizon ends, and a sleep a beat finds.
 */
export function warmth(
  {
    everyMs = WARM_MS,
    beatMs = WARM_BEAT_MS,
    horizonMs = () => DEFAULT_WARM_HOURS * 3_600_000,
    now = Date.now,
    owed: handed,
    say = (line) => console.error(line),
  }: {
    everyMs?: number;
    beatMs?: number;
    /** Read at each ping, so an edit to the knob reaches a run already going. */
    horizonMs?: () => number;
    now?: () => number;
    owed?: Owed;
    say?: (line: string) => void;
  } = {},
): Warmth {
  const quit = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let run: (Owed & { transport: ModelTransport }) | undefined; // the ping armed now
  let previous = handed?.previous; // the session's last response, named by its next call
  const lapsed = (o: Owed) => now() - o.started >= CACHE_HOUR_MS;
  const minutes = (ms: number) => Math.max(0, Math.round(ms / 60_000));
  const stand = () => {
    clearTimeout(timer);
    timer = undefined;
    run = undefined;
  };
  const send = async (
    transport: ModelTransport,
    params: Parameters<ModelTransport>[0],
    meta: Parameters<ModelTransport>[2],
    emit?: Parameters<ModelTransport>[1],
    signal?: AbortSignal,
  ) => {
    const named = previous;
    const asked = { ...params, diagnostics: { previous_message_id: named ?? null } };
    const message = await transport(asked as typeof params, emit, meta, signal);
    if (message.id) previous = message.id;
    if (named) tell(meta?.kind ?? "call", message);
    return message;
  };
  const tell = (kind: string, message: Anthropic.Message) => {
    const read = message.usage?.cache_read_input_tokens ?? 0;
    const wrote = message.usage?.cache_creation_input_tokens ?? 0;
    const diagnostics = (message as { diagnostics?: Diagnostics | null }).diagnostics;
    const reason = diagnostics?.cache_miss_reason;
    if (reason) {
      return say(`${kind} missed the cache: ${reason.type}, read ${read}, wrote ${wrote}`);
    }
    if (read > 0 || wrote === 0) return;
    say(
      diagnostics === null
        ? `${kind} read nothing back, wrote ${wrote}: the prefix held, the cache had lapsed`
        : `${kind} read nothing back, wrote ${wrote}`,
    );
  };
  const arm = (next: Owed & { transport: ModelTransport }) => {
    run = next;
    beat(next);
  };
  const beat = (next: Owed & { transport: ModelTransport }) => {
    clearTimeout(timer);
    const set = now();
    const wait = Math.min(beatMs, Math.max(0, next.started + everyMs - set));
    timer = setTimeout(() => {
      timer = undefined;
      const late = now() - set - wait;
      if (late > SLEPT_MS) say(`the machine slept ${minutes(late)} min`);
      if (lapsed(next)) {
        run = undefined;
        const past = now() - next.started - CACHE_HOUR_MS;
        return say(`keep-alive stood down ${minutes(past)} min past its hour: the cache lapsed`);
      }
      if (now() < next.started + everyMs) return beat(next);
      const horizon = horizonMs();
      if (now() - next.since >= horizon) {
        run = undefined;
        const hours = Math.round(horizon / 3_600_000);
        return say(
          `keep-alive run over, ${hours} h past the session's last call: the cache lapses`,
        );
      }
      const start = now();
      void send(
        next.transport,
        { ...next.params, max_tokens: 0 },
        { kind: "keepalive" },
        undefined,
        quit.signal,
      )
        .then(
          () => {
            if (run !== next) return; // a call answered meanwhile and armed its own
            arm({ ...next, started: start });
          },
          (err) => {
            if (run === next) run = undefined;
            if (!quit.signal.aborted) {
              say(`keep-alive failed, the cache left to lapse: ${(err as Error).message}`);
            }
          },
        );
    }, wait);
  };
  return {
    through: (transport, kept = true) => {
      if (handed && kept) {
        if (lapsed(handed)) {
          const ago = now() - handed.started - CACHE_HOUR_MS;
          say(`the last run's keep-alive had lapsed ${minutes(ago)} min before this one began`);
        } else {
          arm({ ...handed, transport });
          const due = handed.started + everyMs - now();
          say(`took up the last run's keep-alive, due in ${minutes(due)} min`);
        }
      }
      handed = undefined;
      return async (params, emit, meta, signal) => {
        if (!kept) stand();
        const start = now();
        const message = kept
          ? await send(transport, params, meta, emit, signal)
          : await transport(params, emit, meta, signal);
        if (kept && !quit.signal.aborted) {
          if (meta?.kind === "think") arm({ transport, params, started: start, since: start });
          else stand();
        }
        return message;
      };
    },
    stop() {
      quit.abort();
      const owed = run && !lapsed(run)
        ? {
          params: run.params,
          started: run.started,
          since: run.since,
          ...(previous ? { previous } : {}),
        }
        : undefined;
      stand();
      return owed;
    },
  };
}

/** What the API says of a request that named the one before it: `null` when nothing
 *  diverged before the last cache mark, a `cache_miss_reason` naming the first place it
 *  did (`system_changed`, `tools_changed`, `messages_changed`, …), or a null reason while
 *  the comparison is still running. */
interface Diagnostics {
  cache_miss_reason: { type: string; cache_missed_input_tokens?: number } | null;
}

/** The ping a stopped keeper left at `path`, taken once: the file goes with the reading. */
export function takeOwed(path: string): Owed | undefined {
  let text: string;
  try {
    text = Deno.readTextFileSync(path);
    Deno.removeSync(path);
  } catch {
    return undefined; // none was left
  }
  try {
    return JSON.parse(text) as Owed;
  } catch {
    return undefined;
  }
}

/** Leave the ping a keeper owed at `path` for the next boot, or nothing when none is owed. */
export function leaveOwed(path: string, owed: Owed | undefined): void {
  if (!owed) return;
  try {
    Deno.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    Deno.writeTextFileSync(path, JSON.stringify(owed));
  } catch (err) {
    console.error(`the keep-alive owed was not kept: ${(err as Error).message}`);
  }
}
