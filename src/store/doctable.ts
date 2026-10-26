/**
 * store/doctable.ts — the docs cascade on SQLite's docs table (§8, §9): the table in the
 * org's `log.db`, beside the log and the vault, read and written as `pg/docs.ts` reads and
 * writes Postgres's.
 *
 * The read port is the harness's: `list` is one query over the four scopes the context
 * names, the header columns projected from each row's text as from a file's frontmatter,
 * and the handle is the row's key, `scope/name`.
 *
 * The agent's side is `as(ctx)`: `read · write · edit` by handle, answering what the
 * Postgres functions answer, line for line. The rule the Postgres policy states is this
 * module's: a handle's owner is always the asker — its own id, its conversation's address,
 * or the org's empty owner — so no handle names another agent's row, and only the agent's
 * own scope and its conversation's take a write. The file is the harness's: a bubble shows
 * nothing of `data/log`, and a gateway's sandbox nothing of this machine.
 */

import { DatabaseSync } from "node:sqlite";
import {
  columnsOf,
  type DocCalls,
  type DocContext,
  type DocEntry,
  type DocRef,
  type DocScope,
  type DocTable,
  frontmatterOf,
  stripFrontmatter,
} from "./docs.ts";
import { applyEdits, parseEdits } from "../exec/edit.ts";
import { MAX_BYTES, truncateHead } from "../exec/truncate.ts";

const SCOPES: readonly DocScope[] = ["system", "shared", "agent", "conversation"];
const WRITABLE: readonly DocScope[] = ["agent", "conversation"];

const bytes = (s: string) => new TextEncoder().encode(s).length;
const stamp = () => new Date().toISOString();

/** Whose row a scope's is, for the agent asking; null where no row is anyone's. */
function ownerOf(scope: DocScope, ctx: DocContext): string | null {
  switch (scope) {
    case "agent":
      return ctx.agent;
    case "conversation":
      return ctx.conversation || null;
    default:
      return "";
  }
}

/** A handle, `scope/name`, as the row's key for whoever is asking. */
function refOf(handle: string, ctx: DocContext) {
  const scope = handle.split("/")[0] as DocScope;
  const name = handle.slice(scope.length + 1);
  if (!SCOPES.includes(scope) || name === "") {
    throw new Error(
      `${handle}: a handle is scope/name — system, shared, agent or conversation, then the ` +
        "doc's name",
    );
  }
  return { scope, owner: ownerOf(scope, ctx), name };
}

/** `aread` over a doc's text: from line `offset` (1-indexed), `limit` lines at most,
 *  head-truncated, never a partial line, a footer naming the line to continue from. */
function window(text: string, offset?: number, limit?: number, maxBytes?: number): string {
  const lines = text === "" ? [] : text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  const total = lines.length;
  const start = offset === undefined || offset === null || offset < 1 ? 0 : offset - 1;
  if (total > 0 && start >= total) {
    throw new Error(`offset ${offset} is beyond end of file (${total} lines)`);
  }
  const span = limit === undefined || limit === null
    ? lines.slice(start)
    : lines.slice(start, start + limit);
  const cap = maxBytes ?? MAX_BYTES;
  const t = truncateHead(span.join("\n"), { maxLines: limit ?? undefined, maxBytes: cap });
  if (t.shownLines === 0 && span.length > 0) {
    return `[line ${start + 1} alone exceeds the byte cap (${cap} bytes) — raise maxBytes]`;
  }
  const end = start + t.shownLines;
  return end < total
    ? `${t.text}\n\n[showing lines ${start + 1}-${end} of ${total} — continue from line ${end + 1}]`
    : t.text;
}

