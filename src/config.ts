/**
 * config.ts — the catalog (DESIGN §9): every harness knob, its default, one file exposing
 * them all.
 *
 * The standing rules:
 *
 *   · ONE file, `config.jsonc`, at the PROJECT ROOT — above `data/`, git-tracked, deployed
 *     with the image. The file is the project marker: `findRoot` walks up from cwd the way
 *     git finds `.git`, and everything else (`data/`, the connectors, the processors) is
 *     addressed from the root it lands on.
 *   · The file is a DECLARATION, and only the setup doors write it: `mu init` materializes
 *     it, `mu connect` declares the connection a grant just earned (`declareConnection`).
 *     Both are human-time acts with a human watching, and both leave a diff for git, which
 *     is the file's only history. The RUNNING system never writes it: boot compiles it —
 *     the `agents` section becomes registry rows and home folders, `connections`
 *     subsections configure the connector processes, the rest funnels down the chain
 *     (main → xi → nu → mu) — and what a turn learns (grants, discovered handles,
 *     verdicts) lives in log.db tables, never here.
 *   · `mu init` materializes the whole catalog with these comments, so every knob is in
 *     view. A key left out takes the default defined HERE (the file may be sparse); an
 *     unknown key or section is a boot error — a typo must not run silently.
 *   · Placement is by audience. `system`: machinery tuning — every deployment works on the
 *     defaults. `org`: this deployment's identity — the clock, the backlog, and under
 *     `org.agent` the defaults every agent inherits. `agents.<name>`: the roster — each
 *     entry overrides `org.agent` key by key and may declare the handles a human knows the
 *     agent by. `connections.<name>` belongs to the connectors: each ships its own
 *     `config.ts` (its DEFAULT_s, the same rules) and validates ITS subsection.
 *   · `start` / `xi` / `nu` / `mu` are 100% parametrized — values arrive as arguments,
 *     never from the environment. Argument defaults are ergonomics for direct callers
 *     (tests); they are the named constants defined here, the single source.
 *   · env is for secrets only (tokens the services hold; `ANTHROPIC_API_KEY` belongs to
 *     the SDK's own credential chain, not to us). The org lives where its config.jsonc
 *     lives — cwd selects it, no variable does. Session choices (which agent a REPL faces)
 *     are CLI arguments — per-invocation by nature, no seat in the file.
 */

import { parse } from "@std/jsonc";
import type { Effort, PolicyAction, Rule } from "./types.ts";

/* ── the defaults: the single source ─────────────────────────────────────── */

// org — this deployment's identity
export const DEFAULT_BACKLOG_HOURS = 24;
export const DEFAULT_TIMEZONE = "UTC"; // explicit, so two boxes render the same stamps

// org.agent — every agent's defaults (an `agents.<name>` entry re-declares these, key by key)
export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_MAX_TOKENS = 64_000; // streaming — room for thinking + tools + text
// the default deployment's whole offer: the four built-ins plus the exec plane's bash.
// A name added at runtime (an MCP server's tools) joins the offer by being listed here.
export const DEFAULT_TOOLS = ["search", "schedule", "cancel", "bash"];
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
// The shutdown grace: how long a stop that was ASKED FOR waits for work already running —
// main draining its in-flight turns, the supervisor draining its children. Not a knob, for
// the same reason the tick isn't: it only ever binds when something is wedged, and a wedged
// turn does not finish because it was given longer. A healthy stop completes in milliseconds
// and never reads this number at all, so there is nothing to buy by moving it — while
// raising it past an orchestrator's own kill deadline would quietly turn every graceful
// stop into a hard one.
export const STOP_TIMEOUT_MS = 5_000;
export const DEFAULT_BASH_TIMEOUT_MS = 120_000; // a bash call's cap unless the model asks
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

/** The keys every agent resolves — `org.agent` declares the org's values, an
 *  `agents.<name>` entry re-declares them for one agent. */
