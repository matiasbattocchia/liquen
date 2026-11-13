/**
 * config.ts — the catalog (DESIGN §9): every harness knob, its default, one file exposing
 * them all.
 *
 * The standing rules:
 *
 *   · ONE file, `config.yaml`, at the PROJECT ROOT — above `data/`, git-tracked, deployed
 *     with the image. The file is the project marker: `findRoot` walks up from cwd the way
 *     git finds `.git`, and everything else (`data/`, the connectors, the processors) is
 *     addressed from the root it lands on.
 *   · The org's configuration lives in the STORE (`store/agents.ts`): the roster in
 *     `agents`, every knob a leaf of `config`. The file is INPUT ONLY: `liquen init` lays
 *     its commented template once, and from then on humans and repos write it. Boot and
 *     `liquen reload` apply it to the store (`org.ts`): a key it declares overwrites the
 *     store's, a key it leaves out keeps the store's value, an agent it does not name is
 *     left alone. So every key has one owner — the file when it declares it, a command
 *     otherwise — and a command that would change a key the file declares refuses.
 *     `deployment` is the one section the store cannot hold: it names where the store is.
 *   · A key nothing sets takes the default defined HERE; an unknown key or section in
 *     the file is a boot error — a typo must not run silently.
 *   · Placement is by audience. `system`: machinery tuning — every deployment works on the
 *     defaults. `deployment`: where the org's parts live — the log and the vault, the docs,
 *     the agents' shells — where shells off this machine need the docs in the database.
 *     `shared`: what every agent shares — the clock, the backlog, and
 *     under `shared.agents` the defaults every agent inherits. `agents.<name>`: the
 *     roster — each entry overrides `shared.agents` key by key and may declare the
 *     handles a human knows the
 *     agent by. `connections.<name>` belongs to the connectors: each ships its own
 *     `config.ts` (its DEFAULT_s, the same rules) and validates ITS subsection.
 *   · `start` / `xi` / `nu` / `mu` are 100% parametrized — values arrive as arguments,
 *     never from the environment. Argument defaults are ergonomics for direct callers
 *     (tests); they are the named constants defined here, the single source.
 *   · env is for secrets only (tokens the services hold; `ANTHROPIC_API_KEY` belongs to
 *     the SDK's own credential chain, not to us; `GEMINI_API_KEY` is the Google edge's; a key
 *     in the vault — `liquen connect ai` — answers before either). The org lives where its config.yaml
 *     lives — cwd selects it, no variable does. Session choices (which agent a REPL faces)
 *     are CLI arguments — per-invocation by nature, no seat in the file.
 */

import { parse, stringify } from "@std/yaml";
import type { Effort, Json, PolicyAction, PresenceLevel, Rule } from "./types.ts";
import { checkPrices, type Price } from "./prices.ts";
import { type AgentRow, agentScope, type ConfigRow } from "./store/agents.ts";

/** The file the org declares itself in, and the marker of its root. */
export const CONFIG_FILE = "config.yaml";

/* ── the defaults: the single source ─────────────────────────────────────── */

// shared — what every agent shares
export const DEFAULT_BACKLOG_HOURS = 24;
export const DEFAULT_TIMEZONE = "UTC"; // explicit, so two boxes render the same stamps

