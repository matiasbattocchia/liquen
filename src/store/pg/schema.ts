/**
 * store/pg/schema.ts — the store's DDL on Postgres (§8, §9).
 *
 * The same tables as the SQLite adapter, column for column, in the engine's own types
 * where the rows would not notice: a JSON column is `jsonb`, a lease stamp `bigint`. Every
 * text column is `COLLATE "C"`: byte order, as SQLite compares — an id, a timestamp, a
 * credential key and an agent name sort and bound the same on both engines, whatever the
 * database's own locale says.
 *
 * The functions are what the shared SQL calls and Postgres does not have: the law's
 * `routed` and `instr`, the roster's `digits` and `same_handle`, the read's `fold`, and
 * `json_patch` with SQLite's semantics (RFC 7396). A trigger on `events` rings the
 * change feed — `NOTIFY` on `<schema>.events` — for every statement that lands or moves
 * a row; the tail listens on it.
 *
 * Opening a store runs all of it, under an advisory lock on the schema's name, so the
 * processes an org boots at once create it once and the rest find it there. The schema
 * carries its version (`schema_version`, one row): a store behind `VERSION` is raised in
 * place before the DDL runs, and a store ahead of it belongs to a newer liquen.
 */

import { MIND } from "../../session.ts";
import type { Db, Sql } from "./sql.ts";

/** A text column: byte-ordered. */
const T = `text COLLATE "C"`;

/** The class of every combining mark — what `foldName` strips as `\p{M}` — as a Postgres
 *  bracket expression: the engine's regexes know no Unicode property, so the property is
 *  enumerated here, once, by the same runtime that applies it in the code. */
const marks = (() => {
  let built: string | undefined;
  return () => {
    if (built !== undefined) return built;
    const mark = /\p{M}/u;
    const hex = (c: number) =>
      c > 0xffff
        ? `\\U${c.toString(16).padStart(8, "0")}`
        : `\\u${c.toString(16).padStart(4, "0")}`;
    const ranges: string[] = [];
    let start = -1;
    for (let c = 0; c <= 0x110000; c++) {
      const marked = c < 0x110000 && mark.test(String.fromCodePoint(c));
      if (marked && start < 0) start = c;
      if (!marked && start >= 0) {
        ranges.push(start === c - 1 ? hex(start) : `${hex(start)}-${hex(c - 1)}`);
        start = -1;
      }
    }
    return built = `[${ranges.join("")}]`;
  };
})();

/** The functions the shared SQL calls. Each is the code's rule, restated in SQL — the
 *  Postgres suite holds the two to the same answers. */
