/**
 * store/seed.ts — the docs a release lays in an org, and brings to it again (§8, §9).
 *
 * The templates are REAL files in `src/seed/` — readable and editable by the developer
 * before any deployment, shadcn-style; this module copies them into the org's docs,
 * wherever those live (§9 layout: `system/` · `shared/` · `agents/<name>/` on files, the
 * same scopes as rows of the docs table). They come in two kinds, told apart by whose
 * words they are once laid:
 *
 *   scaffolds     the org's from the moment they are laid, and no release touches them
 *                 again: `shared/instructions.md` and `shared/memories.md` (`seedOrg`,
 *                 what `liquen init` lays with the catalog), and each agent's
 *                 `instructions.md` and `memories.md` (`seedAgent`, laid when the agent
 *                 is made). Placeholders meant to be EDITED per deployment; each is laid
 *                 only where the file is missing. Memory hygiene lives in the template
 *                 text, not in code.
 *   system docs   the release's words, kept under `system/` where agents read them: the
 *                 instructions, one file per skill the harness teaches; the tool docs
 *                 (tooldoc.ts); `compaction`; the skills shipped, and the ones a
 *                 connector's door lays (`seedSkill`), which reach exactly the orgs that
 *                 connect the service. Each is brought one by one (`bringSystemDocs`), so
 *                 a doc a release adds reaches every org and one it rewords reaches every
 *                 org that left it as it was.
 *
 * What the org has taken is the MANIFEST, a table of the store whatever `deployment.docs`
 * says: per system doc, the hash of the release text the org last took or acknowledged.
 * Against it a doc is unedited (the file is the text the row names), edited, or deleted,
 * and a release has changed it or has not. The unambiguous cases are applied by whoever
 * runs this, boot included; the ambiguous ones wait for a `decide`, which `liquen update`
 * gives and boot does not:
 *
 *   release             the org's doc          applied by   what happens
 *   ships it, no row    missing                anyone       laid: new in this release
 *   ships it            as the release's       anyone       recorded
 *   changed it          unedited               anyone       replaced
 *   dropped it          unedited               anyone       deleted
 *   changed it          edited                 decide       replaced, kept, or the
 *                                                           release's laid beside it
 *   changed it          deleted                decide       laid again, or kept deleted
 *   dropped it          edited                 decide       deleted, or kept
 *   did not change it   edited or deleted      nobody       the org's choice stands
 *
 * An org with docs and no manifest ADOPTS it: each doc that matches the release is
 * recorded as taken, and every other, a missing one included, is the org's choice,
 * acknowledged at this release and quiet until a later one changes it.
 *
 * Folders are convention only in the data root — discovery is recursive there and kind
 * rides in frontmatter (§8). The org and agent templates are flat (`organization.md`,
 * `agent.md`, `memories.md`): their home has an id segment no template can name.
 *
 * `deno compile` note: embed the templates with `--include src/seed`.
 */

import type { DocScope } from "./docs.ts";

const TEMPLATES = new URL("../seed/", import.meta.url);

// fetched, not read: the templates are where the package is — a checkout's files or the
// registry's URLs — and fetch answers for both
const read = (rel: string) => fetch(new URL(rel, TEMPLATES)).then((r) => r.text());

/** Where a scaffold is laid: files under a data root, or rows of the docs table. A doc is
 *  named as the table keys it — the scope, the owner (an agent's id, empty for the org's
 *  two scopes), the scope-relative name. */
export interface Seedbed {
  /** Lay one doc where none is. Answers whether it wrote. */
  lay(scope: DocScope, owner: string, name: string, text: string): Promise<boolean>;
}

/** A bed a release's words are brought into (`bringSystemDocs`): a doc read as laid,
 *  replaced only while it still reads that way, and taken out. */
export interface Relaybed extends Seedbed {
  /** One doc's whole text, frontmatter included, or null where none is. */
  text(scope: DocScope, owner: string, name: string): Promise<string | null>;
  /** Replace one doc's text with `to` while it is still `from`. Answers whether it wrote. */
  swap(scope: DocScope, owner: string, name: string, from: string, to: string): Promise<boolean>;
  /** Take one doc out. Answers whether there was one. */
  drop(scope: DocScope, owner: string, name: string): Promise<boolean>;
  /** Lay `text` beside the doc, under a name nothing loads (`<name>.md.new`). Absent
   *  where docs are rows: every row is a doc. */
  beside?(scope: DocScope, owner: string, name: string, text: string): Promise<void>;
}

/** A doc's path under the data root. */
const pathOf = (root: string, scope: DocScope, owner: string, name: string) =>
  `${root}/${scopeDir(scope, owner)}/${name}.md`;
const scopeDir = (scope: DocScope, owner: string) => scope === "agent" ? `agents/${owner}` : scope;