// shared.agents — every agent's defaults (an `agents.<name>` entry re-declares these, key by key)
export const DEFAULT_MODEL = "claude-sonnet-5";
export const DEFAULT_MAX_TOKENS = 64_000; // streaming — room for thinking + tools + text
// the default deployment's whole offer: the four built-ins plus the exec plane's bash.
// A name added at runtime (an MCP server's tools) joins the offer by being listed here.
export const DEFAULT_TOOLS = ["search", "cancel", "bash"];
export const DEFAULT_RULES: Rule[] = [
  { tool: "send", service: "local", action: "allow" }, // a word to a peer stays in the org
  { tool: "send", action: "ask" }, // dispatch leaves the org, in the principal's name
  { tool: "contact", action: "ask" }, // writes the principal's own address book
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
// presence (§9): what a surface hears of the mind at work
export const DEFAULT_PRESENCE: PresenceLevel = "waiting";
// the window (§5): est. tokens of RAW EVENT JSON (`estTokens`, chars/4) and the pictures it
// inlines (`mediaTokens`) — the estimate counts ids and envelopes the prompt never shows, so
// it runs above the prompt it renders to. An agent's own, since what it holds in view is its work's
// shape: a social agent's window is many rooms of short lines, a coding agent's a few long
// tool results.
//
// It is not the knob for how OFTEN a checkpoint runs. A checkpoint is priced against the
// CACHE, not the window: it rewrites the prompt prefix, so it costs an uncached call plus
// the full writes that follow until the cache re-settles. Both halves scale with the
// window, while the interval between checkpoints scales the same way — a wider window buys
// proportionally rarer, proportionally dearer checkpoints, and the spend comes out flat.
// What moves it is less world traffic reaching the window at all.
export const DEFAULT_COMPACT_AT = 50_000;
export const DEFAULT_KEEP_RECENT = 20_000; // est. tokens a checkpoint leaves uncovered
// A checkpoint runs between turns, in an idle gap, so `compactAt` is a soft budget: a
// window over it waits for the turn to end, and input never waits for a checkpoint. A turn
// whose window outgrows it ten times over is checkpointed inside, at a step's end
// (compact.ts `runaway`). The
// one hard ceiling is the API's own: a request it refuses as too long is compacted before
// the next think, whatever the estimate says (compact.ts `overflowed`).
//
// It is also the most one WUM — a run of world lines between two turns — may weigh in the
// prompt (render.ts `capRun`): a flood of the world is shared equally among its rooms and
// the rest left to `search`, while the agent's own history is the checkpoints' to bound.

// system — harness machinery
// The shutdown grace: how long a stop that was ASKED FOR waits for work already running —
// main draining its in-flight turns, the supervisor draining its children. Not a knob, for
// the same reason the tick isn't: it only ever binds when something is wedged, and a wedged
// turn does not finish because it was given longer. A healthy stop completes in milliseconds
// and never reads this number at all, so there is nothing to buy by moving it — while
// raising it past an orchestrator's own kill deadline would quietly turn every graceful
// stop into a hard one.
export const STOP_TIMEOUT_MS = 5_000;
// An ask nobody answers is not open forever: past this many hours the harness settles it
// as lapsed (§9), so a stale approval never runs yesterday's call, and the model is told
// to ask again if the moment is still right. A day: the span a principal's phone is
// away from them, at most, before the question itself has gone cold.
export const GATE_HOURS = 24;
export const DEFAULT_BASH_WAIT_MS = 120_000; // how long a bash call holds the turn before going to the background
export const DEFAULT_DEBOUNCE_MS = 5_000; // a world trigger waits this long for its burst (§2)
export const DEFAULT_SANDBOX_SLEEP_MINUTES = 10; // the Sandbox SDK's own sleepAfter
// The tick is not a knob. It is the RESOLUTION of the attention rules, not one of them:
// `digestMinutes` says when the agent looks, and the tick only decides how late that look
// may land. At a minute the promise is kept to the minute; raise it and every interval in
// the catalog silently means "give or take a tick". A poke that finds nothing owed costs
// one window read and no model call, so there is nothing to buy by making it rarer.
export const TICK_MS = 60_000;

// edge — the org's one door, and its only port. Every address a service is handed hangs
// off ONE base by path, `/<service>/ingest` and `/<service>/oauth/callback`, so the org
// tells a tunnel one thing: publish `edge.port` at `publicUrl`. The edge process behind
// that port forwards each path to the connector's socket under data/run (edge.ts). The
// same grammar names a function per service on a platform that routes by name, where
// nothing forwards at all.
export const DEFAULT_EDGE_PORT = 8787;

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
/** What a surface hears of the mind at work, quietest first (§9). */
export const PRESENCE_LEVELS: readonly PresenceLevel[] = ["off", "waiting", "tools"];
/** The model providers a transport exists for (transport/mod.ts); `provider: null` ⇒ the first. */
export const PROVIDERS = ["anthropic", "google"] as const;
export type ProviderName = (typeof PROVIDERS)[number];
export const ACTIONS: readonly PolicyAction[] = ["allow", "ask", "deny"];

/* ── the shape the reader returns ────────────────────────────────────────── */

/** The keys every agent resolves — `shared.agents` declares the org's values, an
 *  `agents.<name>` entry re-declares them for one agent. */
export interface AgentDefaults {
  model: string;
  effort: Effort | null; // null ⇒ the model decides
  maxTokens: number;
  compactAt: number; // the window (§5): est. tokens before a checkpoint, and a WUM's cap
  keepRecent: number; //   est. tokens a checkpoint leaves uncovered; below compactAt
  provider: ProviderName | null; // the transport seam; null ⇒ anthropic
  tools: string[] | null; // the tools offered to the model, by name; null ⇒ all of them
  rules: Rule[]; // permission policy as data (§9)
  export: string[]; // the harness's environment variables its shell inherits, by name
  engagedMinutes: number; // attention (§2): how long the agent's own last word keeps
  digestAfterMessages: number; //   a conversation hot · the ambient pile that forces a
  digestMinutes: number; //   wake · the ambient look interval
  sleepHours: string | null; // org-clock span "23-8"; null ⇒ never sleeps
  presence: PresenceLevel; // what a surface hears of the mind at work (§9)
  mind: boolean; // false ⇒ no session runs (§4): a member with no agent, or an agent paused
}

/** One roster entry: overrides of `shared.agents`, key by key, plus the agent's own identity —
 *  the name it goes by and the handles of the account it acts as (§4). Whose that account
 *  is — a member's, or the org's — is the connection row's fact, never declared here.
 *  `principals` says who steers, as roster usernames, when the derivation of §4 (the owner;
 *  every member when the account is the org's) is not wanted — `[]` for nobody, `"*"` for
 *  anyone writing in its steering room. `mind`
 *  false runs no session for the entry: a person alone (identity and handles, never a workspace, just a
 *  door), or an agent PAUSED — its folder stays, its rows keep landing, and the backlog
 *  hands them over when it comes back. Everything else about the agent is discovered
 *  (connect flows) or derived (the home folder). A null handle is one the agent has not. */
export interface AgentEntry extends Partial<AgentDefaults> {
  identity?: Identity;
  principals?: string[] | "*";
}
export interface Identity {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}
export const IDENTITY_KEYS = ["name", "email", "phone"] as const;
const IDENTITY_DOC = "<name>: any shared.agents key set for this agent, plus identity — the " +
  "name the agent goes by and the handles of the account it acts as (null ⇒ it has none); " +
  'principals — who steers it, roster names ([] ⇒ nobody; "*" ⇒ anyone writing in its ' +
  "steering room; absent ⇒ its owner, or every member when the account is the org's); " +
  "mind: false — no session runs: a member with no agent of their own, or an agent paused. " +
  "An agent made by `liquen agent` or a connector and not named here runs on what the " +
  "store holds";

export interface OrgConfig {
  system: {
    bashWaitMs: number;
    debounceMs: number;
    prices: Price[]; // the org's own price rows, over the package's list (`prices.ts`)
  };
  deployment: {
    database: string; // "sqlite" ⇒ SQLite in data/log; a Postgres URL ⇒ that database
    docs: "filesystem" | "database"; // where the docs live: files under data/, or the database's docs table
    storage: string; // "filesystem" ⇒ data/storage; a bucket's URL ⇒ that bucket, over the S3 API
    sandbox: string | null; // null ⇒ shells on this machine; "bwrap" ⇒ in bubbles; a URL ⇒ that gateway's
    mounts: string[]; // more of this machine a bubble shows, read-only unless `:rw`
    sandboxSleepMinutes: number; // a gateway sandbox's life after its last bash call
  };
  shared: {
    timezone: string; // the ORG's clock — every stamp, cron and sleep span reads it (§5); TZ in every agent shell
    locale: string | null; // LANG in every agent shell and media processor
    backlogHours: number;
    agents: AgentDefaults;
  };
  processors: {
    /** Shell command: audio bytes on stdin → transcript text on stdout (non-zero exit =
     *  no transcript). null ⇒ voice notes stay untranscribed. The command IS the plugin
     *  interface — the repo ships `processors/qwen-asr/` as one implementation. */
    audio: string | null;
  };
  edge: {
    /** The org's public https base; null ⇒ reached on localhost only. */
    publicUrl: string | null;
    /** The one port the edge binds — what the tunnel publishes. */
    port: number;
    /** The tunnel's argv, supervised by `liquen start`; null ⇒ the operator runs one. */
    tunnel: string[] | null;
  };
  /** The roster: every key under `agents` IS an agent, a row of the store (§9). The name
   *  is the agent's id, its folder under `data/agents/`, and its Linux user in the
   *  container. */
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

/** A common boot check for connector entries. */
export const checkStrings = (v: unknown): string | null =>
  Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s)
    ? null
    : "must be a non-empty array of non-empty strings";

/** A boot check for an entry naming some of `choices`, each at most once — empty is a
 *  choice too. */
export const checkAmong = (choices: readonly string[]) => (v: unknown): string | null =>
  Array.isArray(v) && v.every((s) => choices.includes(s)) && new Set(v).size === v.length
    ? null
    : `must be an array of distinct names among ${choices.map((c) => `"${c}"`).join(", ")}`;

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
    key: "bashWaitMs",
    value: DEFAULT_BASH_WAIT_MS,
    doc: "how long a bash call holds the turn in the foreground before it goes to the " +
      "background: the turn is answered with what the command printed so far, the command " +
      "runs on, and its end is told when it comes; the model may give a call its own wait",
  },
  {
    key: "debounceMs",
    value: DEFAULT_DEBOUNCE_MS,
    doc: "how long a world message waits for the rest of its burst before a turn runs",
  },
  {
    key: "prices",
    value: [],
    doc: "the org's own model prices, over the package's list: rows of { model, valid_since " +
      "(YYYY-MM-DD), input, output, cache_read?, cache_write?, tiers? }, in USD per million " +
      "tokens; a row in effect wins over the package's, and `liquen log spend` prices each " +
      "call at the rate of its day",
  },
];