const functions = () => `
CREATE OR REPLACE FUNCTION uuidv7() RETURNS text LANGUAGE sql VOLATILE AS $f$
  SELECT encode(set_bit(set_bit(overlay(uuid_send(gen_random_uuid()) PLACING
    substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
    FROM 1 FOR 6), 52, 1), 53, 1), 'hex')::uuid::text
$f$;

CREATE OR REPLACE FUNCTION json_patch(target jsonb, patch jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE k text; v jsonb; out jsonb;
BEGIN
  IF target IS NULL OR patch IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(patch) <> 'object' THEN RETURN patch; END IF;
  out := CASE WHEN jsonb_typeof(target) = 'object' THEN target ELSE '{}'::jsonb END;
  FOR k, v IN SELECT * FROM jsonb_each(patch) LOOP
    IF jsonb_typeof(v) = 'null' THEN
      out := out - k;
    ELSE
      out := jsonb_set(out, ARRAY[k], json_patch(coalesce(out -> k, 'null'::jsonb), v));
    END IF;
  END LOOP;
  RETURN out;
END
$f$;

CREATE OR REPLACE FUNCTION flag(j jsonb, k text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$
  SELECT coalesce(j -> k IN ('true'::jsonb, '1'::jsonb), false)
$f$;

CREATE OR REPLACE FUNCTION fold(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT btrim(regexp_replace(lower(regexp_replace(normalize(s, NFD), '${marks()}', '', 'g')),
    '\\s+', ' ', 'g'))
$f$;

CREATE OR REPLACE FUNCTION digits(s text) RETURNS text LANGUAGE sql IMMUTABLE AS $f$
  SELECT regexp_replace(s, '[^0-9]', '', 'g')
$f$;

CREATE OR REPLACE FUNCTION same_handle(a text, b text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $f$
  SELECT CASE
    WHEN coalesce(a, '') = '' OR coalesce(b, '') = '' THEN false
    WHEN regexp_replace(a, '^\\s+|\\s+$', '', 'g') ~ '^[0-9\\s+().-]+$'
     AND regexp_replace(b, '^\\s+|\\s+$', '', 'g') ~ '^[0-9\\s+().-]+$'
      THEN digits(a) <> '' AND digits(a) = digits(b)
    ELSE lower(regexp_replace(a, '^\\s+|\\s+$', '', 'g'))
       = lower(regexp_replace(b, '^\\s+|\\s+$', '', 'g'))
  END
$f$;

CREATE OR REPLACE FUNCTION instr(haystack text, needle text) RETURNS integer
LANGUAGE sql IMMUTABLE AS $f$
  SELECT strpos(haystack, needle)
$f$;

-- the routing function (session.ts): which of an agent's sessions a connection's traffic
-- belongs to
CREATE OR REPLACE FUNCTION routed(service text, connection text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT '${MIND}'::text
$f$;
`;