export interface AgentDefaults {
  model: string;
  effort: Effort | null; // null ⇒ the model decides
  maxTokens: number;
  provider: string | null; // the transport seam; null ⇒ Anthropic
  tools: string[] | null; // the tools offered to the model, by name; null ⇒ all of them
  rules: Rule[]; // permission policy as data (§9)
  engagedMinutes: number; // attention (§2): how long the agent's own last word keeps
  digestAfterMessages: number; //   a conversation hot · the ambient pile that forces a
  digestMinutes: number; //   wake · the ambient look interval
  sleepHours: string | null; // org-clock span "23-8"; null ⇒ never sleeps
}

/** One roster entry: overrides of `org.agent`, key by key, plus the handles a human knows
 *  the agent by (ingest's sender → principal classification). Everything else about the
 *  agent is discovered (connect flows) or derived (the home folder). */
export interface AgentEntry extends Partial<AgentDefaults> {
  identity?: { email?: string; phone?: string };
}

export interface OrgConfig {
  system: {
    bashTimeoutMs: number;
    compactAt: number;
    keepRecent: number;
    windowLimit: number;
    debounceMs: number;
  };
  org: {
    timezone: string; // the ORG's clock — every stamp, cron and sleep span reads it (§5)
    locale: string | null; // parked until the i18n seam
    backlogHours: number;
    agent: AgentDefaults;
  };
  processors: {
    /** Shell command: audio bytes on stdin → transcript text on stdout (non-zero exit =
     *  no transcript). null ⇒ voice notes stay untranscribed. The command IS the plugin
     *  interface — the repo ships `processors/qwen-asr/` as one implementation. */
    audio: string | null;
  };
  /** The roster: every key under `agents` IS an agent — boot compiles the entries into
   *  registry rows and creates the missing home folders (§9). The name is the agent's id,
   *  its folder under `data/agents/`, and its Linux user in the container. */
  agents: Record<string, AgentEntry>;
  /** The connectors' subsections, one per connector, OPAQUE here: each connector's own
   *  `config.ts` declares and validates its subsection (`connectorConfig`). */
  connections: Record<string, Record<string, unknown>>;
}

/* ── the catalog: key + default + the comment the file carries ───────────── */

interface Entry {
  key: string;
  value: unknown;
  doc: string;
}

/** Common boot checks for connector entries. */
export const checkPort = (v: unknown): string | null =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) < 65536
    ? null
    : "must be a port (1-65535, or 0: bind a free one and announce it)";
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

const SYSTEM: Entry[] = [
  {
    key: "bashTimeoutMs",
    value: DEFAULT_BASH_TIMEOUT_MS,
    doc: "a bash call's wall cap unless the model asks for another",
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
    key: "debounceMs",
    value: DEFAULT_DEBOUNCE_MS,
    doc: "how long a world message waits for the rest of its burst before a turn runs",
  },
];

const ORG: Entry[] = [
  {
    key: "timezone",
    value: DEFAULT_TIMEZONE,
    doc: "the org's clock (IANA) — every rendered stamp, cron and sleep span reads it",
  },
  { key: "locale", value: null, doc: "parked until the i18n seam — render is English for now" },
  {
    key: "backlogHours",
    value: DEFAULT_BACKLOG_HOURS,
    doc: "backlog an agent inherits at boot; lower it to come up quietly",
  },
];

const AGENT: Entry[] = [
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
    key: "tools",
    value: DEFAULT_TOOLS,
    doc: "the tools offered to the model, by name — built-ins and exec tools (bash, MCP) " +
      'alike; null ⇒ every tool the deployment has. Add "send" where the agent has peers ' +
      "or a world to write to — a reply to its own principal is its plain answer, never a call",
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
];

const PROCESSORS: Entry[] = [
  {
    key: "audio",
    value: null,
    doc: 'shell command, audio bytes on stdin → transcript on stdout — e.g. "processors/' +
      'qwen-asr/transcribe.sh" (root-relative; see its README); null ⇒ no transcription',
  },
];

const SECTION_DOCS: Record<string, string> = {
  system: "harness machinery — every deployment works on the defaults",
  org: "this deployment's identity — the clock, the backlog, and every agent's defaults",
  processors: "media processors — broker-side commands that derive text from bytes (§5)",
  agents: "the roster: every key is an agent — overrides of org.agent, plus declared handles",
  connections: "the connectors' knobs — a subsection per connector, validated by its owner",
};

/** An agent's name is also its folder and its Linux user in the container — the charset is
 *  the intersection of what all three accept. */