const DEPLOYMENT: Entry[] = [
  {
    key: "database",
    value: "sqlite",
    doc: 'where the log and the vault live: "sqlite" ⇒ SQLite in data/log; a Postgres URL ' +
      "(postgres://user@host:5432/db, ?schema= for one schema of it) ⇒ that database, " +
      "its password read from PGPASSWORD",
  },
  {
    key: "docs",
    value: "filesystem",
    doc: "where the docs live: filesystem ⇒ files under data/, which an agent reads and " +
      "writes from its shell; database ⇒ the docs table of the database above, SQLite or " +
      "Postgres, which an agent reaches through its read · write · edit tools",
  },
  {
    key: "storage",
    value: "filesystem",
    doc: 'where the files the org receives and sends are kept: "filesystem" ⇒ under ' +
      "data/storage; a bucket's URL, path-style (https://<account>.r2.cloudflarestorage.com" +
      "/<bucket>, ?region= where the service wants one) ⇒ that bucket, over the S3 API (R2, " +
      "S3, Supabase Storage), its keys read from STORAGE_ACCESS_KEY_ID and " +
      "STORAGE_SECRET_ACCESS_KEY. An agent reads a file through its door, either way",
  },
  {
    key: "sandbox",
    value: null,
    doc: 'where the agents\' shells run: null ⇒ this machine, as you; "bwrap" ⇒ this ' +
      "machine, each agent in a bubble of its own (bubblewrap, the recommended way on " +
      "Linux) that sees its own folder, the shared floor and the system, and reaches the " +
      "network as this machine does; the URL of a Cloudflare sandbox gateway " +
      "(sandbox/cloudflare in the package) ⇒ one sandbox per agent there, its bearer token " +
      "read from SANDBOX_API_KEY; needs docs: database, since the sandbox cannot reach files " +
      "on this machine",
  },
  {
    key: "mounts",
    value: [],
    doc: 'more of this machine a bubble (sandbox "bwrap") shows, each an absolute path or ' +
      'one under ~/, read-only unless it ends in ":rw" ("~/code/repo:rw"): a tool installed ' +
      "in your home shows only its PATH folder, so one that runs on files beside it needs " +
      'its own: mise ("~/.local/share/mise"), nvm ("~/.nvm"), uv ("~/.local/share/uv"). A ' +
      "shim finds its tool from HOME, which in a bubble is the agent's folder, so the tools " +
      "need their own folders on PATH (mise activate does that). Every agent sees what is " +
      "named; none may hold the org's folder or lie in it",
  },
  {
    key: "sandboxSleepMinutes",
    value: DEFAULT_SANDBOX_SLEEP_MINUTES,
    doc: "how long a gateway sandbox lives after its agent's last bash call: the next step " +
      "past it stops the container, or the gateway does that long after its last request " +
      "when the harness is quiet; its background jobs and workspace files go with it (the " +
      "agent is told)",
  },
];