/** The files under a data root. */
export function onFiles(root: string): Relaybed {
  const text = (scope: DocScope, owner: string, name: string) =>
    Deno.readTextFile(pathOf(root, scope, owner, name)).catch((err) => {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    });
  const write = async (path: string, text: string) => {
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeTextFile(path, text);
  };
  return {
    text,
    async swap(scope, owner, name, from, to) {
      if (await text(scope, owner, name) !== from) return false;
      await write(pathOf(root, scope, owner, name), to);
      return true;
    },
    async lay(scope, owner, name, text) {
      const path = pathOf(root, scope, owner, name);
      if (await Deno.lstat(path).then(() => true, () => false)) return false;
      await write(path, text);
      return true;
    },
    drop: (scope, owner, name) =>
      Deno.remove(pathOf(root, scope, owner, name)).then(() => true, (err) => {
        if (err instanceof Deno.errors.NotFound) return false;
        throw err;
      }),
    beside: (scope, owner, name, text) => write(`${pathOf(root, scope, owner, name)}.new`, text),
  };
}

/** The builtin tools whose words are docs (tooldoc.ts), one `kind: tool` file each under
 *  `system/tools/`. */
const TOOL_DOCS = [
  "send",
  "search",
  "cancel",
  "conversation",
  "contact",
  "bash",
  "read",
  "write",
  "edit",
];

/** The skills the system instructions teach, one `instructions/<NN>-<skill>.md` each. The
 *  number is the load order, `core` first with the voices the others lean on, and its gaps
 *  leave room for a skill between two. */
const SKILL_INSTRUCTIONS = [
  "10-core",
  "20-continuity",
  "30-permissions",
  "40-async",
  "50-peers",
  "60-knowledge",
  "70-memory",
  "80-people",
  "90-agenda",
];

/** The system docs every org has, by name under `system/`; the template of each is
 *  `system/<name>.md`. */
const SYSTEM_DOCS = [
  ...SKILL_INSTRUCTIONS.map((skill) => `instructions/${skill}`),
  "compaction",
  ...TOOL_DOCS.map((tool) => `tools/${tool}`),
  "skills/workflows",
  "skills/transcribe-audio",
];

/** The skills a connector's door lays: system docs of the orgs that connected the
 *  service, and of no other. */
const DOOR_SKILLS = ["skills/microsoft-graph"];

const templateOf = (doc: string) => `system/${doc}.md`;

/** A doc's key in the manifest. */
const keyOf = (doc: string) => `doc:system/${doc}`;