export const AGENT_NAME = /^[a-z][a-z0-9-]{0,30}$/;

function fromEntries(entries: Entry[]): Record<string, unknown> {
  return Object.fromEntries(entries.map((e) => [e.key, e.value]));
}

function defaults(): OrgConfig {
  return {
    system: fromEntries(SYSTEM),
    org: { ...fromEntries(ORG), agent: fromEntries(AGENT) },
    processors: fromEntries(PROCESSORS),
    agents: {},
    connections: {},
  } as unknown as OrgConfig;
}

/** Merge one section: the user's values over the entries' defaults; an unknown key is a
 *  boot error. `label` names the section in the complaint ("org.agent.model"). */
function mergeSection(
  given: Record<string, unknown>,
  entries: Entry[],
  path: string,
  label: string,
): Record<string, unknown> {
  for (const key of Object.keys(given)) {
    if (!entries.some((e) => e.key === key)) {
      throw new Error(`${path}: unknown key "${label}.${key}"`);
    }
  }
  return Object.fromEntries(
    entries.map((e) => [e.key, e.key in given ? given[e.key] : e.value]),
  );
}

/* ── the root ────────────────────────────────────────────────────────────── */

/** The org is WHERE YOU RUN mu: walk up from `from` to the nearest `config.jsonc` — the
 *  project marker, the way git finds `.git`. Everything is addressed from the root it
 *  names: the catalog at `<root>/config.jsonc`, the substrate at `<root>/data`. */
export function findRoot(from: string = Deno.cwd()): string {
  let dir = Deno.realPathSync(from);
  for (;;) {
    try {
      Deno.statSync(`${dir}/config.jsonc`);
      return dir;
    } catch { /* keep climbing */ }
    const parent = dir.replace(/\/[^/]+$/, "") || "/";
    if (parent === dir) {
      throw new Error(
        `not inside a mu project: no config.jsonc from ${from} up — \`mu init\` creates one`,
      );
    }
    dir = parent;
  }
}

/* ── the readers (main only) ─────────────────────────────────────────────── */

/** Read `<root>/config.jsonc` — and only read: the file is git's, never the system's to
 *  write. Absent file ⇒ the defaults (tests); a key left out takes its default;
 *  an unknown key or section is a boot error. `connections` subsections are the
 *  connectors' and pass through opaque (each connector validates its own). */
export async function readConfig(root: string): Promise<OrgConfig> {
  const path = `${root}/config.jsonc`;
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return defaults();
    throw err; // a file that exists and cannot be read is a boot error, not an empty org
  }
  const found = parseStrict(raw, path) as Record<string, unknown>;
  for (const section of Object.keys(found)) {
    if (!(section in SECTION_DOCS)) {
      throw new Error(`${path}: unknown section "${section}"`);
    }
  }
  const asObject = (v: unknown, label: string): Record<string, unknown> => {
    if (v === undefined) return {};
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new Error(`${path}: ${label} must be an object`);
    }
    return v as Record<string, unknown>;
  };
  const orgGiven = asObject(found.org, "org");
  const { agent: agentGiven, ...orgPlain } = orgGiven;
  const cfg = {
    system: mergeSection(asObject(found.system, "system"), SYSTEM, path, "system"),
    org: {
      ...mergeSection(orgPlain, ORG, path, "org"),
      agent: mergeSection(asObject(agentGiven, "org.agent"), AGENT, path, "org.agent"),
    },
    processors: mergeSection(
      asObject(found.processors, "processors"),
      PROCESSORS,
      path,
      "processors",
    ),
    agents: {} as Record<string, unknown>,
    connections: {} as Record<string, unknown>,
  };
  for (const [name, body] of Object.entries(asObject(found.agents, "agents"))) {
    if (!AGENT_NAME.test(name)) {
      throw new Error(
        `${path}: agents.${name} — a name is a folder and a unix user: ` +
          `lowercase letters, digits and dashes, starting with a letter`,
      );
    }
    const entry = asObject(body, `agents.${name}`);
    const { identity, ...over } = entry;
    mergeSection(over, AGENT, path, `agents.${name}`); // unknown keys error; values stay sparse
    for (const key of Object.keys(asObject(identity, `agents.${name}.identity`))) {
      if (key !== "email" && key !== "phone") {
        throw new Error(`${path}: unknown key "agents.${name}.identity.${key}"`);
      }
    }
    validateAgent(over as Partial<AgentDefaults>, `${path}: agents.${name}`);
    cfg.agents[name] = entry;
  }
  for (const [name, body] of Object.entries(asObject(found.connections, "connections"))) {
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      throw new Error(
        `${path}: connections.${name} must be an object (a connector's subsection)`,
      );
    }
    cfg.connections[name] = body;
  }
  const out = cfg as unknown as OrgConfig;
  validateOrg(out, path);
  return out;
}