const SHARED: Entry[] = [
  {
    key: "timezone",
    value: DEFAULT_TIMEZONE,
    doc: "the org's clock (IANA) — every rendered stamp, cron and sleep span reads it, and " +
      "it is TZ in every agent shell, so what a program there prints is on the same clock",
  },
  {
    key: "locale",
    value: null,
    doc: "the org's locale (es_AR.UTF-8) — LANG in every agent shell and media processor, " +
      "so tools and transcribers speak the org's language; unset, they inherit the harness's",
  },
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
    key: "compactAt",
    value: DEFAULT_COMPACT_AT,
    doc: "est. tokens of raw event JSON and the pictures it inlines before a checkpoint " +
      "runs, between turns, or inside a turn ten times over it; input never waits for one. " +
      "Also the most a run of world lines between " +
      "two turns may weigh in the prompt: past it, its rooms share it equally, newest lines " +
      "first, and the rest is left for search",
  },
  {
    key: "keepRecent",
    value: DEFAULT_KEEP_RECENT,
    doc: "est. tokens a checkpoint leaves uncovered; below compactAt",
  },
  {
    key: "provider",
    value: null,
    doc: `model provider (${PROVIDERS.join("|")}); null ⇒ anthropic`,
  },
  {
    key: "tools",
    value: DEFAULT_TOOLS,
    doc: "the tools offered to the model, by name — built-ins and exec tools (bash, MCP) " +
      'alike; null ⇒ every tool the deployment has. Add "send" where the agent has peers ' +
      "or a world to write to — a reply to its own principal is its plain answer, never a " +
      'call — "conversation" where it has peers and may open rooms with them, or an ' +
      'account on a wire whose rooms it may change, and "contact" where an account keeps ' +
      "an address book the agent may write. With docs: database, read · write · edit are " +
      "offered whatever this says: they are the agent's one way to its docs",
  },
  {
    key: "rules",
    value: DEFAULT_RULES,
    doc: "permission policy: first match decides (allow|ask|deny); * matches any tool; " +
      "service/connection/conversation pin a rule to where a send lands (service: local is " +
      "the rooms between agents), connection to whose address book a contact is written in",
  },
  {
    key: "export",
    value: [],
    doc: "names of the harness's environment variables an agent's shell inherits, read at " +
      "each bash call — what a tool needs from the machine it runs on, like DISPLAY for a " +
      "browser the principal watches; shells on this machine only. A name a secret goes " +
      "by (…_KEY, …_TOKEN, …_SECRET, …PASSWORD) is refused",
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
  {
    key: "presence",
    value: DEFAULT_PRESENCE,
    doc: "what the principal's surfaces hear of the agent at work, as it starts: off ⇒ " +
      "only its words, its approval cards and its errors; waiting ⇒ also memorizing, " +
      "compacting and thinking, and each call as working, each as it starts; tools ⇒ " +
      "each call by name, and a call that failed",
  },
  {
    key: "mind",
    value: true,
    doc: "whether a session runs for the agent; false PAUSES it — its rows still land in " +
      "the log and are owed when it comes back. Here, false pauses every agent that does " +
      "not say otherwise: the org's doors stay up, its minds do not",
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

const EDGE: Entry[] = [
  {
    key: "publicUrl",
    value: null,
    doc: "the org's public https:// base — what a tunnel or a real host in front of edge.port " +
      "answers as; every service's address hangs off it (/<service>/ingest, " +
      "/<service>/oauth/callback), and the doors print the one to register; null ⇒ the " +
      "org is reached at http://localhost:<edge.port> only",
  },
  {
    key: "port",
    value: DEFAULT_EDGE_PORT,
    doc: "the org's one port: the edge binds it and the tunnel publishes it — it forwards " +
      "/<service>/… to that connector's socket under data/run",
  },
  {
    key: "tunnel",
    value: null,
    doc: 'the command that publishes edge.port at publicUrl, as an argv (["cloudflared", ' +
      '"tunnel", "run", "acme"]), run and kept alive by `liquen start` beside the org; ' +
      "null ⇒ something else runs it (systemd, a host's own proxy)",
  },
];

const SECTION_DOCS: Record<string, string> = {
  system: "harness machinery — every deployment works on the defaults",
  deployment: "where the org's parts live — the log and the vault, the docs, the agents' " +
    "shells; shells off this machine need the docs in the database",
  shared: "what every agent shares — the clock, the backlog, and the defaults each inherits",
  processors: "media processors — broker-side commands that derive text from bytes (§5)",
  edge: "the org's one door — the address the world dials, the one port the org binds, " +
    "and the tunnel",
  agents: "the roster: every key is a member — an agent, its folder and its unix user, or " +
    "a person alone (mind: false)",
  connections: "the connectors' knobs — a subsection per connector, validated by its owner",
};

/** An agent's name is also its folder and its Linux user in the container — the charset is
 *  the intersection of what all three accept. */
export const AGENT_NAME = /^[a-z][a-z0-9-]{0,30}$/;
/** A connection's name: the first word of its path on the edge and of its socket. */
export const SERVICE_NAME = /^[a-z][a-z0-9-]*$/;

function fromEntries(entries: Entry[]): Record<string, unknown> {
  return Object.fromEntries(entries.map((e) => [e.key, e.value]));
}

function defaults(): OrgConfig {
  return {
    system: fromEntries(SYSTEM),
    deployment: fromEntries(DEPLOYMENT),
    shared: { ...fromEntries(SHARED), agents: fromEntries(AGENT) },
    processors: fromEntries(PROCESSORS),
    edge: fromEntries(EDGE),
    agents: {},
    connections: {},
  } as unknown as OrgConfig;
}

/** Merge one section: the user's values over the entries' defaults; an unknown key is a
 *  boot error. `label` names the section in the complaint ("shared.agents.model"). */
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

/** `--dir <path>` (or `--dir=<path>`): the one flag every entry point accepts — the org,
 *  wherever the process runs, for an agent that stands in a directory its org does not
 *  contain (a repo, a task's workdir). Returns the argv WITHOUT it, so an entry point's
 *  own parsing sees only its own words. */
export function orgFlag(argv: string[] = Deno.args): { dir?: string; args: string[] } {
  let dir: string | undefined;
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dir") dir = argv[++i];
    else if (arg.startsWith("--dir=")) dir = arg.slice("--dir=".length);
    else args.push(arg);
  }
  return { dir, args };
}

/** The org is WHERE YOU RUN liquen: walk up from `from` (default cwd) to the nearest
 *  `config.yaml` — the project marker, the way git finds `.git`. Everything is addressed
 *  from the root it names: the catalog at `<root>/config.yaml`, the substrate at
 *  `<root>/data`. An explicit `dir` (the `--dir` flag) IS the org: it must hold the
 *  marker itself, and nothing is walked. */
export function findRoot({ dir, from = Deno.cwd() }: { dir?: string; from?: string } = {}): string {
  if (dir) {
    try {
      Deno.statSync(`${dir}/${CONFIG_FILE}`);
    } catch {
      throw new Error(`--dir ${dir} is not a liquen project: no ${CONFIG_FILE} there`);
    }
    return Deno.realPathSync(dir);
  }
  let here = Deno.realPathSync(from);
  for (;;) {
    try {
      Deno.statSync(`${here}/${CONFIG_FILE}`);
      return here;
    } catch { /* keep climbing */ }
    const parent = here.replace(/\/[^/]+$/, "") || "/";
    if (parent === here) {
      throw new Error(
        `not inside a liquen org: no ${CONFIG_FILE} from ${from} up — ` +
          "`deno run -A jsr:@liquen/liquen/init <path>` makes one",
      );
    }
    here = parent;
  }
}

/* ── the file: what it declares ──────────────────────────────────────────── */

/** What `config.yaml` declares, as boot and reload apply it (§9): sparse, so a key the
 *  file leaves out is no word about it. */
export interface Declared {
  /** `deployment`, whole, over its defaults: where the store is, so the file's alone. */
  deployment: OrgConfig["deployment"];
  /** Every leaf the file sets, by scope. A connection it declares stands by a leaf under
   *  the empty key, whatever knobs it sets. */
  leaves: ConfigRow[];
  /** The roster entries it declares: the identity keys and the principals each states. */
  agents: Record<string, { identity: Identity; principals?: string[] | "*" }>;
}

/** The keys an agent's own scope may set. */
export const AGENT_KEYS: readonly string[] = AGENT.map((e) => e.key);

/** The scopes whose keys the catalog knows, and the entries that are them. */
const SCOPES: Record<string, Entry[]> = {
  system: SYSTEM,
  shared: SHARED,
  "shared.agents": AGENT,
  processors: PROCESSORS,
  edge: EDGE,
};

/** The scope a connection's knobs live in, and the key its declaration stands by. */
export const connectionScope = (service: string): string => `connections.${service}`;
export const DECLARED = "";

/** A section's body: an object, or nothing at all (`agents:` with no entry under it). */
function asObject(v: unknown, path: string, label: string): Record<string, unknown> {
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`${path}: ${label} must be a mapping`);
  }
  return v as Record<string, unknown>;
}

/** The leaves of one catalog scope as the file gives them; an unknown key is an error. */
function leavesOf(
  given: Record<string, unknown>,
  entries: Entry[],
  scope: string,
  path: string,
  label: string,
): ConfigRow[] {
  return Object.entries(given).map(([key, value]) => {
    if (!entries.some((e) => e.key === key)) {
      throw new Error(`${path}: unknown key "${label}.${key}"`);
    }
    return { scope, key, value: value as Json };
  });
}