/** The log's tables, its change feed, and the roster views over them. */
export const LOG_DDL = `
CREATE TABLE IF NOT EXISTS events (
  id                   ${T} PRIMARY KEY DEFAULT uuidv7(),
  external_id          ${T},
  type                 ${T} NOT NULL,
  service              ${T},
  connection_address   ${T},
  conversation_address ${T},
  conversation_name    ${T},
  conversation_thread  ${T},
  conversation_kind    ${T},
  session_id           ${T},
  sender_address       ${T},
  sender_name          ${T},
  agent_id             ${T},
  timestamp            ${T} NOT NULL,
  created_at           ${T} NOT NULL,
  updated_at           ${T} NOT NULL,
  text                 ${T},
  parts                jsonb,
  payload              jsonb NOT NULL,
  extra                jsonb,
  status               jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS events_external ON events (external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_conv ON events (conversation_address);
CREATE INDEX IF NOT EXISTS events_timestamp ON events (timestamp);
CREATE INDEX IF NOT EXISTS events_session ON events (session_id);
CREATE INDEX IF NOT EXISTS events_agent ON events (agent_id);
CREATE INDEX IF NOT EXISTS events_updated ON events (updated_at, id)
  WHERE updated_at > created_at;
CREATE INDEX IF NOT EXISTS events_state ON events ((status ->> 'state'));
CREATE INDEX IF NOT EXISTS events_ref ON events (type, (payload ->> 'ref_id'));

CREATE OR REPLACE FUNCTION events_rang() RETURNS trigger LANGUAGE plpgsql AS $f$
BEGIN
  PERFORM pg_notify(TG_TABLE_SCHEMA || '.events', '');
  RETURN NULL;
END
$f$;
CREATE OR REPLACE TRIGGER events_rang AFTER INSERT OR UPDATE ON events
  FOR EACH STATEMENT EXECUTE FUNCTION events_rang();

CREATE TABLE IF NOT EXISTS usage (
  created_at         ${T} NOT NULL,
  agent_id           ${T},
  turn_id            ${T},
  kind               ${T},
  model              ${T} NOT NULL,
  input_tokens       integer NOT NULL,
  output_tokens      integer NOT NULL,
  cache_read_tokens  integer,
  cache_write_tokens integer
);

CREATE TABLE IF NOT EXISTS locks (
  name   ${T} PRIMARY KEY,
  born   bigint NOT NULL,
  seen   bigint NOT NULL,
  cancel integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agents (
  agent_id   ${T} PRIMARY KEY,
  mind       ${T} NOT NULL,
  provider   ${T},
  model      ${T},
  effort     ${T},
  name       ${T},
  email      ${T},
  phone      ${T},
  principals jsonb,
  runs       integer NOT NULL DEFAULT 1,
  settings   jsonb,
  created_at ${T} NOT NULL,
  updated_at ${T} NOT NULL
);

CREATE TABLE IF NOT EXISTS rules (
  agent_id     ${T} NOT NULL,
  tool         ${T} NOT NULL,
  connection   ${T} NOT NULL DEFAULT '',
  conversation ${T} NOT NULL DEFAULT '',
  action       ${T} NOT NULL,
  updated_at   ${T} NOT NULL,
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  PRIMARY KEY (agent_id, tool, connection, conversation)
);

CREATE TABLE IF NOT EXISTS connections (
  service        ${T} NOT NULL,
  address        ${T} NOT NULL,
  agent_id       ${T},
  credential_key ${T},
  extra          jsonb,
  created_at     ${T} NOT NULL,
  updated_at     ${T} NOT NULL,
  deleted_at     ${T},
  PRIMARY KEY (service, address)
);
CREATE TABLE IF NOT EXISTS memberships (
  service              ${T} NOT NULL,
  connection_address   ${T} NOT NULL,
  conversation_address ${T} NOT NULL,
  agent_id             ${T} NOT NULL,
  session_id           ${T} NOT NULL,
  created_at           ${T} NOT NULL,
  deleted_at           ${T},
  PRIMARY KEY (service, connection_address, conversation_address, agent_id, session_id)
);

CREATE TABLE IF NOT EXISTS timers (
  id           ${T} PRIMARY KEY,
  agent_id     ${T} NOT NULL,
  session_id   ${T} NOT NULL,
  fire_at      ${T} NOT NULL,
  cron         ${T},
  note         ${T} NOT NULL,
  name         ${T},
  conversation ${T} NOT NULL,
  ref_id       ${T},
  created_at   ${T} NOT NULL
);
CREATE INDEX IF NOT EXISTS timers_due ON timers (fire_at);
CREATE UNIQUE INDEX IF NOT EXISTS timers_named ON timers (agent_id, session_id, name)
  WHERE name IS NOT NULL;

CREATE OR REPLACE VIEW speaks AS
  SELECT a.agent_id, c.agent_id AS owner, c.service, c.address, c.extra
  FROM agents a JOIN connections c
    ON c.deleted_at IS NULL
   AND (c.agent_id = a.agent_id
        OR (c.agent_id IS NULL
            AND (c.extra ->> 'agent' = a.agent_id
                 OR same_handle(c.address, a.phone) OR same_handle(c.address, a.email))));
CREATE OR REPLACE VIEW principals AS
  SELECT a.agent_id, p.value COLLATE "C" AS principal, (p.ord - 1)::integer AS rank
  FROM agents a,
       jsonb_array_elements_text(coalesce(a.principals, '[]'::jsonb)) WITH ORDINALITY p(value, ord)
  UNION ALL
  SELECT a.agent_id, b.agent_id, 0
  FROM agents a CROSS JOIN agents b
  WHERE a.principals IS NULL
    AND EXISTS (SELECT 1 FROM speaks s WHERE s.agent_id = a.agent_id AND s.owner IS NULL)
  UNION ALL
  SELECT a.agent_id, a.agent_id, 0
  FROM agents a
  WHERE a.principals IS NULL
    AND NOT EXISTS (SELECT 1 FROM speaks s WHERE s.agent_id = a.agent_id AND s.owner IS NULL);
CREATE OR REPLACE VIEW aliases AS
  SELECT service, address AS connection,
         coalesce(extra ->> 'self_conversation',
                  CASE service WHEN 'whatsapp' THEN address END) COLLATE "C" AS conversation,
         agent_id, agent_id AS principal, (deleted_at IS NULL)::integer AS live
  FROM connections
  WHERE agent_id IS NOT NULL
    AND (extra ->> 'self_conversation' IS NOT NULL OR service = 'whatsapp')
  UNION ALL
  SELECT s.service, s.address, digits(w.phone), s.agent_id, p.principal, 1
  FROM speaks s
    JOIN principals p ON p.agent_id = s.agent_id
    JOIN agents w ON w.agent_id = p.principal
  WHERE s.service = 'whatsapp' AND w.phone IS NOT NULL AND w.phone <> ''
    AND digits(s.address) <> digits(w.phone)
  UNION ALL
  SELECT s.service, s.address, d.value #>> '{}', s.agent_id, d.key, 1
  FROM speaks s
    CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(s.extra -> 'dms') = 'object'
                                       THEN s.extra -> 'dms' END) d
    JOIN principals p ON p.agent_id = s.agent_id AND p.principal = d.key
  WHERE s.service = 'slack' AND jsonb_typeof(d.value) = 'string';
`;

