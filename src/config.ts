/**
 * config.ts — the catalog (DESIGN §9): every harness knob, its default, one file exposing
 * them all.
 *
 * The standing rules:
 *
 *   · `start` / `xi` / `nu` / `mu` are 100% parametrized — values arrive as arguments,
 *     never from the environment. Argument defaults are ergonomics for direct callers
 *     (tests); they are the named constants defined HERE, the single source. Seeding
 *     materializes the same constants into the file, so code and file cannot drift.
 *   · main is the only reader of the config files, and it funnels the resolved values down
 *     the chain (main → xi → nu → mu). Placement in the FILE is by audience —
 *     `organization`: org-wide facts, set here and nowhere else · `agent`: every agent's
 *     defaults, the section an agent's own file re-declares · `system`: harness machinery —
 *     while the value still funnels to the deepest function that needs it.
 *   · `data/config.jsonc` always exposes the whole catalog. Absent, it is materialized
 *     from the constants; when the catalog grows, the missing keys are appended (values
 *     you set survive — the comments are the catalog's). An unknown key is a boot error: a
 *     typo must not run silently. Agent files are sparse — only what they override, plus
 *     the declared identity handles.
 *   · `connections.<name>` subsections belong to the connectors: each connector ships its
 *     own `config.ts` (its DEFAULT_s, the same rules) and heals ITS subsection through
 *     `ensureConnectorConfig` — main preserves subsections it does not know, so shipped
 *     and custom connectors are configured identically.
 *   · env is for secrets only (tokens the services hold; `ANTHROPIC_API_KEY` belongs to
 *     the SDK's own credential chain, not to us); everything else lives in the file or is
 *     a constant. The data root is `./data`, period. Session choices (which agent a REPL
 *     faces) are CLI arguments — per-invocation by nature, no seat in either file.
 */

import { parse } from "@std/jsonc";
import type { Effort, PolicyAction, Rule } from "./types.ts";

/* ── the defaults: the single source ─────────────────────────────────────── */

// organization — org-wide facts
export const DEFAULT_BACKLOG_HOURS = 24;

// agent — every agent's defaults (an agent's file re-declares these, key by key)
export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_MAX_TOKENS = 64_000; // streaming — room for thinking + tools + text
export const DEFAULT_TIMEZONE = "UTC"; // explicit, so two boxes render the same stamps
// the default deployment's whole offer: the four built-ins plus the exec plane's bash.
// A name added at runtime (an MCP server's tools) joins the offer by being listed here.
export const DEFAULT_TOOLS = ["send", "search", "schedule", "cancel", "bash"];
export const DEFAULT_RULES: Rule[] = [
  { tool: "send", action: "ask" }, // dispatch leaves the org, in the principal's name
  { tool: "*", action: "allow" },
];
// attention (§2). The baseline is that every message deserves a reaction; these four knobs
// are the cooling, and each names one rule of the ladder. `engagedMinutes` — how long the
// agent's own last word keeps a conversation hot, and how long the principal's own line
// there holds the floor back. `digestMinutes` — how often the agent CHECKS the world,
// counted from the last time it looked, the way a person puts the phone down and picks it
// up again. `digestAfterMessages` — how much unread has to pile up, across the whole world,
// for it to check early.
export const DEFAULT_ENGAGED_MINUTES = 15;
export const DEFAULT_DIGEST_AFTER_MESSAGES = 25;
export const DEFAULT_DIGEST_MINUTES = 15;
// Nights are not a slower cadence, they are SLEEP: inside the span the ambient class wakes
// nobody at all, however deep the pile gets. A stretched interval was a number tuned
// against a cache TTL nobody controls — past an hour every wake pays a full uncached write
// anyway, so three of them cost more than the ten they replaced. Sleep drops the number:
// the world waits until morning and arrives as one digest. What still wakes is what always
// did — the mind alias, and a conversation the agent is holding the floor in.
export const DEFAULT_SLEEP_HOURS = "23-8";