/** Read what the file's text declares. An unknown key or section is an error: a typo
 *  must not run silently. `connections` subsections are the connectors' and pass through
 *  opaque (each connector checks its own). */
export function parseDeclared(raw: string, path: string): Declared {
  let found: Record<string, unknown>;
  try {
    found = asObject(parse(raw), path, "the file");
  } catch (err) {
    throw new Error(`${path}: ${err instanceof Error ? err.message : err}`);
  }
  for (const section of Object.keys(found)) {
    if (!(section in SECTION_DOCS)) throw new Error(`${path}: unknown section "${section}"`);
  }
  const { agents: sharedAgents, ...shared } = asObject(found.shared, path, "shared");
  const out: Declared = {
    deployment: mergeSection(
      asObject(found.deployment, path, "deployment"),
      DEPLOYMENT,
      path,
      "deployment",
    ) as unknown as OrgConfig["deployment"],
    leaves: [
      ...leavesOf(asObject(found.system, path, "system"), SYSTEM, "system", path, "system"),
      ...leavesOf(shared, SHARED, "shared", path, "shared"),
      ...leavesOf(
        asObject(sharedAgents, path, "shared.agents"),
        AGENT,
        "shared.agents",
        path,
        "shared.agents",
      ),
      ...leavesOf(
        asObject(found.processors, path, "processors"),
        PROCESSORS,
        "processors",
        path,
        "processors",
      ),
      ...leavesOf(asObject(found.edge, path, "edge"), EDGE, "edge", path, "edge"),
    ],
    agents: {},
  };
  validateDeployment(out.deployment, path);
  for (const [name, body] of Object.entries(asObject(found.agents, path, "agents"))) {
    if (!AGENT_NAME.test(name)) throw new Error(`${path}: ${nameRule(name)}`);
    const { identity, principals, ...over } = asObject(body, path, `agents.${name}`);
    const stated: Identity = {};
    for (const [key, v] of Object.entries(asObject(identity, path, `agents.${name}.identity`))) {
      if (!(IDENTITY_KEYS as readonly string[]).includes(key)) {
        throw new Error(`${path}: unknown key "agents.${name}.identity.${key}"`);
      }
      // YAML reads a bare +549… as a number: its digits are the whole of a phone's handle
      const text = key === "phone" && typeof v === "number" ? String(v) : v;
      if (text !== null && typeof text !== "string") {
        throw new Error(`${path}: agents.${name}.identity.${key} must be a string or null`);
      }
      stated[key as (typeof IDENTITY_KEYS)[number]] = text;
    }
    if (principals !== undefined && !isPrincipals(principals)) {
      throw new Error(
        `${path}: agents.${name}.principals must be a list of roster names, or "*"`,
      );
    }
    out.agents[name] = {
      identity: stated,
      ...(principals !== undefined ? { principals: principals as string[] | "*" } : {}),
    };
    out.leaves.push(...leavesOf(over, AGENT, agentScope(name), path, `agents.${name}`));
  }
  for (const [name, body] of Object.entries(asObject(found.connections, path, "connections"))) {
    if (!SERVICE_NAME.test(name)) {
      throw new Error(
        `${path}: connections.${name} — a connection's name is its path on the edge ` +
          `(/<name>/ingest) and its socket (data/run/<name>.sock): lowercase letters, digits ` +
          `and dashes, starting with a letter`,
      );
    }
    const scope = connectionScope(name);
    out.leaves.push({ scope, key: DECLARED, value: true });
    for (const [key, value] of Object.entries(asObject(body, path, `connections.${name}`))) {
      out.leaves.push({ scope, key, value: value as Json });
    }
  }
  return out;
}

/** What `principals` may hold: a list of names, or `"*"`. */
export function isPrincipals(v: unknown): v is string[] | "*" {
  return v === "*" || (Array.isArray(v) && v.every((p) => typeof p === "string"));
}

/** The rule a member's name follows, said of `name`. */
export function nameRule(name: string): string {
  return `agents.${name} — a name is a folder and a unix user: lowercase letters, digits ` +
    `and dashes, starting with a letter`;
}

/** Read `<root>/config.yaml` — and only read: no command writes it. Absent file ⇒ it
 *  declares nothing, and the deployment is the default one. */