/** A connector's reader: its subsection over its spec's defaults — unknown keys error,
 *  `check`s run at boot, and nothing is ever written back: what a connect flow discovers
 *  belongs in the tables, and a missing knob simply means its default. */
export async function connectorConfig<T extends object>(
  root: string,
  spec: ConnectorSpec,
): Promise<T> {
  const path = `${root}/config.jsonc`;
  const cfg = await readConfig(root);
  const merged = mergeSection(
    cfg.connections[spec.name] ?? {},
    spec.entries,
    path,
    `connections.${spec.name}`,
  );
  for (const e of spec.entries) {
    const complaint = e.check?.(merged[e.key]);
    if (complaint) {
      throw new Error(
        `${path}: connections.${spec.name}.${e.key} ${complaint} (got ` +
          `${JSON.stringify(merged[e.key])})`,
      );
    }
  }
  return merged as unknown as T;
}

/* ── the writers (the setup doors) ───────────────────────────────────────── */

/** Render the whole catalog with its comments — what `mu init` writes, once. From then on
 *  the file is the human's and git's, edited only where a door has something to declare
 *  (`declareConnection`); boot only reads it. */
export function materialize(cfg: OrgConfig, specs: ConnectorSpec[] = []): string {
  const lines: string[] = [
    "// config.jsonc — the org's declaration: every harness knob (the catalog, DESIGN §9).",
    "// Only the setup doors write it (`mu init` materializes it, `mu connect` declares the",
    "// connection it just earned) — git is its history, boot compiles it into the registry.",
    "// A key left out takes its default; an unknown key is a boot error.",
    "{",
  ];
  const emit = (indent: string, entries: Entry[], values: Record<string, unknown>, last = "") => {
    entries.forEach((e, j) => {
      lines.push(`${indent}// ${e.doc}`);
      const comma = j < entries.length - 1 ? "," : last;
      lines.push(`${indent}"${e.key}": ${JSON.stringify(values[e.key])}${comma}`);
    });
  };
  lines.push(`  // ${SECTION_DOCS.system}`, `  "system": {`);
  emit("    ", SYSTEM, cfg.system as unknown as Record<string, unknown>);
  lines.push("  },");
  lines.push(`  // ${SECTION_DOCS.org}`, `  "org": {`);
  emit("    ", ORG, cfg.org as unknown as Record<string, unknown>, ",");
  lines.push(
    `    // every agent's defaults — an agents.<name> entry re-declares these, key by key`,
  );
  lines.push(`    "agent": {`);
  emit("      ", AGENT, cfg.org.agent as unknown as Record<string, unknown>);
  lines.push("    }", "  },");
  lines.push(`  // ${SECTION_DOCS.processors}`, `  "processors": {`);
  emit("    ", PROCESSORS, cfg.processors as unknown as Record<string, unknown>);
  lines.push("  },");
  lines.push(`  // ${SECTION_DOCS.agents}`, `  "agents": {`);
  const agents = Object.entries(cfg.agents);
  agents.forEach(([name, entry], i) => {
    lines.push(`    "${name}": ${JSON.stringify(entry)}${i < agents.length - 1 ? "," : ""}`);
  });
  lines.push("  },");
  lines.push(`  // ${SECTION_DOCS.connections}`, `  "connections": {`);
  const known = Object.fromEntries(specs.map((s) => [s.name, s]));
  const names = Object.keys(cfg.connections);
  names.forEach((name, i) => {
    const body = cfg.connections[name];
    const spec = known[name];
    if (spec) lines.push(`    // ${spec.doc}`);
    lines.push(`    "${name}": {`);
    const keys = spec ? spec.entries.map((e) => e.key) : Object.keys(body);
    keys.forEach((key, j) => {
      const doc = spec?.entries.find((e) => e.key === key)?.doc;
      if (doc) lines.push(`      // ${doc}`);
      lines.push(`      "${key}": ${JSON.stringify(body[key])}${j < keys.length - 1 ? "," : ""}`);
    });
    lines.push(`    }${i < names.length - 1 ? "," : ""}`);
  });
  lines.push("  }", "}", "");
  return lines.join("\n");
}