/** Open the docs table in the `log.db` under `dir`, the org's data root. */
export async function openSqliteDocs(dir: string): Promise<DocTable> {
  await Deno.mkdir(`${dir}/log`, { recursive: true });
  const db = new DatabaseSync(`${dir}/log/log.db`);
  db.exec(
    `PRAGMA busy_timeout=5000;
     PRAGMA journal_mode=WAL;
     CREATE TABLE IF NOT EXISTS docs (
       scope      TEXT NOT NULL,
       owner      TEXT NOT NULL DEFAULT '',
       name       TEXT NOT NULL,
       text       TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       PRIMARY KEY (scope, owner, name)
     );`,
  );

  const one = (scope: string, owner: string, name: string): string | null => {
    const r = db.prepare("SELECT text FROM docs WHERE scope = ? AND owner = ? AND name = ?")
      .get(scope, owner, name) as { text: string } | undefined;
    return r?.text ?? null;
  };

  /** `fn` in one write transaction: a concurrent edit waits for this one's commit. */
  const writing = <T>(fn: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      db.exec("COMMIT");
      return out;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };

  const calls = (ctx: DocContext): DocCalls => ({
    read(handle, offset, limit, maxBytes) {
      return Promise.resolve().then(() => {
        const r = refOf(handle, ctx);
        const text = r.owner === null ? null : one(r.scope, r.owner, r.name);
        if (text === null) throw new Error(`${handle}: no such doc`);
        return window(text, offset, limit, maxBytes);
      });
    },
    write(handle, content) {
      return Promise.resolve().then(() => {
        const r = refOf(handle, ctx);
        if (!WRITABLE.includes(r.scope) || r.owner === null) {
          throw new Error(`${handle}: not yours to write`);
        }
        db.prepare(
          `INSERT INTO docs (scope, owner, name, text, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (scope, owner, name) DO UPDATE
             SET text = excluded.text, updated_at = excluded.updated_at`,
        ).run(r.scope, r.owner, r.name, content, stamp());
        return `wrote ${bytes(content)} bytes to ${handle}`;
      });
    },
    edit(handle, spec) {
      return Promise.resolve().then(() =>
        writing(() => {
          const r = refOf(handle, ctx);
          const raw = r.owner === null ? null : one(r.scope, r.owner, r.name);
          if (raw === null) throw new Error(`${handle}: no such doc`);
          if (!WRITABLE.includes(r.scope)) throw new Error(`${handle}: not yours to edit`);
          const edits = parseEdits(spec);
          db.prepare(
            "UPDATE docs SET text = ?, updated_at = ? WHERE scope = ? AND owner = ? AND name = ?",
          ).run(applyEdits(raw, edits), stamp(), r.scope, r.owner!, r.name);
          return `applied ${edits.length} edit(s) to ${handle}`;
        })
      );
    },
  });

  return {
    on: "table",
    list(ctx: DocContext): Promise<DocEntry[]> {
      const found = db.prepare(
        `SELECT scope, name, text FROM docs
         WHERE (scope IN ('system', 'shared') AND owner = '')
            OR (scope = 'agent' AND owner = ?)
            OR (scope = 'conversation' AND owner = ?)
         ORDER BY CASE scope WHEN 'system' THEN 0 WHEN 'shared' THEN 1 WHEN 'agent' THEN 2
           ELSE 3 END, name`,
      ).all(ctx.agent, ctx.conversation || null) as {
        scope: DocScope;
        name: string;
        text: string;
      }[];
      const out: DocEntry[] = [];
      for (const r of found) {
        const frontmatter = frontmatterOf(r.text);
        if (frontmatter === null) continue; // a doc declares itself, as a file does (§8)
        const columns = columnsOf(frontmatter);
        const entry: DocEntry = {
          header: { scope: r.scope, name: r.name, ...columns, handle: `${r.scope}/${r.name}` },
        };
        if (columns.load === "always") entry.body = stripFrontmatter(r.text);
        out.push(entry);
      }
      return Promise.resolve(out);
    },

    read(ctx: DocContext, ref: DocRef): Promise<string | null> {
      const owner = ownerOf(ref.scope, ctx);
      const text = owner === null ? null : one(ref.scope, owner, ref.name);
      return Promise.resolve(text === null ? null : stripFrontmatter(text));
    },

    as: calls,

    laid(scope, owner, folder) {
      const r = db.prepare(
        `SELECT EXISTS (SELECT 1 FROM docs WHERE scope = ? AND owner = ?
           AND substr(name, 1, length(?) + 1) = ? || '/') AS v`,
      ).get(scope, owner, folder, folder) as { v: number };
      return Promise.resolve(r.v === 1);
    },

    lay(scope, owner, name, text) {
      const r = db.prepare(
        `INSERT INTO docs (scope, owner, name, text, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (scope, owner, name) DO NOTHING`,
      ).run(scope, owner, name, text, stamp());
      return Promise.resolve(Number(r.changes) > 0);
    },

    text: (scope, owner, name) => Promise.resolve(one(scope, owner, name)),

    swap(scope, owner, name, from, to) {
      const r = db.prepare(
        `UPDATE docs SET text = ?, updated_at = ?
         WHERE scope = ? AND owner = ? AND name = ? AND text = ?`,
      ).run(to, stamp(), scope, owner, name, from);
      return Promise.resolve(Number(r.changes) > 0);
    },

    close() {
      db.close();
      return Promise.resolve();
    },
  };
}