export async function readFile(root: string): Promise<Declared> {
  const path = `${root}/${CONFIG_FILE}`;
  let raw: string;
  try {
    raw = await Deno.readTextFile(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return parseDeclared("", path);
    throw err; // a file that exists and cannot be read is a boot error, not an empty org
  }
  return parseDeclared(raw, path);
}

/** The keys the file owns, as paths: `agents.ana` for an agent it declares at all,
 *  `agents.ana.model`, `agents.ana.identity.email`, `agents.ana.principals`,
 *  `connections.slack`, `shared.agents.model`. A command that would change one refuses:
 *  the file's word is put back at the next boot. */
export function declaredPaths(d: Declared): Set<string> {
  const out = new Set<string>();
  for (const { scope, key } of d.leaves) out.add(key === DECLARED ? scope : `${scope}.${key}`);
  for (const [name, a] of Object.entries(d.agents)) {
    out.add(agentScope(name));
    for (const key of Object.keys(a.identity)) out.add(`${agentScope(name)}.identity.${key}`);
    if (a.principals !== undefined) out.add(`${agentScope(name)}.principals`);
  }
  return out;
}

/** The refusal a command meets on a key the file owns. */
export function pinned(path: string, how = "edit it there"): Error {
  return new Error(`${path} is declared in ${CONFIG_FILE}; ${how}`);
}

/* ── the store's state, as the org runs on it ────────────────────────────── */

/** The org's configuration as it stands: the file's `deployment`, and every other section
 *  as the store holds it over the catalog's defaults. `agents` is the roster's rows, each
 *  with the keys its own scope sets; `connections` the scopes declared, opaque. */
export function orgOf(
  deployment: OrgConfig["deployment"],
  rows: ConfigRow[],
  roster: AgentRow[],
): OrgConfig {
  const cfg = defaults();
  cfg.deployment = deployment;
  const sections = cfg as unknown as Record<string, Record<string, unknown>>;
  const own: Record<string, Record<string, unknown>> = {};
  for (const { scope, key, value } of rows) {
    if (scope === "shared.agents") {
      (cfg.shared.agents as unknown as Record<string, Json>)[key] = value;
    } else if (scope in SCOPES) sections[scope][key] = value;
    else if (scope.startsWith("connections.")) {
      const body = cfg.connections[scope.slice("connections.".length)] ??= {};
      if (key !== DECLARED) body[key] = value;
    } else if (scope.startsWith("agents.")) {
      (own[scope.slice("agents.".length)] ??= {})[key] = value;
    }
  }
  for (const a of roster) {
    cfg.agents[a.agentId] = {
      identity: { name: a.name ?? null, email: a.email ?? null, phone: a.phone ?? null },
      ...(a.principals !== undefined ? { principals: a.principals } : {}),
      ...own[a.agentId],
    };
  }
  return cfg;
}

/** What one agent runs with: its own scope over the org's, key by key. A key present is
 *  a value, `null` included ("every tool", "never sleeps"). */
export function settingsOf(cfg: OrgConfig, name: string): AgentDefaults {
  const { identity: _identity, principals: _principals, ...own } = cfg.agents[name] ?? {};
  return { ...cfg.shared.agents, ...own };
}

/** A connector's knobs, off the org as it stands: its scope over its spec's defaults —
 *  an unknown key errors, and each `check` runs. `label` names where the org was read. */
export function knobsOf<T extends object>(cfg: OrgConfig, spec: ConnectorSpec, label: string): T {
  const merged = mergeSection(
    cfg.connections[spec.name] ?? {},
    spec.entries,
    label,
    `connections.${spec.name}`,
  );
  for (const e of spec.entries) {
    const complaint = e.check?.(merged[e.key]);
    if (complaint) {
      throw new Error(
        `${label}: connections.${spec.name}.${e.key} ${complaint} (got ` +
          `${JSON.stringify(merged[e.key])})`,
      );
    }
  }
  return merged as unknown as T;
}

/* ── the file, rendered ──────────────────────────────────────────────────── */

/** A value as YAML on one line; a list of mappings as a block, one item a line. */
function yamlLines(key: string, value: unknown, indent: string): string[] {
  const flow = (v: unknown) =>
    stringify(v, { flowLevel: 0, lineWidth: -1, condenseFlow: false }).trimEnd();
  if (
    Array.isArray(value) && value.length > 0 &&
    value.every((v) => typeof v === "object" && v !== null && !Array.isArray(v))
  ) {
    return [`${indent}${key}:`, ...value.map((v) => `${indent}  - ${flow(v)}`)];
  }
  return [`${indent}${key}: ${flow(value)}`];
}

/** Render the org as `config.yaml`. With every key `set` and the docs on, the commented
 *  template `liquen init` lays; with `set` saying which keys the store holds, the store's
 *  state as `liquen config` prints it: a key set is a line to copy into the file, a key
 *  inherited is a comment showing the value it resolves to. */
export function materialize(
  cfg: OrgConfig,
  opts: {
    specs?: ConnectorSpec[];
    /** Whether the store holds the key; absent ⇒ every key is rendered as set. */
    set?: (scope: string, key: string) => boolean;
    /** The catalog's comment over each key and section. */
    docs?: boolean;
  } = {},
): string {
  const { specs = [], set = () => true, docs = true } = opts;
  const lines: string[] = docs
    ? [
      "# config.yaml — what the org declares: every harness knob (the catalog, DESIGN §9).",
      "# Boot and `liquen reload` apply it to the store: a key set here overwrites the store's,",
      "# a key left out keeps the value the store has, and an agent it does not name is left",
      "# alone. No command writes this file: `liquen agent` and `liquen connect` write the",
      "# store, and `liquen config` prints its state to copy from. An unknown key is a boot",
      "# error.",
      "",
    ]
    : [];
  const emit = (
    indent: string,
    scope: string,
    entries: Entry[],
    values: Record<string, unknown>,
  ) => {
    for (const e of entries) {
      if (docs) lines.push(...wrap(e.doc, indent));
      const rendered = yamlLines(e.key, values[e.key], indent);
      lines.push(...(set(scope, e.key) ? rendered : rendered.map((l) => comment(l, indent))));
    }
  };
  const section = (name: string) => {
    if (docs) lines.push(...wrap(SECTION_DOCS[name], ""));
    lines.push(`${name}:`);
  };
  const plain = cfg as unknown as Record<string, Record<string, unknown>>;
  for (const name of ["system", "deployment", "shared", "processors", "edge"]) {
    section(name);
    const entries = name === "deployment" ? DEPLOYMENT : SCOPES[name];
    emit("  ", name, entries, plain[name]);
    if (name === "shared") {
      if (docs) {
        lines.push(
          ...wrap("every agent's defaults — an agents.<name> entry sets these, key by key", "  "),
        );
      }
      lines.push("  agents:");
      emit("    ", "shared.agents", AGENT, cfg.shared.agents as unknown as Record<string, unknown>);
    }
    lines.push("");
  }
  if (docs) lines.push(...wrap(SECTION_DOCS.agents, ""), ...wrap(IDENTITY_DOC, ""));
  lines.push(Object.keys(cfg.agents).length === 0 ? "agents: {}" : "agents:");
  for (const [name, entry] of Object.entries(cfg.agents)) {
    const { identity = {}, principals, ...over } = entry;
    lines.push(`  ${name}:`, "    identity:");
    for (const key of IDENTITY_KEYS) lines.push(...yamlLines(key, identity[key] ?? null, "      "));
    if (principals !== undefined) lines.push(...yamlLines("principals", principals, "    "));
    for (const e of AGENT) {
      if (e.key in over) {
        lines.push(...yamlLines(e.key, (over as Record<string, unknown>)[e.key], "    "));
      }
    }
  }
  lines.push("");
  if (docs) lines.push(...wrap(SECTION_DOCS.connections, ""));
  lines.push(Object.keys(cfg.connections).length === 0 ? "connections: {}" : "connections:");
  const known = Object.fromEntries(specs.map((s) => [s.name, s]));
  for (const [name, body] of Object.entries(cfg.connections)) {
    const spec = known[name];
    if (docs && spec) lines.push(...wrap(spec.doc, "  "));
    const keys = Object.keys(body);
    if (keys.length === 0) lines.push(`  ${name}: {}`);
    else lines.push(`  ${name}:`);
    for (const key of keys) {
      const doc = spec?.entries.find((e) => e.key === key)?.doc;
      if (docs && doc) lines.push(...wrap(doc, "    "));
      lines.push(...yamlLines(key, body[key], "    "));
    }
  }
  lines.push("");
  return lines.join("\n");
}

const WIDTH = 92;

/** A line as a comment, at its own indent. */
const comment = (line: string, indent: string) => `${indent}# ${line.slice(indent.length)}`;

/** A doc as comment lines at `indent`, wrapped. */
function wrap(doc: string, indent: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of doc.split(/\s+/)) {
    if (line && indent.length + 2 + line.length + 1 + word.length > WIDTH) {
      out.push(`${indent}# ${line}`);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(`${indent}# ${line}`);
  return out;
}

/** The starter every project begins from: the defaults, the machine's clock and locale, an
 *  empty roster and no connections — `liquen agent` and `liquen connect` fill the store. */
export function starterConfig(): OrgConfig {
  const cfg = defaults();
  cfg.shared.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? DEFAULT_TIMEZONE;
  cfg.shared.locale = machineLocale();
  return cfg;
}

/** The locale the machine's shell speaks, as libc reads it (LC_ALL over LANG); the
 *  languageless C/POSIX locales are no locale at all. */
function machineLocale(): string | null {
  const l = Deno.env.get("LC_ALL") || Deno.env.get("LANG") || "";
  return l && !/^(C|POSIX)(\..*)?$/.test(l) ? l : null;
}

/* ── validation ──────────────────────────────────────────────────────────── */

/** Whether the org, as it would stand, is one boot can run: every check a key has, each
 *  agent's own included, and the ones that hold between keys. `path` names where the
 *  change came from, the file or a command, in the complaint. */
export function validateOrg(cfg: OrgConfig, path: string): void {
  const prices = checkPrices(cfg.system.prices);
  if (prices) throw new Error(`${path}: system.prices ${prices}`);
  for (const [name, entry] of Object.entries(cfg.agents)) {
    const { identity: _identity, principals, ...over } = entry;
    validateAgent(over, `${path}: agents.${name}`);
    // a principal is a member (§4): the list can only name who is in the roster
    for (const p of Array.isArray(principals) ? principals : []) {
      if (!(p in cfg.agents)) {
        throw new Error(`${path}: agents.${name}.principals names "${p}", not in the roster`);
      }
    }
  }
  // the pair is checked as each agent resolves it: an entry that re-declares one of the two
  // is held to the org's other
  const org = cfg.shared.agents;
  const windows: [string, Partial<AgentDefaults>][] = [
    ["shared.agents", {}],
    ...Object.entries(cfg.agents).map(([name, a]): [string, AgentEntry] => [`agents.${name}`, a]),
  ];
  for (const [label, a] of windows) {
    const compactAt = a.compactAt ?? org.compactAt;
    const keepRecent = a.keepRecent ?? org.keepRecent;
    if (!(compactAt > 0 && keepRecent > 0 && keepRecent < compactAt)) {
      throw new Error(
        `${path}: ${label}: keepRecent must be a positive number below compactAt — a ` +
          `checkpoint that leaves the whole budget uncovered has nothing to cover, and never ` +
          `runs (got compactAt ${JSON.stringify(compactAt)}, keepRecent ` +
          `${JSON.stringify(keepRecent)})`,
      );
    }
  }
  if (!(cfg.shared.backlogHours > 0)) {
    throw new Error(
      `${path}: backlogHours must be a positive number (got ${cfg.shared.backlogHours})`,
    );
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: cfg.shared.timezone });
  } catch {
    throw new Error(
      `${path}: unknown timezone "${cfg.shared.timezone}" (IANA name expected)`,
    );
  }
  if (cfg.processors.audio !== null && typeof cfg.processors.audio !== "string") {
    throw new Error(
      `${path}: processors.audio must be a shell command string, or null (got ` +
        `${JSON.stringify(cfg.processors.audio)})`,
    );
  }
  validateDeployment(cfg.deployment, path);
  const publicUrl = checkPublicUrl(cfg.edge.publicUrl);
  if (publicUrl) {
    throw new Error(
      `${path}: edge.publicUrl ${publicUrl} (got ${JSON.stringify(cfg.edge.publicUrl)})`,
    );
  }
  if (!(Number.isInteger(cfg.edge.port) && cfg.edge.port > 0 && cfg.edge.port < 65536)) {
    throw new Error(
      `${path}: edge.port must be a port (1-65535) — a tunnel publishes a number it was ` +
        `told (got ${JSON.stringify(cfg.edge.port)})`,
    );
  }
  if (cfg.edge.tunnel !== null) {
    if (checkStrings(cfg.edge.tunnel)) {
      throw new Error(
        `${path}: edge.tunnel must be an argv (["cloudflared", "tunnel", "run", "acme"]) ` +
          `or null (got ${JSON.stringify(cfg.edge.tunnel)})`,
      );
    }
    if (cfg.edge.publicUrl === null) {
      throw new Error(`${path}: edge.tunnel publishes edge.publicUrl, and publicUrl is null`);
    }
  }
  validateAgent(cfg.shared.agents, `${path}: shared.agents`);
}