// system — harness machinery
export const DEFAULT_STOP_TIMEOUT_MS = 5_000; // cap on stop() awaiting an in-flight turn
export const DEFAULT_BASH_TIMEOUT_MS = 120_000; // a bash call's cap unless the model asks
export const DEFAULT_LOCK_TTL_MS = 120_000; // a turn lease older than this is STOLEN
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 20_000]; // slow outer retries (§2)
// est. tokens of RAW EVENT JSON (`estTokens`, chars/4) — roughly 1.8x the prompt those
// events render to, since the estimate counts ids, envelopes and the tool traffic the
// closed region drops. It has to sit BELOW what a full window weighs or the count cap
// binds first and the checkpoint is unreachable code (`compact.test.ts` guards this) — a
// live 500-event window measures ~52K, so the headroom here is thin by construction and
// this number cannot be raised without raising `windowLimit` with it.
//
// Which is also why it is not the knob for how OFTEN a checkpoint runs. A checkpoint is
// priced against the CACHE, not the window: it rewrites the prompt prefix, so it costs an
// uncached call plus the full writes that follow until the cache re-settles. Both halves
// scale with the window, while the interval between checkpoints scales the same way — a
// wider window buys proportionally rarer, proportionally dearer checkpoints, and the spend
// comes out flat. What moves it is less world traffic reaching the window at all.
export const DEFAULT_COMPACT_AT = 50_000;
export const DEFAULT_KEEP_RECENT = 20_000; // est. tokens a checkpoint leaves uncovered
export const DEFAULT_WINDOW_LIMIT = 500; // history query cap — the size guard (§5)
export const DEFAULT_MIRROR_SETTLE_MS = 1_000; // echo settle before fan-in copies (§4)
export const DEFAULT_MIRROR_CLAIM_MS = 60_000; // unclaimed-CC search window (§4)
export const DEFAULT_DEBOUNCE_MS = 5_000; // a world trigger waits this long for its burst (§2)
// The tick is not a knob. It is the RESOLUTION of the attention rules, not one of them:
// `digestMinutes` says when the agent looks, and the tick only decides how late that look
// may land. At a minute the promise is kept to the minute; raise it and every interval in
// the catalog silently means "give or take a tick". A poke that finds nothing owed costs
// one window read and no model call, so there is nothing to buy by making it rarer.
export const TICK_MS = 60_000;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export const ACTIONS: readonly PolicyAction[] = ["allow", "ask", "deny"];

/* ── the shape the reader returns ────────────────────────────────────────── */

export interface OrgConfig {
  organization: {
    backlogHours: number;
  };
  agent: {
    model: string;
    effort: Effort | null; // null ⇒ the model decides
    maxTokens: number;
    provider: string | null; // the transport seam; null ⇒ Anthropic
    timezone: string; // IANA; every rendered stamp formats through it (§5)
    locale: string | null; // parked until the i18n seam
    tools: string[] | null; // the tools offered to the model, by name; null ⇒ all of them
    rules: Rule[]; // permission policy as data (§9)
    engagedMinutes: number; // attention (§2): how long the agent's own last word keeps
    digestAfterMessages: number; //   a conversation hot · the ambient pile that forces a
    digestMinutes: number; //   wake · the ambient look interval
    sleepHours: string | null; // org-clock span "23-8"; null ⇒ never sleeps
  };
  processors: {
    /** Shell command: audio bytes on stdin → transcript text on stdout (non-zero exit =
     *  no transcript). null ⇒ voice notes stay untranscribed. The command IS the plugin
     *  interface — the repo ships `processors/qwen-asr/` as one implementation. */
    audio: string | null;
  };
  /** The connectors' subsections, one per connector, OPAQUE here: each connector's own
   *  `config.ts` declares, heals, and validates its subsection (`ensureConnectorConfig`);
   *  main only preserves what it does not know. */
  connections: Record<string, Record<string, unknown>>;
  system: {
    stopTimeoutMs: number;
    bashTimeoutMs: number;
    lockTtlMs: number;
    retryDelaysMs: number[];
    compactAt: number;
    keepRecent: number;
    windowLimit: number;
    mirrorSettleMs: number;
    mirrorClaimMs: number;
    debounceMs: number;
  };
}

