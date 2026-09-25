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

/** The role every agent's substrate calls run as (§8, §9): one for the cluster, NOLOGIN,
 *  granted to the store's owner so a transaction may `SET LOCAL ROLE` to it. */
export const AGENT_ROLE = "liquen_agent";

/** The docs table (§8), and the agent's side of it: the policies that bound what the
 *  agent role reads and writes, and the substrate functions — `docs_read`, `docs_write`,
 *  `docs_edit` — the binaries' contracts (`bin/afs.ts`) restated in PL/pgSQL, which the
 *  harness calls under that role with the agent and its conversation set as
 *  `liquen.agent` and `liquen.conversation` for the transaction.
 *
 *  A row is a doc: its text is what a file holds, frontmatter included, and the header
 *  columns are projected from it by the reader as they are from a file. The key is
 *  `(scope, owner, name)` — the owner is the agent's id or the conversation's address,
 *  and empty for the two scopes shared by the org — and the handle the agent reads,
 *  writes and edits by is `scope/name`: the owner is whoever is asking.
 *
 *  The policy is the container's ownership rule: an agent reads the scopes above it and
 *  its own, writes its own scope and its conversation's, and reaches nothing else. It is
 *  the one rule; the functions run as their caller (`SECURITY INVOKER`) so it applies to
 *  every statement they make. */