/** The checks of `deployment`, the section read before there is a store to read. */
function validateDeployment(where: OrgConfig["deployment"], path: string): void {
  const database = checkDatabase(where.database);
  if (database) {
    throw new Error(
      `${path}: deployment.database ${database} (got ${JSON.stringify(where.database)})`,
    );
  }
  const docs = checkDocs(where.docs);
  if (docs) {
    throw new Error(`${path}: deployment.docs ${docs} (got ${JSON.stringify(where.docs)})`);
  }
  const storage = checkStorage(where.storage);
  if (storage) {
    throw new Error(
      `${path}: deployment.storage ${storage} (got ${JSON.stringify(where.storage)})`,
    );
  }
  const sandbox = checkSandbox(where.sandbox, where.docs);
  if (sandbox) {
    throw new Error(
      `${path}: deployment.sandbox ${sandbox} (got ${JSON.stringify(where.sandbox)})`,
    );
  }
  const sleep = where.sandboxSleepMinutes;
  if (!Number.isInteger(sleep) || sleep < 1) {
    throw new Error(
      `${path}: deployment.sandboxSleepMinutes must be a whole number of minutes, 1 or more ` +
        `(got ${JSON.stringify(sleep)})`,
    );
  }
  const mounts = checkMounts(where.mounts);
  if (mounts) throw new Error(`${path}: deployment.mounts ${mounts}`);
}

/** What `edge.publicUrl` may hold: null, or an https:// base — an origin, or an origin
 *  and a path prefix, with nothing after (no query, no fragment, no trailing slash): the
 *  service paths are appended to it byte for byte. A complaint, or null when fine. */
export function checkPublicUrl(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string") return "must be null or an https:// URL";
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return "must be null or an https:// URL";
  }
  if (url.protocol !== "https:") {
    return "must be an https:// URL — the services push to nothing else";
  }
  if (url.search || url.hash) return "must carry no query or fragment";
  if (v.endsWith("/")) return "must not end in a slash — /<service>/… is appended to it";
  return null;
}

