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
 *   · `org/config.jsonc` always exposes the whole catalog. Absent, it is materialized from
 *     the constants; when the catalog grows, the missing keys are appended (values you set
 *     survive — the comments are the catalog's). An unknown key is a boot error: a typo
 *     must not run silently. Agent files are sparse — only what they override, plus the
 *     declared identity handles.
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
export const DEFAULT_RULES: Rule[] = [
  { tool: "send", action: "ask" }, // dispatch leaves the org, in the principal's name
  { tool: "*", action: "allow" },
];
// attention (§2): a summons wakes NOW; an engaged conversation wakes NOW; ambient piles
// wake on the digest clock — reacting to every world message with a model turn is waste.
// The digest carries the WHOLE world now that the summons is the mind alias alone, so its
// interval sets the agent's idle cadence outright: measured against live traffic, five
// minutes meant a turn every nine, and more than half of them said "nothing new".
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

// connections — knobs the standalone connector services read
export const DEFAULT_GOOGLE_CALENDARS = ["primary"];

// system — harness machinery
export const DEFAULT_STOP_TIMEOUT_MS = 5_000; // cap on stop() awaiting an in-flight turn
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
export const DEFAULT_TICK_MS = 60_000; // the clock poke — how often an idle agent re-looks
export const DEFAULT_SETTLE_MS = 5_000; // a world trigger waits this long for its burst (§2)

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
  connections: {
    /** Calendars the google poll watches on every grant; `primary` is the account's own. */
    googleCalendars: string[];
  };
  system: {
    stopTimeoutMs: number;
    lockTtlMs: number;
    retryDelaysMs: number[];
    compactAt: number;
    keepRecent: number;
    windowLimit: number;
    mirrorSettleMs: number;
    mirrorClaimMs: number;
    tickMs: number;
    settleMs: number;
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
    section: "connections",
    doc: "knobs the standalone connector services read (each reads its own, §4)",
    entries: [
      {
        key: "googleCalendars",
        value: DEFAULT_GOOGLE_CALENDARS,
        doc: 'calendars the google poll watches on every grant; "primary" = the account\'s own',
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
        key: "tickMs",
        value: DEFAULT_TICK_MS,
        doc: "the clock poke — how often an idle agent re-looks (the digest's metronome)",
      },
      {
        key: "settleMs",
        value: DEFAULT_SETTLE_MS,
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
  return cfg as unknown as OrgConfig;
}

/** Render the file: the user's values (or the defaults), the catalog's comments. */
function materialize(cfg: OrgConfig): string {
  const lines: string[] = [
    "// org/config.jsonc — every harness knob (the catalog, DESIGN §9).",
    "// Values are yours to edit; when the catalog grows the file is regenerated with the",
    "// missing keys appended — your values survive, these comments are the catalog's.",
    "{",
  ];
  CATALOG.forEach(({ section, doc, entries }, i) => {
    lines.push(`  // ${doc}`);
    lines.push(`  "${section}": {`);
    entries.forEach((e, j) => {
      const value = (cfg[section] as Record<string, unknown>)[e.key];
      const comma = j < entries.length - 1 ? "," : "";
      lines.push(`    // ${e.doc}`);
      lines.push(`    "${e.key}": ${JSON.stringify(value)}${comma}`);
    });
    lines.push(`  }${i < CATALOG.length - 1 ? "," : ""}`);
  });
  lines.push("}", "");
  return lines.join("\n");
}

/* ── the readers (main only) ─────────────────────────────────────────────── */

/** Read `org/config.jsonc`, materializing or healing it so the file always exposes the
 *  whole catalog. Unknown key or section ⇒ boot error. */
export async function ensureOrgConfig(dir: string): Promise<OrgConfig> {
  await rejectLegacy(`${dir}/org/config.json`);
  const path = `${dir}/org/config.jsonc`;
  let raw: string | null = null;
  try {
    raw = await Deno.readTextFile(path);
  } catch { /* absent — materialize below */ }
  if (raw === null) {
    const cfg = defaults();
    await Deno.mkdir(`${dir}/org`, { recursive: true });
    await Deno.writeTextFile(path, materialize(cfg));
    return cfg;
  }
  const found = parseStrict(raw, path) as Record<string, Record<string, unknown>>;
  for (const section of Object.keys(found)) {
    if (!CATALOG.some((c) => c.section === section)) {
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
  const cfg = merged as unknown as OrgConfig;
  validateOrg(cfg, path);
  if (missing.length > 0) {
    await Deno.writeTextFile(path, materialize(cfg));
    console.error(`[config] ${path}: appended ${missing.join(", ")} (the catalog grew)`);
  }
  return cfg;
}

/** Read `agents/<id>/config.jsonc` — sparse: absent file ⇒ no overrides. A present file
 *  must parse and carry only known keys — a silent fallback would run the org on settings
 *  the human believes overridden. */
export async function readAgentOverrides(dir: string, agentId: string): Promise<AgentOverrides> {
  await rejectLegacy(`${dir}/agents/${agentId}/config.json`);
  const path = `${dir}/agents/${agentId}/config.jsonc`;
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
  const cals = cfg.connections.googleCalendars;
  if (!Array.isArray(cals) || cals.length === 0 || cals.some((c) => typeof c !== "string" || !c)) {
    throw new Error(
      `${path}: connections.googleCalendars must be a non-empty array of calendar ids (got ` +
        `${JSON.stringify(cals)})`,
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

/** The catalog moved: config is `.jsonc` with sections. */
async function rejectLegacy(path: string): Promise<void> {
  try {
    await Deno.lstat(path);
  } catch {
    return;
  }
  throw new Error(
    `${path}: the catalog lives in ${path}c now (sections "organization"/"agent"/"system", ` +
      `comments allowed) — move your values there and delete this file`,
  );
}