/** An agent's file: the `agent` section again — its values for the same keys — plus the
 *  handles a human knows it by. Everything else about the agent is discovered (connect
 *  flows) or derived (the folder). */
export interface AgentOverrides {
  agent?: Partial<OrgConfig["agent"]>;
  identity?: { email?: string; phone?: string };
}

/* ── the catalog: key + default + the comment the file carries ───────────── */

type Section = keyof OrgConfig;
interface Entry {
  key: string;
  value: unknown;
  doc: string;
}

/** Common boot checks for connector entries. */
export const checkPort = (v: unknown): string | null =>
  Number.isInteger(v) && (v as number) > 0 && (v as number) < 65536
    ? null
    : "must be a port (1-65535)";
export const checkStrings = (v: unknown): string | null =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s)
    ? null
    : "must be a non-empty array of non-empty strings";

/** A connector's catalog — the same shape the harness catalog has, scoped to ONE
 *  `connections.<name>` subsection. Declared in the connector's own `config.ts`. */
export interface ConnectorSpec {
  name: string; // the subsection: connections.<name>
  doc: string; // the subsection's comment in the file
  entries: (Entry & {
    /** Boot validation: a complaint ("must be …") or null when the value is fine. */
    check?: (v: unknown) => string | null;
  })[];
}

