/**
 * transport/steps.ts — the Google edge's translation, pure: the harness's request (the
 * Anthropic Messages shape render emits) → an Interactions request, and the interaction's
 * assembled steps → the message mu parses. No I/O; google.ts owns the wire and calls in here.
 *
 * The Interactions API is a flat timeline of typed STEPS where the Messages API is a list of
 * role-turned messages holding blocks, so the mapping is n:m: one assistant message becomes a
 * `thought`, a `model_output` and a `function_call` step apiece per block; one user message
 * holding three `tool_result` blocks becomes three `function_result` steps; runs of ordinary
 * user blocks fold into one `user_input`. The system blocks join into one string — the API
 * takes a single `system_instruction`, and its prefix caching is implicit, so the
 * `cache_control` marks have nothing to name and are dropped.
 *
 * Two facts of a model step are load-bearing on replay, and both ride the harness's log
 * (§5): a `thought` step's `signature`, which the API refuses a tool cycle without, and a
 * `function_call` step's `id`, which its `function_result` answers by `call_id` — together
 * with the tool's `name`, which the API also refuses a result without, and which the result
 * block does not carry: it is read off the call the result answers, earlier in the request.
 * Both facts come back through the message as the thinking block's signature and the
 * tool_use block's id.
 *
 * Two things this wire has no home for: a `redacted_thinking` block (the API never produces
 * one to a Google model, so none is ever replayed to it) and media by URL — a `url` source
 * degrades to a text marker naming the link, since the API fetches nothing on its own.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { Interactions } from "@google/genai";
import type { Effort } from "../types.ts";

export type Step = Interactions.Step;
export type Event = Interactions.InteractionSSEEvent;
export type Usage = NonNullable<Interactions.Interaction["usage"]>;
type Content = Interactions.Content;
type FunctionCallStep = Interactions.FunctionCallStep;

/** The request as `interactions.create` takes it, before `stream`/`store` are set. */
export interface Request {
  model: string;
  input: Step[];
  system_instruction?: string;
  tools?: Interactions.Tool[];
  generation_config: Interactions.GenerationConfig;
}

/** The catalog's `effort` → `thinking_level`. The wire has four depths to the catalog's
 *  five, so the top three collapse onto `high`; an agent declaring one the provider cannot
 *  express is refused at boot (transport/mod.ts), so the collapse is never silent. */
export const THINKING_LEVEL: Record<Effort, Interactions.ThinkingLevel> = {
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
};

export function toRequest(params: Anthropic.MessageCreateParamsNonStreaming): Request {
  const effort = params.output_config?.effort as Effort | undefined;
  const system = typeof params.system === "string"
    ? params.system
    : params.system?.map((b) => b.text).join("\n\n");
  const tools = (params.tools ?? []).flatMap((t): Interactions.Tool[] =>
    "input_schema" in t
      ? [{
        type: "function",
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      }]
      : []
  );
  const names = new Map<string, string>(); // call id → tool name, for the results
  return {
    model: params.model,
    input: params.messages.flatMap((m) => stepsOf(m, names)),
    ...(system ? { system_instruction: system } : {}),
    ...(tools.length ? { tools } : {}),
    generation_config: {
      max_output_tokens: params.max_tokens,
      thinking_summaries: "auto",
      ...(effort ? { thinking_level: THINKING_LEVEL[effort] } : {}),
    },
  };
}

/** One message → its steps, in block order. `names` remembers every call seen so far, so
 *  a result can name the tool it answers. */
function stepsOf(m: Anthropic.MessageParam, names: Map<string, string>): Step[] {
  const blocks: Anthropic.ContentBlockParam[] = typeof m.content === "string"
    ? [{ type: "text", text: m.content }]
    : m.content;
  if (m.role === "assistant") {
    for (const b of blocks) if (b.type === "tool_use") names.set(b.id, b.name);
    return blocks.flatMap(assistantStep);
  }
  const out: Step[] = [];
  let open: Content[] | null = null; // the user_input being folded, until a result breaks it
  for (const b of blocks) {
    if (b.type === "tool_result") {
      open = null;
      out.push(resultStep(b, names.get(b.tool_use_id)));
      continue;
    }
    const c = userContent(b);
    if (!c) continue;
    if (!open) out.push({ type: "user_input", content: open = [] });
    open.push(c);
  }
  return out;
}

