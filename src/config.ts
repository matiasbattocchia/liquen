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
 *     `organization`: globals any agent is likely to customize · `system`: harness
 *     machinery — while the value still funnels to the deepest function that needs it.
 *   · `org/config.jsonc` always exposes the whole catalog. Absent, it is materialized from
 *     the constants; when the catalog grows, the missing keys are appended (values you set
 *     survive — the comments are the catalog's). An unknown key is a boot error: a typo
 *     must not run silently. Agent files are sparse — only what they override, plus the
 *     declared identity handles.
 *   · env is for secrets (`ANTHROPIC_API_KEY`) and for pointing a standalone connector
 *     process at its org (`MU_DIR`); everything else lives in the file. Session choices
 *     (which agent a REPL faces) are CLI arguments — per-invocation by nature, no seat in
 *     either file.
 */

import { parse } from "@std/jsonc";
import type { Effort, Rule } from "./types.ts";

/* ── the defaults: the single source ─────────────────────────────────────── */

// organization — globals any agent is likely to customize
export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_MAX_TOKENS = 64_000; // streaming — room for thinking + tools + text
export const DEFAULT_TIMEZONE = "UTC"; // explicit, so two boxes render the same stamps
export const DEFAULT_BACKLOG_HOURS = 24;
export const DEFAULT_RULES: Rule[] = [
  { tool: "send", ask: true }, // dispatch leaves the org and speaks in the principal's name
  { tool: "*", ask: false },
];

// system — harness machinery
export const DEFAULT_STOP_TIMEOUT_MS = 5_000; // cap on stop() awaiting an in-flight turn
export const DEFAULT_LOCK_TTL_MS = 120_000; // a turn lease older than this is STOLEN
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 20_000]; // slow outer retries (§2)
export const DEFAULT_COMPACT_AT = 150_000; // est. tokens — matches the API's own trigger
export const DEFAULT_KEEP_RECENT = 20_000; // est. tokens a checkpoint leaves uncovered
export const DEFAULT_WINDOW_LIMIT = 500; // history query cap — the size guard (§5)
export const DEFAULT_MIRROR_SETTLE_MS = 1_000; // echo settle before fan-in copies (§4)
export const DEFAULT_MIRROR_CLAIM_MS = 60_000; // unclaimed-CC search window (§4)

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/* ── the shape the reader returns ────────────────────────────────────────── */

export interface OrgConfig {
  organization: {
    model: string;
    effort: Effort | null; // null ⇒ the model decides
    maxTokens: number;
    provider: string | null; // the transport seam; null ⇒ Anthropic
    timezone: string; // IANA; every rendered stamp formats through it (§5)
    locale: string | null; // parked until the i18n seam
    backlogHours: number;
    rules: Rule[]; // permission policy as data (§9)
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
  };
}

/** An agent's file: overrides of organization keys, plus the handles a human knows it by.
 *  Everything else about the agent is discovered (connect flows) or derived (the folder). */
export interface AgentOverrides {
  organization?: Partial<OrgConfig["organization"]>;
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
    doc: "globals any agent is likely to customize (agent config.jsonc overrides, key by key)",
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
        key: "backlogHours",
        value: DEFAULT_BACKLOG_HOURS,
        doc: "backlog an agent inherits at boot; lower it to come up quietly",
      },
      {
        key: "rules",
        value: DEFAULT_RULES,
        doc: "permission policy: first matching tool decides, * matches anything",
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
        doc: "est. tokens before a checkpoint displaces the turn",
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
  const org = CATALOG.find((c) => c.section === "organization")!;
  for (const [section, body] of Object.entries(found)) {
    if (section === "organization") {
      for (const key of Object.keys(body)) {
        if (!org.entries.some((e) => e.key === key)) {
          throw new Error(`${path}: unknown key "organization.${key}"`);
        }
      }
    } else if (section === "identity") {
      for (const key of Object.keys(body)) {
        if (key !== "email" && key !== "phone") {
          throw new Error(`${path}: unknown key "identity.${key}"`);
        }
      }
    } else throw new Error(`${path}: unknown section "${section}"`);
  }
  const cfg = found as AgentOverrides;
  if (cfg.organization) validateOrganization(cfg.organization, path);
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
  validateOrganization(cfg.organization, path);
}

/** The checks that would otherwise surface as a RangeError inside a turn's render or as an
 *  API rejection mid-conversation — discovered at boot instead. */
function validateOrganization(
  o: Partial<OrgConfig["organization"]>,
  path: string,
): void {
  if (o.effort != null && !(EFFORTS as readonly string[]).includes(o.effort)) {
    throw new Error(`${path}: unknown effort "${o.effort}" (one of ${EFFORTS.join(", ")})`);
  }
  if (o.timezone != null) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: o.timezone });
    } catch {
      throw new Error(`${path}: unknown timezone "${o.timezone}" (IANA name expected)`);
    }
  }
  if (o.backlogHours != null && !(o.backlogHours > 0)) {
    throw new Error(`${path}: backlogHours must be a positive number (got ${o.backlogHours})`);
  }
}

/** The catalog moved: config is `.jsonc` with `organization`/`system` sections. */
async function rejectLegacy(path: string): Promise<void> {
  try {
    await Deno.lstat(path);
  } catch {
    return;
  }
  throw new Error(
    `${path}: the catalog lives in ${path}c now (sections "organization"/"system", ` +
      `comments allowed) — move your values there and delete this file`,
  );
}