const CATALOG: { section: Section; doc: string; entries: Entry[] }[] = [
  {
    section: "organization",
    doc: "org-wide facts — set here and nowhere else",
    entries: [
      {
        key: "backlogHours",
        value: DEFAULT_BACKLOG_HOURS,
        doc: "backlog an agent inherits at boot; lower it to come up quietly",
      },
    ],
  },
  {
    section: "agent",
    doc: "every agent's defaults — an agent's config.jsonc re-declares this section, key by key",
    entries: [
      { key: "model", value: DEFAULT_MODEL, doc: "the model an agent runs on" },
      {
        key: "effort",
        value: null,
        doc: `reasoning effort (${EFFORTS.join("|")}); null ⇒ the model decides`,
      },
      { key: "maxTokens", value: DEFAULT_MAX_TOKENS, doc: "output cap per model call" },
      {
        key: "provider",
        value: null,
        doc: "model provider (the transport seam); null ⇒ Anthropic",
      },
      {
        key: "timezone",
        value: DEFAULT_TIMEZONE,
        doc: "IANA zone every rendered stamp formats through",
      },
      { key: "locale", value: null, doc: "parked until the i18n seam — render is English for now" },
      {
        key: "tools",
        value: DEFAULT_TOOLS,
        doc: "the tools offered to the model, by name — built-ins and exec tools (bash, MCP) " +
          'alike; null ⇒ every tool the deployment has. A coding-agent deployment drops "send"',
      },
      {
        key: "rules",
        value: DEFAULT_RULES,
        doc: "permission policy: first match decides (allow|ask|deny); * matches any tool; " +
          "connection/conversation pin a rule to where a send lands",
      },
      {
        key: "engagedMinutes",
        value: DEFAULT_ENGAGED_MINUTES,
        doc: "attention: a conversation stays hot this long after the agent's own last word",
      },
      {
        key: "digestAfterMessages",
        value: DEFAULT_DIGEST_AFTER_MESSAGES,
        doc: "attention: an ambient pile this deep wakes the agent before the interval does",
      },
      {
        key: "digestMinutes",
        value: DEFAULT_DIGEST_MINUTES,
        doc: "attention: how often ambient conversations are looked at — the idle cadence",
      },
      {
        key: "sleepHours",
        value: DEFAULT_SLEEP_HOURS,
        doc: 'attention: org-clock span "from-to" the ambient world waits out; null ⇒ never sleeps',
      },
    ],
  },
  {
    section: "processors",
    doc: "media processors — broker-side commands that derive text from bytes (§5)",
    entries: [
      {
        key: "audio",
        value: null,
        doc: 'shell command, audio bytes on stdin → transcript on stdout — e.g. "processors/' +
          'qwen-asr/transcribe.sh" (repo-relative; see its README); null ⇒ no transcription',
      },
    ],
  },
  {
    section: "system",
    doc: "harness machinery — rarely touched",
    entries: [
      {
        key: "stopTimeoutMs",
        value: DEFAULT_STOP_TIMEOUT_MS,
        doc: "cap on stop() awaiting an in-flight turn",
      },
      {
        key: "bashTimeoutMs",
        value: DEFAULT_BASH_TIMEOUT_MS,
        doc: "a bash call's wall cap unless the model asks for another",
      },
      {
        key: "lockTtlMs",
        value: DEFAULT_LOCK_TTL_MS,
        doc: "turn-lease TTL; an older lease is stolen (the crash signal)",
      },
      {
        key: "retryDelaysMs",
        value: DEFAULT_RETRY_DELAYS_MS,
        doc: "slow outer retries after the SDK's own fast ones",
      },
      {
        key: "compactAt",
        value: DEFAULT_COMPACT_AT,
        doc: "est. tokens of raw event JSON (~1.8x the prompt) before a checkpoint runs",
      },
      {
        key: "keepRecent",
        value: DEFAULT_KEEP_RECENT,
        doc: "est. tokens a checkpoint leaves uncovered",
      },
      {
        key: "windowLimit",
        value: DEFAULT_WINDOW_LIMIT,
        doc: "history query cap — the prompt's size guard",
      },
      {
        key: "mirrorSettleMs",
        value: DEFAULT_MIRROR_SETTLE_MS,
        doc: "echo settle before the mirror's fan-in copies",
      },
      {
        key: "mirrorClaimMs",
        value: DEFAULT_MIRROR_CLAIM_MS,
        doc: "how far back an echo may claim an unclaimed CC",
      },
      {
        key: "debounceMs",
        value: DEFAULT_DEBOUNCE_MS,
        doc: "how long a world message waits for the rest of its burst before a turn runs",
      },
    ],
  },
];

function defaults(): OrgConfig {
  const cfg = {} as Record<Section, Record<string, unknown>>;
  for (const { section, entries } of CATALOG) {
    cfg[section] = Object.fromEntries(entries.map((e) => [e.key, e.value]));
  }
  cfg.connections = {};
  return cfg as unknown as OrgConfig;
}

/** A connector subsection's comments as the file already carries them: the lines above the
 *  subsection, and above each of its keys. Harvested so a writer that knows only ONE spec
 *  still rewrites the others' annotations instead of stripping them. */
type Notes = Record<string, { doc: string[]; keys: Record<string, string[]> }>;

/** Read back the `connections` comments from the file on disk. Line-oriented on purpose:
 *  the parser drops comments, and the only text we must reproduce is the `//` runs the
 *  writer itself emitted. Anything it cannot place (a key whose value spans lines, say)
 *  simply keeps no note — never an error, the file is the user's to shape. */
function harvest(raw: string): Notes {
  const notes: Notes = {};
  let depth = 0, inConnections = false, section: string | null = null;
  let pending: string[] = [];
  for (const line of raw.split("\n")) {
    const text = line.trim();
    if (text.startsWith("//")) {
      pending.push(text.slice(2).trim());
      continue;
    }
    const open = text.match(/^"([^"]+)"\s*:\s*\{/);
    if (depth === 1 && open?.[1] === "connections") inConnections = true;
    else if (inConnections && depth === 2 && open) {
      section = open[1];
      notes[section] = { doc: pending, keys: {} };
    } else if (section && depth === 3) {
      const key = text.match(/^"([^"]+)"\s*:/)?.[1];
      if (key && pending.length > 0) notes[section].keys[key] = pending;
    }
    depth += (text.match(/\{/g)?.length ?? 0) - (text.match(/\}/g)?.length ?? 0);
    if (depth <= 2) section = null;
    if (depth <= 1) inConnections = false;
    pending = [];
  }
  return notes;
}