/** The starter every project begins from: the defaults, one agent, no connections. */
export function starterConfig(agents: string[]): OrgConfig {
  const cfg = defaults();
  cfg.org.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? DEFAULT_TIMEZONE;
  for (const name of agents) cfg.agents[name] = {};
  return cfg;
}

/** Declare `connections.<name>` in the file — what a grant needs before `mu start` will
 *  spawn its process. The connect doors call this the moment a grant lands: the human has
 *  already decided by connecting, and the subsection is written empty so every knob stays
 *  the connector's default until someone edits it.
 *
 *  A surgical text edit, not a re-render: the file is the operator's, comments and layout
 *  included, so the insertion is one line inside the existing `connections` block and
 *  every other byte is left as it was found. The result is parsed before it lands — a
 *  write that would not read back is no write at all. Returns whether it added anything. */
export async function declareConnection(root: string, name: string): Promise<boolean> {
  const path = `${root}/config.jsonc`;
  const before = await readConfig(root); // an unparseable file fails HERE, editing nothing
  if (name in before.connections) return false;
  const raw = await Deno.readTextFile(path);
  const at = raw.search(/"connections"\s*:/);
  const open = at < 0 ? -1 : raw.indexOf("{", at);
  if (open < 0) throw new Error(`${path}: no "connections" section to declare "${name}" in`);
  let depth = 0, close = open;
  for (; close < raw.length; close++) {
    if (raw[close] === "{") depth++;
    else if (raw[close] === "}" && --depth === 0) break;
  }
  if (close === raw.length) throw new Error(`${path}: "connections" is never closed`);
  const body = raw.slice(open + 1, close);
  const entry = `\n    "${name}": {}${body.trim() ? "," : ""}`;
  const edited = raw.slice(0, open + 1) + entry + raw.slice(open + 1);
  await Deno.writeTextFile(path, edited);
  try {
    await readConfig(root);
  } catch (err) {
    await Deno.writeTextFile(path, raw);
    throw err;
  }
  return true;
}

/* ── validation ──────────────────────────────────────────────────────────── */

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
  if (!(cfg.org.backlogHours > 0)) {
    throw new Error(
      `${path}: backlogHours must be a positive number (got ${cfg.org.backlogHours})`,
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: cfg.org.timezone });
  } catch {
    throw new Error(`${path}: unknown timezone "${cfg.org.timezone}" (IANA name expected)`);
  }
  if (cfg.processors.audio !== null && typeof cfg.processors.audio !== "string") {
    throw new Error(
      `${path}: processors.audio must be a shell command string, or null (got ` +
        `${JSON.stringify(cfg.processors.audio)})`,
    );
  }
  validateAgent(cfg.org.agent, path);
}

/** The checks that would otherwise surface as a RangeError inside a turn's render or as an
 *  API rejection mid-conversation — discovered at boot instead. */
function validateAgent(a: Partial<AgentDefaults>, path: string): void {
  if (a.model != null && (typeof a.model !== "string" || a.model === "")) {
    throw new Error(`${path}: model must be a model name`);
  }
  if (a.provider != null && (typeof a.provider !== "string" || a.provider === "")) {
    throw new Error(`${path}: provider must be a name`);
  }
  if (a.maxTokens != null && !(Number.isInteger(a.maxTokens) && a.maxTokens > 0)) {
    throw new Error(`${path}: maxTokens must be a positive integer (got ${a.maxTokens})`);
  }
  if (a.effort != null && !(EFFORTS as readonly string[]).includes(a.effort)) {
    throw new Error(`${path}: unknown effort "${a.effort}" (one of ${EFFORTS.join(", ")})`);
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