/** The hash a text is known to the manifest by. */
export async function hashOf(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The org's half of the scaffolds: what every agent in this deployment reads, its to
 *  write. */
export async function seedOrg(bed: Seedbed): Promise<void> {
  await bed.lay("shared", "", "instructions", await read("organization.md"));
  await bed.lay("shared", "", "memories", await read("memories.md"));
}

/** One agent's scaffolds: the persona to write and the memories to keep, which lay the
 *  home — its workspace — on files. A person alone (§4) has no home and gets none. */
export async function seedAgent(bed: Seedbed, agentId: string): Promise<void> {
  await bed.lay("agent", agentId, "instructions", await read("agent.md"));
  await bed.lay("agent", agentId, "memories", await read("memories.md"));
}

/** The manifest, as the store keeps it (`store/agents.ts`). */
export interface DocManifest {
  manifest(): Promise<Record<string, string>>;
  setManifest(entries: Record<string, string | null>): Promise<void>;
}

/** A connector's skill, laid by the connector's own door (`liquen connect <service>`), so
 *  it reaches exactly the orgs that connect the service, and recorded as taken. An edited
 *  skill is kept. Answers whether it wrote. */
export async function seedSkill(
  bed: Seedbed,
  manifest: DocManifest,
  name: string,
): Promise<boolean> {
  const doc = `skills/${name}`;
  const text = await read(templateOf(doc));
  const wrote = await bed.lay("system", "", doc, text);
  if (wrote) await manifest.setManifest({ [keyOf(doc)]: await hashOf(text) });
  return wrote;
}

/** A doc the release and the org disagree on, for a `decide` to settle: the org `edited`
 *  one the release changed, `deleted` one the release changed, or edited one the release
 *  `dropped`. */
export interface Pending {
  doc: string;
  state: "edited" | "deleted" | "dropped";
}

/** What a `decide` may answer. `replace` takes the release's word over the org's: its
 *  text for a doc it changed, the doc gone for one it dropped. `restore` lays again what
 *  the org deleted. `beside` lays the release's text as `<doc>.md.new`, which nothing
 *  loads. `keep` takes the org's as acknowledged: the row records the release's hash, and
 *  the doc is quiet until a release changes it again. */
export type Choice = "replace" | "restore" | "beside" | "keep";

/** The choices a pending doc may be answered with. */
export function choicesFor(p: Pending, bed: Relaybed): Choice[] {
  if (p.state === "deleted") return ["restore", "keep"];
  if (p.state === "dropped") return ["replace", "keep"];
  return bed.beside ? ["replace", "beside", "keep"] : ["replace", "keep"];
}

/** What bringing a release's system docs did, by doc, and what it left for a decision. */
export interface Brought {
  laid: string[];
  replaced: string[];
  deleted: string[];
  /** Laid beside the org's own, as `<doc>.md.new`. */
  beside: string[];
  /** The org's choice, acknowledged at this release. */
  kept: string[];
  /** Still as the org left them, with nobody to decide. */
  pending: Pending[];
}

/** Bring this release's system docs into an org (the rules: this module's header). The
 *  unambiguous cases are applied; each ambiguous one is handed to `decide`, and stays as
 *  the org left it when `decide` answers nothing. The plan is idempotent, so boot and
 *  `liquen update` may run it in either order, as often as they like. With no `manifest`
 *  — a folder nothing has booted, which `liquen init` lays — every doc missing is laid. */
export async function bringSystemDocs(
  bed: Relaybed,
  manifest?: DocManifest,
  decide: (p: Pending) => Promise<Choice | undefined> = () => Promise.resolve(undefined),
): Promise<Brought> {
  const out: Brought = { laid: [], replaced: [], deleted: [], beside: [], kept: [], pending: [] };
  const held = async (doc: string) => await bed.text("system", "", doc);
  if (!manifest) {
    for (const doc of SYSTEM_DOCS) {
      if (await bed.lay("system", "", doc, await read(templateOf(doc)))) out.laid.push(doc);
    }
    return out;
  }
  const rows = await manifest.manifest();
  const record: Record<string, string | null> = {};
  // an org that has docs and no manifest takes it up: what matches the release is taken,
  // and everything else, a missing doc included, is its choice
  const known = Object.keys(rows).some((key) => key.startsWith("doc:"));
  let adopting = false;
  if (!known) {
    for (const doc of SYSTEM_DOCS) {
      if (await held(doc) !== null) {
        adopting = true;
        break;
      }
    }
  }
  for (const doc of [...SYSTEM_DOCS, ...DOOR_SKILLS]) {
    const now = await read(templateOf(doc));
    const release = await hashOf(now);
    const row = rows[keyOf(doc)];
    const file = await held(doc);
    if (file === now) {
      if (row !== release) record[keyOf(doc)] = release;
      continue;
    }
    if (row === undefined) {
      const doors = DOOR_SKILLS.includes(doc);
      if (file === null && doors) continue; // a door's skill is the door's to lay
      if (file === null && !adopting) {
        if (await bed.lay("system", "", doc, now)) out.laid.push(doc);
        record[keyOf(doc)] = release;
        continue;
      }
      // the org's own: a doc it holds in its own words, or one it deleted before it
      // kept a manifest
      record[keyOf(doc)] = release;
      out.kept.push(doc);
      continue;
    }
    if (row === release) continue; // the release left these words alone: the org's stand
    if (file !== null && await hashOf(file) === row) {
      if (await bed.swap("system", "", doc, file, now)) {
        out.replaced.push(doc);
        record[keyOf(doc)] = release;
      }
      continue;
    }
    const pending: Pending = { doc, state: file === null ? "deleted" : "edited" };
    const choice = await decide(pending);
    if (choice === "keep") {
      record[keyOf(doc)] = release;
      out.kept.push(doc);
    } else if (choice === "restore" && file === null) {
      if (await bed.lay("system", "", doc, now)) out.laid.push(doc);
      record[keyOf(doc)] = release;
    } else if (choice === "replace" && file !== null) {
      if (await bed.swap("system", "", doc, file, now)) out.replaced.push(doc);
      record[keyOf(doc)] = release;
    } else if (choice === "beside" && file !== null && bed.beside) {
      await bed.beside("system", "", doc, now);
      out.beside.push(doc);
      out.pending.push(pending);
    } else out.pending.push(pending);
  }
  // what the manifest names and this release does not ship: dropped
  const shipped = new Set([...SYSTEM_DOCS, ...DOOR_SKILLS].map(keyOf));
  for (const [key, row] of Object.entries(rows)) {
    if (!key.startsWith("doc:system/") || shipped.has(key)) continue;
    const doc = key.slice("doc:system/".length);
    const file = await held(doc);
    if (file === null) {
      record[key] = null;
      continue;
    }
    const unedited = await hashOf(file) === row;
    const pending: Pending = { doc, state: "dropped" };
    const choice = unedited ? "replace" : await decide(pending);
    if (choice === "replace") {
      if (await bed.drop("system", "", doc)) out.deleted.push(doc);
      record[key] = null;
    } else if (choice === "keep") {
      // the org's own doc from here on: the manifest lets go of it
      record[key] = null;
      out.kept.push(doc);
    } else out.pending.push(pending);
  }
  if (Object.keys(record).length > 0) await manifest.setManifest(record);
  return out;
}