/** Render the file: the user's values (or the defaults), the catalog's comments. The
 *  `connections` subsections re-emit verbatim — with THEIR catalog's comments when the
 *  writer knows it (`known`, the healing connector's spec), else with the comments the
 *  file already had (`notes`), so one connector's heal never strips another's. */
function materialize(
  cfg: OrgConfig,
  known: Record<string, ConnectorSpec> = {},
  notes: Notes = {},
): string {
  const lines: string[] = [
    "// config.jsonc — every harness knob (the catalog, DESIGN §9).",
    "// Values are yours to edit; when the catalog grows the file is regenerated with the",
    "// missing keys appended — your values survive, these comments are the catalog's.",
    "{",
  ];
  CATALOG.forEach(({ section, doc, entries }) => {
    lines.push(`  // ${doc}`);
    lines.push(`  "${section}": {`);
    entries.forEach((e, j) => {
      const value = (cfg[section] as Record<string, unknown>)[e.key];
      const comma = j < entries.length - 1 ? "," : "";
      lines.push(`    // ${e.doc}`);
      lines.push(`    "${e.key}": ${JSON.stringify(value)}${comma}`);
    });
    lines.push(`  },`);
  });
  lines.push("  // the connectors' knobs — each connector heals its own subsection (§4)");
  lines.push(`  "connections": {`);
  const names = Object.keys(cfg.connections);
  names.forEach((name, i) => {
    const body = cfg.connections[name];
    const spec = known[name];
    const note = notes[name];
    for (const doc of spec ? [spec.doc] : note?.doc ?? []) lines.push(`    // ${doc}`);
    lines.push(`    "${name}": {`);
    const keys = spec ? spec.entries.map((e) => e.key) : Object.keys(body);
    keys.forEach((key, j) => {
      const entry = spec?.entries.find((e) => e.key === key)?.doc;
      for (const doc of entry ? [entry] : note?.keys[key] ?? []) lines.push(`      // ${doc}`);
      lines.push(`      "${key}": ${JSON.stringify(body[key])}${j < keys.length - 1 ? "," : ""}`);
    });
    lines.push(`    }${i < names.length - 1 ? "," : ""}`);
  });
  lines.push("  }", "}", "");
  return lines.join("\n");
}

/* ── the readers (main only) ─────────────────────────────────────────────── */

/** Read `<dir>/config.jsonc`, materializing or healing it so the file always exposes the
 *  whole catalog. Unknown key or section ⇒ boot error; `connections` subsections are the
 *  connectors' and pass through opaque (each connector validates its own). */
export async function ensureOrgConfig(dir: string): Promise<OrgConfig> {
  await rejectLegacy(`${dir}/org/config.jsonc`, `${dir}/config.jsonc`);
  const path = `${dir}/config.jsonc`;
  let raw: string | null = null;
  try {
    raw = await Deno.readTextFile(path);
  } catch { /* absent — materialize below */ }
  if (raw === null) {
    const cfg = defaults();
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(path, materialize(cfg));
    return cfg;
  }
  const found = parseStrict(raw, path) as Record<string, Record<string, unknown>>;
  for (const section of Object.keys(found)) {
    if (section !== "connections" && !CATALOG.some((c) => c.section === section)) {
      throw new Error(`${path}: unknown section "${section}"`);
    }
  }
  const missing: string[] = [];
  const merged = {} as Record<Section, Record<string, unknown>>;
  for (const { section, entries } of CATALOG) {
    const given = found[section] ?? {};
    for (const key of Object.keys(given)) {
      if (!entries.some((e) => e.key === key)) {
        throw new Error(`${path}: unknown key "${section}.${key}"`);
      }
    }
    merged[section] = Object.fromEntries(entries.map((e) => {
      if (!(e.key in given)) missing.push(`${section}.${e.key}`);
      return [e.key, e.key in given ? given[e.key] : e.value];
    }));
  }
  const connections = found.connections ?? {};
  for (const [name, body] of Object.entries(connections)) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error(
        `${path}: connections.${name} must be an object (a connector's subsection)`,
      );
    }
  }
  merged.connections = connections;
  const cfg = merged as unknown as OrgConfig;
  validateOrg(cfg, path);
  if (missing.length > 0) {
    await Deno.writeTextFile(path, materialize(cfg, {}, harvest(raw)));
    console.error(`[config] ${path}: appended ${missing.join(", ")} (the catalog grew)`);
  }
  return cfg;
}