/** What `deployment.docs` may hold: `filesystem`, or `database`, the docs table of the
 *  store `deployment.database` names. A complaint, or null when the value is fine. */
export function checkDocs(v: unknown): string | null {
  return v === "filesystem" || v === "database" ? null : 'must be "filesystem" or "database"';
}

/** What `deployment.storage` may hold: `filesystem`, or a bucket's URL over the S3 API,
 *  https — plain http only toward this machine — with the bucket as its first path segment
 *  and no credential in it. A complaint, or null when the value is fine. */
export function checkStorage(v: unknown): string | null {
  if (v === "filesystem") return null;
  const shape = 'must be "filesystem" or a bucket\'s https URL (https://<endpoint>/<bucket>)';
  let url: URL;
  try {
    url = new URL(String(v));
  } catch {
    return shape;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    typeof v !== "string" || !(url.protocol === "https:" || (local && url.protocol === "http:"))
  ) {
    return shape;
  }
  if (!url.pathname.split("/").some(Boolean)) return shape;
  if (url.username || url.password) {
    return "must not carry a credential — STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY " +
      "in .env hold it";
  }
  return null;
}

/** What `deployment.sandbox` may hold: null, `"bwrap"`, or the https URL of a sandbox gateway —
 *  plain http only toward this machine, where `wrangler dev` serves one — when the docs are
 *  in the database. A complaint, or null when the value is fine. */
export function checkSandbox(v: unknown, docs: unknown): string | null {
  if (v === null || v === "bwrap") return null;
  const shape = 'must be null, "bwrap", or a gateway\'s https URL';
  let url: URL;
  try {
    url = new URL(String(v));
  } catch {
    return shape;
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    typeof v !== "string" || !(url.protocol === "https:" || (local && url.protocol === "http:"))
  ) {
    return shape;
  }
  if (url.username || url.password) {
    return "must not carry a credential — SANDBOX_API_KEY in .env holds it";
  }
  return docs === "database"
    ? null
    : 'needs deployment.docs: "database" — a sandbox cannot reach files here';
}

/** What `deployment.mounts` may hold: absolute paths, or paths under `~/`, each perhaps ending
 *  in `:rw`. A complaint, or null when fine. Whether one touches the org's folder is the
 *  bubble's to say. */
export function checkMounts(v: unknown): string | null {
  const shape = "must be an array of absolute paths or paths under ~/, each read-only unless " +
    'it ends in ":rw" ("~/.local/share/mise", "~/code/repo:rw")';
  if (!Array.isArray(v)) return shape;
  const bad = v.find((p) => {
    if (typeof p !== "string") return true;
    const path = p.replace(/:rw$/, "");
    return !(path.startsWith("/") || path.startsWith("~/")) || path.split("/").includes("..") ||
      path.includes(":");
  });
  return bad === undefined ? null : `${shape}: ${JSON.stringify(bad)} is not one`;
}

/** What `deployment.database` may hold: `sqlite`, or a Postgres URL naming the user, host
 *  and database — its password is a secret, so it rides `PGPASSWORD`, and the file stays a
 *  declaration git can hold. A complaint, or null when the value is fine. */
export function checkDatabase(v: unknown): string | null {
  if (v === "sqlite") return null;
  const shape = 'must be "sqlite" or a postgres:// URL';
  if (typeof v !== "string") return shape;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return shape;
  }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") return shape;
  if (url.password) return "must not carry a password — PGPASSWORD in .env holds it";
  if (url.pathname.length < 2) return "must name a database (postgres://user@host:5432/db)";
  return null;
}

/** The checks that would otherwise surface as a RangeError inside a turn's render or as an
 *  API rejection mid-conversation — discovered at boot instead. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** How a secret's name ends: every one the harness reads does (`ANTHROPIC_API_KEY`,
 *  `PGPASSWORD`, `WA_BRIDGE_TOKEN`). */
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD)$/i;
/** What every shell is issued already: PATH is built, TERM fixed. */
const BUILT_ENV = ["PATH", "TERM"];

function validateAgent(a: Partial<AgentDefaults>, path: string): void {
  if (a.model != null && (typeof a.model !== "string" || a.model === "")) {
    throw new Error(`${path}: model must be a model name`);
  }
  if (a.provider != null && !(PROVIDERS as readonly string[]).includes(a.provider as string)) {
    throw new Error(
      `${path}: unknown provider "${a.provider}" (one of ${PROVIDERS.join(", ")})`,
    );
  }
  if (a.maxTokens != null && !(Number.isInteger(a.maxTokens) && a.maxTokens > 0)) {
    throw new Error(`${path}: maxTokens must be a positive integer (got ${a.maxTokens})`);
  }
  if (a.effort != null && !(EFFORTS as readonly string[]).includes(a.effort)) {
    throw new Error(`${path}: unknown effort "${a.effort}" (one of ${EFFORTS.join(", ")})`);
  }
  if (a.presence != null && !PRESENCE_LEVELS.includes(a.presence)) {
    throw new Error(
      `${path}: unknown presence "${a.presence}" (one of ${PRESENCE_LEVELS.join(", ")})`,
    );
  }
  if (a.mind !== undefined && typeof a.mind !== "boolean") {
    throw new Error(`${path}: mind must be true or false`);
  }
  if (a.tools != null) {
    const ok = Array.isArray(a.tools) &&
      (a.tools as unknown[]).every((t) => typeof t === "string" && t !== "");
    if (!ok) {
      throw new Error(`${path}: tools must be an array of tool names, or null (⇒ all)`);
    }
  }
  if (a.export != null) {
    if (!Array.isArray(a.export)) {
      throw new Error(`${path}: export must be an array of environment variable names`);
    }
    for (const name of a.export as unknown[]) {
      if (typeof name !== "string" || !ENV_NAME.test(name)) {
        throw new Error(`${path}: export: "${name}" is not an environment variable name`);
      }
      if (SECRET_NAME.test(name)) {
        throw new Error(
          `${path}: export: "${name}" is a secret's name — a secret reaches a shell as the ` +
            "egress proxy's handle, never as itself",
        );
      }
      if (BUILT_ENV.includes(name)) {
        throw new Error(`${path}: export: "${name}" is the harness's to set in every shell`);
      }
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
        if (!["tool", "action", "service", "connection", "conversation"].includes(key)) {
          throw new Error(`${path}: rule "${rule.tool}": unknown field "${key}"`);
        }
      }
      for (const key of ["service", "connection", "conversation"]) {
        if (rule[key] !== undefined && typeof rule[key] !== "string") {
          throw new Error(`${path}: rule "${rule.tool}": "${key}" must be a string`);
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
