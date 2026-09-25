/**
 * store/pg/docs.ts — the docs cascade on a table (§8, §9): the file adapter's read port
 * as SELECTs over `docs`, and the agent's own reach into it.
 *
 * The read port is the harness's, privileged: `list` is one query over the four scopes
 * the context names — the org's two, the agent's own, the session's conversation — and
 * the header columns are projected from each row's text as they are from a file's
 * frontmatter. The handle is the row's key, `scope/name`.
 *
 * The agent's side is `as(ctx)`: `read · write · edit` by handle, each one transaction
 * that switches to the agent role, sets the agent and the conversation for the policies
 * to read, and calls the function of the same name (`schema.ts`). What the agent may
 * touch is the table's policy, and nothing here.
 */

import {
  columnsOf,
  type DocContext,
  type DocEntry,
  type DocRef,
  type Docs,
  type DocScope,
  frontmatterOf,
  stripFrontmatter,
} from "../docs.ts";
import { connect, count, rows, scrub, type Sql } from "./sql.ts";
import { AGENT_ROLE, prepare } from "./schema.ts";

/** The binaries' contracts (`bin/afs.ts`), as the agent calls them on the table. Each
 *  answers the line the binary prints, or throws what it would report. */
export interface DocCalls {
  read(handle: string, offset?: number, limit?: number, maxBytes?: number): Promise<string>;
  write(handle: string, content: string): Promise<string>;
  edit(handle: string, spec: string): Promise<string>;
}

export interface PgDocs extends Docs {
  /** The agent's reach: its calls, bounded to what `ctx` may see and write. */
  as(ctx: DocContext): DocCalls;
  /** Whether a row of the scope lies under `folder/` — the seed's unit of if-absent. */
  laid(scope: DocScope, owner: string, folder: string): Promise<boolean>;
  /** Lay a row where none is. Answers whether it wrote. */
  lay(scope: DocScope, owner: string, name: string, text: string): Promise<boolean>;
  close(): Promise<void>;
}

const SCOPE_ORDER: DocScope[] = ["system", "organization", "agent", "conversation"];

/** Open the docs table in `schema` of the database at `url`. */
export async function openPgDocs(url: string, opts: { schema?: string } = {}): Promise<PgDocs> {
  const schema = opts.schema ?? "public";
  const sql: Sql = connect(url, schema);
  try {
    await prepare(sql, schema);
  } catch (err) {
    await sql.end();
    throw err;
  }

  /** The rows a context may see. */
  const VISIBLE = `(scope, owner) IN (('system', ''), ('organization', ''),
    ('agent', $1::text), ('conversation', $2::text))`;
  const ownerOf = (scope: DocScope, ctx: DocContext): string | null => {
    switch (scope) {
      case "agent":
        return ctx.agent;
      case "conversation":
        return ctx.conversation ?? null;
      default:
        return "";
    }
  };

  const call = <T>(ctx: DocContext, text: string, params: unknown[]): Promise<T> =>
    sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${AGENT_ROLE}`);
      await tx.unsafe(
        "SELECT set_config('liquen.agent', $1::text, true), " +
          "set_config('liquen.conversation', $2::text, true)",
        [ctx.agent, ctx.conversation ?? ""],
      );
      const [r] = await rows<{ v: T }>(tx, text, params);
      return r.v;
    }) as Promise<T>;

  return {
    on: "table",
    async list(ctx: DocContext): Promise<DocEntry[]> {
      const found = await rows<{ scope: DocScope; name: string; text: string }>(
        sql,
        `SELECT scope, name, text FROM docs WHERE ${VISIBLE}
         ORDER BY array_position($3::text[], scope), name`,
        [ctx.agent, ctx.conversation ?? null, SCOPE_ORDER],
      );
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
      return out;
    },

    async read(ctx: DocContext, ref: DocRef): Promise<string | null> {
      const owner = ownerOf(ref.scope, ctx);
      if (owner === null) return null;
      const [r] = await rows<{ text: string }>(
        sql,
        "SELECT text FROM docs WHERE scope = $1::text AND owner = $2::text AND name = $3::text",
        [ref.scope, owner, ref.name],
      );
      return r === undefined ? null : stripFrontmatter(r.text);
    },

    as(ctx: DocContext): DocCalls {
      return {
        read: (handle, offset, limit, maxBytes) =>
          call<string>(
            ctx,
            "SELECT docs_read($1::text, $2::integer, $3::integer, $4::integer) AS v",
            [handle, offset ?? null, limit ?? null, maxBytes ?? null],
          ),
        write: (handle, content) =>
          call<string>(ctx, "SELECT docs_write($1::text, $2::text) AS v", [
            handle,
            scrub(content),
          ]),
        edit: (handle, spec) =>
          call<string>(ctx, "SELECT docs_edit($1::text, $2::text) AS v", [handle, scrub(spec)]),
      };
    },

    async laid(scope, owner, folder) {
      const [r] = await rows<{ v: boolean }>(
        sql,
        `SELECT EXISTS (SELECT 1 FROM docs WHERE scope = $1::text AND owner = $2::text
           AND name LIKE $3::text || '/%') AS v`,
        [scope, owner, folder],
      );
      return r.v;
    },

    lay: (scope, owner, name, text) =>
      count(
        sql,
        `INSERT INTO docs (scope, owner, name, text, updated_at)
         VALUES ($1::text, $2::text, $3::text, $4::text, docs_stamp())
         ON CONFLICT (scope, owner, name) DO NOTHING`,
        [scope, owner, name, scrub(text)],
      ).then((n) => n > 0),

    close: () => sql.end(),
  };
}