/** The vault's tables (§4): one schema holds the log and the vault, as one file does. */
export const VAULT_DDL = `
CREATE TABLE IF NOT EXISTS credentials (
  key        ${T} PRIMARY KEY,
  value      jsonb NOT NULL,
  agent_id   ${T},
  extra      jsonb,
  created_at ${T} NOT NULL,
  updated_at ${T} NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state   ${T} PRIMARY KEY,
  service ${T} NOT NULL,
  extra   jsonb,
  born    bigint NOT NULL,
  used    integer NOT NULL DEFAULT 0
);
`;

/** The version the DDL creates. A store found below it is raised in place, once, by the
 *  steps between; a store above it was made by a newer liquen, and this one refuses it. */
export const VERSION = 1;

/** `RAISE[v]` takes a store from version `v` to `v + 1`: the ALTERs the DDL's `IF NOT
 *  EXISTS` cannot express, run before the DDL so the views it replaces find their columns.
 *  A version with no entry is raised by the DDL alone — a table or an index added. */
const RAISE: Record<number, (tx: Db) => Promise<void>> = {};

/** Open the schema: create it when absent, raise it when behind, and run the DDL — every
 *  table `IF NOT EXISTS`, every function and view `OR REPLACE`, so the definitions are the
 *  last opener's. Once across every process opening it at the same moment: the advisory
 *  lock is the schema's name, held for the transaction. */
export async function prepare(sql: Sql, schema: string): Promise<void> {
  await sql.begin(async (tx) => {
    await tx.unsafe("SELECT pg_advisory_xact_lock(hashtext($1::text))", [`liquen:${schema}`]);
    await tx.unsafe(`CREATE SCHEMA IF NOT EXISTS ${ident(schema)}`);
    await tx.unsafe("CREATE TABLE IF NOT EXISTS schema_version (version integer NOT NULL)");
    const [found] = await tx.unsafe("SELECT version FROM schema_version") as unknown as {
      version: number;
    }[];
    if (found !== undefined && found.version > VERSION) {
      throw new Error(
        `the store in ${schema} is at schema version ${found.version}; this liquen knows ` +
          `${VERSION} — update the org`,
      );
    }
    for (let v = found?.version ?? VERSION; v < VERSION; v++) await RAISE[v]?.(tx);
    await tx.unsafe(functions() + LOG_DDL + VAULT_DDL);
    if (found === undefined) {
      await tx.unsafe("INSERT INTO schema_version (version) VALUES ($1::integer)", [VERSION]);
    } else if (found.version < VERSION) {
      await tx.unsafe("UPDATE schema_version SET version = $1::integer", [VERSION]);
    }
  });
}

/** A name quoted as an identifier. */
export function ident(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