/** A connector's reader: `ensureOrgConfig` first (the file exists, the harness sections
 *  hold), then its own subsection — unknown keys error, missing keys heal into the file
 *  with the spec's comments, `check`s run at boot. Returns the merged subsection. */
export async function ensureConnectorConfig<T extends object>(
  dir: string,
  spec: ConnectorSpec,
): Promise<T> {
  const path = `${dir}/config.jsonc`;
  const cfg = await ensureOrgConfig(dir);
  const given = cfg.connections[spec.name] ?? {};
  for (const key of Object.keys(given)) {
    if (!spec.entries.some((e) => e.key === key)) {
      throw new Error(`${path}: unknown key "connections.${spec.name}.${key}"`);
    }
  }
  const missing: string[] = [];
  const merged = Object.fromEntries(spec.entries.map((e) => {
    if (!(e.key in given)) missing.push(`connections.${spec.name}.${e.key}`);
    return [e.key, e.key in given ? given[e.key] : e.value];
  }));
  for (const e of spec.entries) {
    const complaint = e.check?.(merged[e.key]);
    if (complaint) {
      throw new Error(
        `${path}: connections.${spec.name}.${e.key} ${complaint} (got ` +
          `${JSON.stringify(merged[e.key])})`,
      );
    }
  }
  if (missing.length > 0) {
    cfg.connections[spec.name] = merged;
    // the file `ensureOrgConfig` just guaranteed — the other connectors' comments live there
    const notes = harvest(await Deno.readTextFile(path));
    await Deno.writeTextFile(path, materialize(cfg, { [spec.name]: spec }, notes));
    console.error(`[config] ${path}: appended ${missing.join(", ")} (the catalog grew)`);
  }
  return merged as unknown as T;
}

/** Read `agents/<id>/config.jsonc` — sparse: absent file ⇒ no overrides. A present file
 *  must parse and carry only known keys — a silent fallback would run the org on settings
 *  the human believes overridden. */
export async function readAgentOverrides(dir: string, agentId: string): Promise<AgentOverrides> {
  const path = `${dir}/agents/${agentId}/config.jsonc`;
  await rejectLegacy(`${dir}/agents/${agentId}/config.json`, path);
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch {
    return {};
  }
  const found = parseStrict(raw, path) as Record<string, Record<string, unknown>>;
  const agent = CATALOG.find((c) => c.section === "agent")!;
  for (const [section, body] of Object.entries(found)) {
    if (section === "agent") {
      for (const key of Object.keys(body)) {
        if (!agent.entries.some((e) => e.key === key)) {
          throw new Error(`${path}: unknown key "agent.${key}"`);
        }
      }
    } else if (section === "identity") {
      for (const key of Object.keys(body)) {
        if (key !== "email" && key !== "phone") {
          throw new Error(`${path}: unknown key "identity.${key}"`);
        }
      }
    } else if (section === "organization") {
      throw new Error(
        `${path}: an agent overrides under "agent" — org-wide facts have no ` +
          `per-agent seat`,
      );
    } else throw new Error(`${path}: unknown section "${section}"`);
  }
  const cfg = found as AgentOverrides;
  if (cfg.agent) validateAgent(cfg.agent, path);
  return cfg;
}