const docsDdl = (schema: string) => `
CREATE TABLE IF NOT EXISTS docs (
  scope      ${T} NOT NULL,
  owner      ${T} NOT NULL DEFAULT '',
  name       ${T} NOT NULL,
  text       ${T} NOT NULL,
  updated_at ${T} NOT NULL,
  PRIMARY KEY (scope, owner, name)
);

DO $d$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AGENT_ROLE}') THEN
    CREATE ROLE ${AGENT_ROLE} NOLOGIN;
  END IF;
END $d$;
GRANT ${AGENT_ROLE} TO CURRENT_USER;
GRANT USAGE ON SCHEMA ${ident(schema)} TO ${AGENT_ROLE};
GRANT SELECT, INSERT, UPDATE, DELETE ON docs TO ${AGENT_ROLE};

-- whose row a scope's is, for the agent asking: the settings the harness sets for the
-- transaction; unset, no row is anyone's
CREATE OR REPLACE FUNCTION docs_owner(scope text) RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT CASE scope
    WHEN 'system' THEN '' WHEN 'organization' THEN ''
    WHEN 'agent' THEN nullif(current_setting('liquen.agent', true), '')
    WHEN 'conversation' THEN nullif(current_setting('liquen.conversation', true), '')
  END
$f$;

ALTER TABLE docs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS docs_reads ON docs;
CREATE POLICY docs_reads ON docs FOR SELECT TO ${AGENT_ROLE}
  USING (owner = docs_owner(scope));
DROP POLICY IF EXISTS docs_writes ON docs;
CREATE POLICY docs_writes ON docs FOR ALL TO ${AGENT_ROLE}
  USING (scope IN ('agent', 'conversation') AND owner = docs_owner(scope))
  WITH CHECK (scope IN ('agent', 'conversation') AND owner = docs_owner(scope));

-- a handle, \`scope/name\`, as the row's key for whoever is asking
CREATE OR REPLACE FUNCTION docs_ref(handle text, OUT scope text, OUT owner text, OUT name text)
LANGUAGE plpgsql STABLE AS $f$
BEGIN
  scope := split_part(handle, '/', 1);
  name := substr(handle, length(scope) + 2);
  IF scope NOT IN ('system', 'organization', 'agent', 'conversation') OR name = '' THEN
    RAISE EXCEPTION '%: a handle is scope/name — system, organization, agent or conversation, then the doc''s name', handle;
  END IF;
  owner := docs_owner(scope);
END
$f$;

CREATE OR REPLACE FUNCTION docs_stamp() RETURNS text LANGUAGE sql VOLATILE AS $f$
  SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$f$;

-- afs read: the doc from line \`at\` (1-indexed), \`lim\` lines at most, head-truncated to
-- \`lim\` lines (2000) and \`max_bytes\` (50KB), never a partial line, a footer naming the
-- line to continue from
CREATE OR REPLACE FUNCTION docs_read(handle text, at integer DEFAULT NULL,
  lim integer DEFAULT NULL, max_bytes integer DEFAULT NULL) RETURNS text
LANGUAGE plpgsql STABLE AS $f$
DECLARE
  r record; content text; lines text[]; total integer; start integer; joined text;
  span text[]; line text; kept text[] := '{}'; max_lines integer; cap integer;
  size integer := 0; cost integer; shown integer := 0; count integer; footer text := '';
BEGIN
  SELECT * INTO r FROM docs_ref(handle);
  SELECT d.text INTO content FROM docs d
    WHERE d.scope = r.scope AND d.owner = r.owner AND d.name = r.name;
  IF NOT FOUND THEN RAISE EXCEPTION '%: no such doc', handle; END IF;
  lines := string_to_array(content, E'\\n');
  IF right(content, 1) = E'\\n' THEN lines := lines[1:array_length(lines, 1) - 1]; END IF;
  total := coalesce(array_length(lines, 1), 0);
  start := CASE WHEN at IS NULL OR at < 1 THEN 0 ELSE at - 1 END;
  IF total > 0 AND start >= total THEN
    RAISE EXCEPTION 'offset % is beyond end of file (% lines)', at, total;
  END IF;
  span := lines[start + 1 : CASE WHEN lim IS NULL THEN total ELSE start + lim END];
  joined := array_to_string(span, E'\\n');
  max_lines := coalesce(lim, 2000);
  cap := coalesce(max_bytes, 51200);
  -- what the head keeps, counted as the truncation counts: a trailing newline is no line
  lines := string_to_array(joined, E'\\n');
  IF right(joined, 1) = E'\\n' THEN lines := lines[1:array_length(lines, 1) - 1]; END IF;
  count := coalesce(array_length(lines, 1), 0);
  IF count <= max_lines AND octet_length(joined) <= cap THEN
    shown := count;
  ELSE
    FOREACH line IN ARRAY lines LOOP
      EXIT WHEN shown >= max_lines;
      cost := octet_length(line) + CASE WHEN shown > 0 THEN 1 ELSE 0 END;
      EXIT WHEN size + cost > cap;
      kept := kept || line;
      size := size + cost;
      shown := shown + 1;
    END LOOP;
    joined := array_to_string(kept, E'\\n');
  END IF;
  IF shown = 0 AND coalesce(array_length(span, 1), 0) > 0 THEN
    RETURN format('[line %s alone exceeds the byte cap (%s bytes) — raise maxBytes]', start + 1, cap);
  END IF;
  IF start + shown < total THEN
    footer := format(E'\\n\\n[showing lines %s-%s of %s — continue from line %s]',
      start + 1, start + shown, total, start + shown + 1);
  END IF;
  RETURN joined || footer;
END
$f$;

-- afs write: the whole text, a blind overwrite by contract
CREATE OR REPLACE FUNCTION docs_write(handle text, content text) RETURNS text
LANGUAGE plpgsql VOLATILE AS $f$
DECLARE r record;
BEGIN
  SELECT * INTO r FROM docs_ref(handle);
  INSERT INTO docs (scope, owner, name, text, updated_at)
    VALUES (r.scope, r.owner, r.name, content, docs_stamp())
    ON CONFLICT (scope, owner, name) DO UPDATE
      SET text = excluded.text, updated_at = excluded.updated_at;
  RETURN format('wrote %s bytes to %s', octet_length(content), handle);
END
$f$;

-- a normalized offset back to the original's: the line it falls in, then the column when
-- it is within the kept text, else the line's own end (its newline)
CREATE OR REPLACE FUNCTION docs_offset(p integer, ln_norm integer[], ln_orig integer[],
  kept_len integer[], orig_len integer[]) RETURNS integer
LANGUAGE plpgsql IMMUTABLE AS $f$
DECLARE k integer := 1; i integer; c integer;
BEGIN
  FOR i IN 1..array_length(ln_norm, 1) LOOP
    IF ln_norm[i] <= p THEN k := i; END IF;
  END LOOP;
  c := p - ln_norm[k];
  RETURN ln_orig[k] + CASE WHEN c < kept_len[k] THEN c ELSE orig_len[k] END;
END
$f$;

-- afs edit: the conflict-marker multi-edit spec (exec/edit.ts). Every block is matched
-- against the ORIGINAL text and must be unique and non-overlapping; exact first, then
-- trailing-whitespace-insensitive — matched in normalized space, spliced in the original,
-- so only the matched spans change. BOM and CRLF are stripped to match and restored.
CREATE OR REPLACE FUNCTION docs_edit(handle text, spec text) RETURNS text
LANGUAGE plpgsql VOLATILE AS $f$
DECLARE
  r record; raw text; bom text := ''; crlf boolean; content text;
  olds text[] := '{}'; news text[] := '{}'; mode text := 'outside';
  cur_old text[]; cur_new text[]; line text; n integer; i integer;
  missed boolean := false; base text; use_old text[];
  lines text[]; kept text[] := '{}'; kept_len integer[] := '{}'; orig_len integer[] := '{}';
  ln_norm integer[] := '{}'; ln_orig integer[] := '{}'; pos integer; p integer;
  first integer; s integer; e integer; starts integer[] := '{}'; ends integer[] := '{}';
  ord integer[]; result text;
BEGIN
  SELECT * INTO r FROM docs_ref(handle);
  SELECT d.text INTO raw FROM docs d
    WHERE d.scope = r.scope AND d.owner = r.owner AND d.name = r.name FOR UPDATE;
  IF NOT FOUND THEN
    IF EXISTS (SELECT 1 FROM docs d
               WHERE d.scope = r.scope AND d.owner = r.owner AND d.name = r.name) THEN
      RAISE EXCEPTION '%: not yours to edit', handle;
    END IF;
    RAISE EXCEPTION '%: no such doc', handle;
  END IF;
  -- parse
  FOREACH line IN ARRAY string_to_array(replace(spec, E'\\r\\n', E'\\n'), E'\\n') LOOP
    IF line = '<<<<<<<' THEN
      IF mode <> 'outside' THEN RAISE EXCEPTION 'malformed spec: unexpected <<<<<<<'; END IF;
      mode := 'old'; cur_old := '{}'; cur_new := '{}';
    ELSIF line = '=======' THEN
      IF mode <> 'old' THEN RAISE EXCEPTION 'malformed spec: ======= outside a block'; END IF;
      mode := 'new';
    ELSIF line = '>>>>>>>' THEN
      IF mode <> 'new' THEN RAISE EXCEPTION 'malformed spec: >>>>>>> outside a block'; END IF;
      olds := olds || array_to_string(cur_old, E'\\n');
      news := news || array_to_string(cur_new, E'\\n');
      mode := 'outside';
    ELSIF mode = 'old' THEN cur_old := cur_old || line;
    ELSIF mode = 'new' THEN cur_new := cur_new || line;
    ELSIF line !~ '^\\s*$' THEN
      RAISE EXCEPTION 'malformed spec: text outside a block: %', left(line, 40);
    END IF;
  END LOOP;
  IF mode <> 'outside' THEN RAISE EXCEPTION 'malformed spec: unterminated block'; END IF;
  n := coalesce(array_length(olds, 1), 0);
  IF n = 0 THEN RAISE EXCEPTION 'empty spec: no edit blocks found'; END IF;
  -- normalize the text: BOM off, CRLF to LF
  IF left(raw, 1) = chr(65279) THEN bom := chr(65279); content := substr(raw, 2);
  ELSE content := raw; END IF;
  crlf := position(E'\\r\\n' IN content) > 0;
  IF crlf THEN content := replace(content, E'\\r\\n', E'\\n'); END IF;
  -- exact first; if ANY edit misses, every edit is retried in trailing-whitespace-
  -- normalized space — matched there, spliced HERE
  base := content;
  use_old := olds;
  FOR i IN 1..n LOOP
    IF strpos(content, olds[i]) = 0 THEN missed := true; END IF;
  END LOOP;
  IF missed THEN
    lines := CASE WHEN content = '' THEN ARRAY[''] ELSE string_to_array(content, E'\\n') END;
    pos := 0; p := 0;
    FOR i IN 1..array_length(lines, 1) LOOP
      line := regexp_replace(lines[i], '[ \\t]+$', '');
      kept := kept || line;
      kept_len[i] := length(line);
      orig_len[i] := length(lines[i]);
      ln_norm[i] := p;
      ln_orig[i] := pos;
      p := p + kept_len[i] + 1;
      pos := pos + orig_len[i] + 1;
    END LOOP;
    base := array_to_string(kept, E'\\n');
    FOR i IN 1..n LOOP
      SELECT array_to_string(array_agg(regexp_replace(l, '[ \\t]+$', '') ORDER BY o), E'\\n')
        INTO line
        FROM unnest(string_to_array(olds[i], E'\\n')) WITH ORDINALITY AS t(l, o);
      use_old[i] := coalesce(line, '');
    END LOOP;
  END IF;
  -- locate every (unique) match against the original
  FOR i IN 1..n LOOP
    IF use_old[i] = '' THEN RAISE EXCEPTION 'edit #%: old text is empty', i; END IF;
    first := strpos(base, use_old[i]);
    IF first = 0 THEN
      RAISE EXCEPTION 'edit #%: old text not found%', i,
        CASE WHEN missed THEN ' (even ignoring trailing whitespace)' ELSE '' END;
    END IF;
    IF strpos(substr(base, first + 1), use_old[i]) > 0 THEN
      RAISE EXCEPTION 'edit #%: old text matches more than once — make it unique', i;
    END IF;
    s := first - 1;
    e := s + length(use_old[i]);
    IF missed THEN
      s := docs_offset(s, ln_norm, ln_orig, kept_len, orig_len);
      e := docs_offset(e, ln_norm, ln_orig, kept_len, orig_len);
    END IF;
    starts[i] := s; ends[i] := e;
  END LOOP;
  SELECT array_agg(g ORDER BY starts[g]) INTO ord FROM generate_series(1, n) g;
  FOR i IN 2..n LOOP
    IF starts[ord[i]] < ends[ord[i - 1]] THEN
      RAISE EXCEPTION 'edits overlap — merge nearby changes into one block';
    END IF;
  END LOOP;
  -- splice back-to-front so earlier spans keep their offsets
  result := content;
  FOR i IN REVERSE n..1 LOOP
    result := left(result, starts[ord[i]]) || news[ord[i]] || substr(result, ends[ord[i]] + 1);
  END LOOP;
  result := bom || CASE WHEN crlf THEN replace(result, E'\\n', E'\\r\\n') ELSE result END;
  UPDATE docs SET text = result, updated_at = docs_stamp()
    WHERE scope = r.scope AND owner = r.owner AND name = r.name;
  RETURN format('applied %s edit(s) to %s', n, handle);
END
$f$;
`;

/** The version the DDL creates. A store found below it is raised in place, once, by the
 *  steps between; a store above it was made by a newer liquen, and this one refuses it. */
export const VERSION = 2;

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
    await tx.unsafe(functions() + LOG_DDL + VAULT_DDL + docsDdl(schema));
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