function assistantStep(b: Anthropic.ContentBlockParam): Step[] {
  switch (b.type) {
    case "thinking":
      return [{
        type: "thought",
        signature: b.signature,
        ...(b.thinking ? { summary: [{ type: "text", text: b.thinking }] } : {}),
      }];
    case "text":
      return [{ type: "model_output", content: [{ type: "text", text: b.text }] }];
    case "tool_use":
      return [{
        type: "function_call",
        id: b.id,
        name: b.name,
        arguments: (b.input ?? {}) as Record<string, unknown>,
      }];
    default:
      return [];
  }
}

function userContent(b: Anthropic.ContentBlockParam): Content | null {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "image":
      return b.source.type === "base64"
        ? { type: "image", data: b.source.data, mime_type: b.source.media_type }
        : { type: "text", text: `<image src="${b.source.url}"/>` };
    case "document":
      return b.source.type === "base64"
        ? { type: "document", data: b.source.data, mime_type: "application/pdf" }
        : b.source.type === "url"
        ? { type: "text", text: `<document src="${b.source.url}"/>` }
        : null;
    case "mid_conv_system":
      return {
        type: "text",
        text: typeof b.content === "string" ? b.content : b.content.map((c) => c.text).join("\n"),
      };
    default:
      return null;
  }
}

function resultStep(
  b: Anthropic.ToolResultBlockParam,
  name: string | undefined,
): Interactions.FunctionResultStep {
  const content = b.content;
  const result = typeof content === "string" || content === undefined
    ? content ?? ""
    : content.flatMap((c): (Interactions.TextContent | Interactions.ImageContent)[] => {
      if (c.type === "text") return [{ type: "text", text: c.text }];
      if (c.type === "image" && c.source.type === "base64") {
        return [{ type: "image", data: c.source.data, mime_type: c.source.media_type }];
      }
      if (c.type === "document") return [{ type: "text", text: "<document/>" }];
      return [];
    });
  return {
    type: "function_result",
    call_id: b.tool_use_id,
    ...(name ? { name } : {}),
    result,
    ...(b.is_error ? { is_error: true } : {}),
  };
}

/* ─────────────────────── the stream → the message ─────────────────────── */

/** An interaction under assembly: the streamed events fold into the steps they describe
 *  (`step.start` opens one at its index, `step.delta`s fill it, `interaction.completed`
 *  brings status and usage — never the steps themselves). The one accumulation with a
 *  shape of its own is a function call's arguments: JSON, streamed as string fragments. */
export interface Assembly {
  steps: Step[];
  status?: string;
  usage?: Usage;
  error?: { code?: string; message?: string };
}

export function assemble(): Assembly & { take: (ev: Event) => void } {
  const steps: Step[] = [];
  const args = new Map<number, string>(); // index → the fragments so far
  const a: Assembly & { take: (ev: Event) => void } = {
    steps,
    take(ev) {
      switch (ev.event_type) {
        case "step.start":
          steps[ev.index] = { ...ev.step };
          return;
        case "step.delta": {
          const s = steps[ev.index];
          const d = ev.delta;
          if (!s) return;
          if (d.type === "text" && s.type === "model_output") {
            (s.content ??= []).push({ type: "text", text: d.text });
          } else if (d.type === "thought_signature" && s.type === "thought") {
            s.signature = d.signature;
          } else if (d.type === "thought_summary" && s.type === "thought" && d.content) {
            (s.summary ??= []).push(d.content as Interactions.TextContent);
          } else if (d.type === "arguments_delta") {
            args.set(ev.index, (args.get(ev.index) ?? "") + (d.arguments ?? ""));
          }
          return;
        }
        case "step.stop": {
          const s = steps[ev.index];
          const raw = args.get(ev.index);
          if (s?.type === "function_call" && raw) {
            (s as FunctionCallStep).arguments = JSON.parse(raw);
          }
          return;
        }
        case "interaction.completed":
          a.status = ev.interaction.status;
          a.usage = ev.interaction.usage ?? undefined;
          return;
        case "error":
          a.error = ev.error ?? {};
          return;
      }
    },
  };
  return a;
}