function parseStrict(raw: string, path: string): unknown {
  try {
    const v = parse(raw);
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new Error("an object was expected");
    }
    return v;
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : err}`);
  }
}

function validateOrg(cfg: OrgConfig, path: string): void {
  if (!(cfg.organization.backlogHours > 0)) {
    throw new Error(
      `${path}: backlogHours must be a positive number (got ${cfg.organization.backlogHours})`,
    );
  }
  if (cfg.processors.audio !== null && typeof cfg.processors.audio !== "string") {
    throw new Error(
      `${path}: processors.audio must be a shell command string, or null (got ` +
        `${JSON.stringify(cfg.processors.audio)})`,
    );
  }
  validateAgent(cfg.agent, path);
}

/** The checks that would otherwise surface as a RangeError inside a turn's render or as an
 *  API rejection mid-conversation — discovered at boot instead. */
function validateAgent(a: Partial<OrgConfig["agent"]>, path: string): void {
  if (a.effort != null && !(EFFORTS as readonly string[]).includes(a.effort)) {
    throw new Error(`${path}: unknown effort "${a.effort}" (one of ${EFFORTS.join(", ")})`);
  }
  if (a.timezone != null) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: a.timezone });
    } catch {
      throw new Error(`${path}: unknown timezone "${a.timezone}" (IANA name expected)`);
    }
  }
  if (a.tools != null) {
    const ok = Array.isArray(a.tools) &&
      (a.tools as unknown[]).every((t) => typeof t === "string" && t !== "");
    if (!ok) {
      throw new Error(`${path}: tools must be an array of tool names, or null (⇒ all)`);
    }
  }
  if (a.rules != null) {
    for (const r of a.rules as unknown[]) {
      const rule = r as Record<string, unknown>;
      if (typeof rule !== "object" || rule === null || typeof rule.tool !== "string") {
        throw new Error(`${path}: a rule needs a "tool" (a name, or *)`);
      }
      if ("ask" in rule) {
        throw new Error(
          `${path}: rules carry "action" (${ACTIONS.join("|")}) now — ` +
            `{"tool":"${rule.tool}","ask":${rule.ask}} becomes ` +
            `{"tool":"${rule.tool}","action":"${rule.ask ? "ask" : "allow"}"}`,
        );
      }
      if (!ACTIONS.includes(rule.action as PolicyAction)) {
        throw new Error(
          `${path}: rule "${rule.tool}": unknown action "${rule.action}" ` +
            `(one of ${ACTIONS.join(", ")})`,
        );
      }
      for (const key of Object.keys(rule)) {
        if (!["tool", "action", "connection", "conversation"].includes(key)) {
          throw new Error(`${path}: rule "${rule.tool}": unknown field "${key}"`);
        }
      }
    }
  }
  if (a.sleepHours != null && !/^\d{1,2}-\d{1,2}$/.test(a.sleepHours)) {
    throw new Error(
      `${path}: sleepHours "${a.sleepHours}" — an org-clock span like "23-8" expected`,
    );
  }
  for (
    const [key, v] of [
      ["engagedMinutes", a.engagedMinutes],
      ["digestAfterMessages", a.digestAfterMessages],
      ["digestMinutes", a.digestMinutes],
    ] as const
  ) {
    if (v != null && !(v > 0)) {
      throw new Error(`${path}: ${key} must be a positive number (got ${v})`);
    }
  }
}

/** The catalog moved (org/config.jsonc → config.jsonc — data/ is the org's root). */
async function rejectLegacy(path: string, target: string): Promise<void> {
  try {
    await Deno.lstat(path);
  } catch {
    return;
  }
  throw new Error(
    `${path}: the catalog lives in ${target} now — move your values there and delete ` +
      `this file`,
  );
}
