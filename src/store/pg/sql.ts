/**
 * store/pg/sql.ts — a connection to the Postgres store, and the statements the adapters
 * share with it (§9).
 *
 * Rows come back the way SQLite hands them: a JSON column is its text and a `bigint` is a
 * number, so the row mappers of the SQLite adapter read these rows unchanged. A `Store`
 * lives in one schema, named by the caller; the connection's `search_path` is that schema
 * alone, so every unqualified name in the SQL is the store's.
 */

import postgres from "postgres";

export type Sql = postgres.Sql;
/** What a statement runs on: the pool, or a transaction's connection. */
export type Db = Pick<postgres.Sql, "unsafe">;

/** One client on the store's schema — a process's own handle, pooled. */
export function connect(url: string, schema?: string): Sql {
  return postgres(url, {
    ...(schema !== undefined ? { connection: { search_path: schema } } : {}),
    onnotice: () => {}, // `IF NOT EXISTS` speaks on every open
    types: {
      // a JSON column as its text: the row mappers parse it, on either engine
      json: { to: 114, from: [114, 3802], serialize: (x: string) => x, parse: (x: string) => x },
      // epoch milliseconds and counts fit a double; the lease compares them as numbers
      bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: Number },
    },
  });
}

/** A statement written with SQLite's placeholders — `?` in order, and the law's named
 *  `$name` — as Postgres numbers them. A string bound where the text does not say its
 *  type is cast to `text`: Postgres infers no type for a bare parameter. A placeholder
 *  already followed by a cast keeps its own. */
export function compile(
  text: string,
  positional: readonly unknown[] = [],
  named: Readonly<Record<string, unknown>> = {},
): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const at = new Map<string, number>();
  let next = 0;
  const out = text.replace(
    /(\?|\$([a-z_][a-z0-9_]*))(::)?/g,
    (_m, token: string, name: string | undefined, cast: string | undefined) => {
      let n: number;
      let value: unknown;
      if (token === "?") {
        if (next >= positional.length) throw new Error("sql: more `?` than values");
        value = positional[next++];
        params.push(value);
        n = params.length;
      } else {
        if (!(name! in named)) throw new Error(`sql: $${name} is not bound`);
        value = named[name!];
        if (!at.has(name!)) {
          params.push(value);
          at.set(name!, params.length);
        }
        n = at.get(name!)!;
      }
      return `$${n}${cast ?? (typeof value === "string" ? "::text" : "")}`;
    },
  );
  if (next !== positional.length) throw new Error("sql: more values than `?`");
  return { text: out, params };
}

/** `v` with every NUL in its strings replaced by U+FFFD, however deep: neither `text` nor
 *  `jsonb` holds a NUL, so a draft that carries one lands with the replacement character
 *  where it was. */
export function scrub<T>(v: T): T {
  if (typeof v === "string") return (v.includes("\0") ? v.replaceAll("\0", "�") : v) as T;
  if (Array.isArray(v)) return v.map(scrub) as T;
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = scrub(x);
    return out as T;
  }
  return v;
}

/** Run a statement, answering its rows. */
export async function rows<T>(db: Db, text: string, params: unknown[] = []): Promise<T[]> {
  return Array.from(await db.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as T[];
}

/** Run a statement, answering how many rows it touched. */
export async function count(db: Db, text: string, params: unknown[] = []): Promise<number> {
  return (await db.unsafe(text, params as postgres.ParameterOrJSON<never>[])).count;
}