/** The interaction's status → the harness's stop vocabulary. `requires_action` is the
 *  API's word for a pending `function_call`; `budget_exceeded` is a `max_tokens` cut by
 *  another name. Anything else is not a finished answer and is thrown, so nu classifies it. */
const STOP: Record<string, Anthropic.StopReason> = {
  requires_action: "tool_use",
  completed: "end_turn",
  incomplete: "max_tokens",
  budget_exceeded: "max_tokens",
};

/** A streamed `error` event's `code` is a string, not an HTTP status; nu's retry ladder
 *  classifies on a number (`retryable`). The weather codes map to their HTTP twins; every
 *  other code — including none — reads as the request's own fault, so a failure for a
 *  standing reason never buys a second call in silence. */
const ERROR_STATUS: Record<string, number> = {
  gateway_timeout: 504,
  deadline_exceeded: 504,
  unavailable: 503,
  internal: 500,
  resource_exhausted: 429,
  too_many_requests: 429,
};
const PERMANENT = 400;

/** An `Error` carrying the HTTP status nu classifies on. */
export function failure(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

/** The assembled interaction → the message mu parses. Throws (with a status) when the
 *  interaction did not finish with an answer: an error event, a `failed` or `cancelled`
 *  status, or a stream that ended without `interaction.completed`. */
export function toMessage(model: string, a: Assembly): Anthropic.Message {
  if (a.error) {
    throw failure(
      a.error.message ?? `interaction error ${a.error.code ?? ""}`.trim(),
      ERROR_STATUS[a.error.code ?? ""] ?? PERMANENT,
    );
  }
  const stop = a.status ? STOP[a.status] : undefined;
  if (!stop) {
    // `failed` is the model's run failing with no word why — weather until told otherwise;
    // `cancelled` and an unfinished stream are this request's own ending
    const status = a.status === "failed" ? 500 : PERMANENT;
    throw failure(`interaction ended ${a.status ?? "without completing"}`, status);
  }
  return {
    id: "",
    type: "message",
    role: "assistant",
    model,
    stop_reason: stop,
    stop_sequence: null,
    content: a.steps.flatMap(blockOf),
    usage: usageOf(a.usage),
  } as Anthropic.Message;
}

/** A model step → its content block. Server-tool steps and non-text output are skipped,
 *  as mu skips the blocks it has no emission for. A `thought` step with no summary is the
 *  common case: the signature alone is the block, and it is what the cycle replays. One
 *  `model_output` is one utterance however many text items it streamed as — one block, so
 *  nu logs one message. */
function blockOf(s: Step): Anthropic.ContentBlock[] {
  switch (s.type) {
    case "thought":
      return [{
        type: "thinking",
        thinking: (s.summary ?? []).flatMap((c) => c.type === "text" ? [c.text] : []).join(""),
        signature: s.signature ?? "",
      }];
    case "model_output": {
      const text = (s.content ?? []).flatMap((c) => c.type === "text" ? [c.text] : []).join("");
      return text ? [{ type: "text", text, citations: null }] : [];
    }
    case "function_call":
      return [
        { type: "tool_use", id: s.id, name: s.name, input: s.arguments } as Anthropic.ToolUseBlock,
      ];
    default:
      return [];
  }
}

/** The interaction's usage in the message's vocabulary. `total_input_tokens` counts the
 *  cached prefix in; `total_output_tokens` leaves thought tokens out — the Messages shape
 *  does the reverse on both, so the row that lands in the usage table compares. The API has
 *  no cache write to report: its prefix caching is implicit. */
function usageOf(u: Usage | undefined): Anthropic.Usage {
  const cached = u?.total_cached_tokens ?? 0;
  return {
    input_tokens: (u?.total_input_tokens ?? 0) - cached,
    output_tokens: (u?.total_output_tokens ?? 0) + (u?.total_thought_tokens ?? 0),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: null,
  } as Anthropic.Usage;
}
