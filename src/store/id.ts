/**
 * store/id.ts — monotonic, sortable event ids (§3).
 *
 * The id orders the flat log: **lexical string order = causal (append) order**, so the
 * EventLog's `after`/`before` bounds and Postgres's `ORDER BY id` agree. We use **UUIDv7**
 * (RFC 9562): 48 big-endian bits of millisecond timestamp, then version/counter/random —
 * so the canonical hex string sorts by time.
 *
 * Why UUIDv7 for Postgres compatibility (the "events table"):
 *   • Native `uuid` column — not text. Time-ordered, so inserts hit the *right* end of the
 *     B-tree (tight locality), unlike random v4 which fragments the index.
 *   • Postgres can mint them itself: `id uuid DEFAULT uuidv7()` (PG18; a v7 function before).
 *     Files-minted (here) and DB-minted ids are the *same* format with the *same* sort
 *     order, so they interleave correctly behind the one EventLog port (§9).
 *   • The canonical lowercase-hex text (hyphens at fixed positions) compares byte-for-byte
 *     the same as the native `uuid` type — the files backend (string `>`) and the DB
 *     backend (`uuid` compare) never disagree on order.
 *
 * Monotonic within a millisecond: a single writer can emit many events in one ms, and
 * plain UUIDv7 randomizes the sub-ms bits — losing call order. We instead put a 12-bit
 * counter in the bits directly after the timestamp (RFC 9562 §6.2 "fixed-length dedicated
 * counter"), so same-ms ids strictly increase in call order regardless of the random tail.
 * A backwards wall clock can't regress ids: we keep a high-water timestamp.
 */

export type IdGen = () => string;

/**
 * Build a UUIDv7 generator. `now` is injectable for deterministic tests (§2 determinism);
 * it defaults to the wall clock.
 */
export function createIdGen(now: () => number = Date.now): IdGen {
  let highMs = 0; // high-water timestamp — never regresses
  let counter = 0; // 12-bit within-ms counter (0x000‥0xfff)

  return function newId(): string {
    const ms = now();
    if (ms > highMs) {
      highMs = ms;
      counter = 0;
    } else if (counter < 0xfff) {
      counter++; // same/earlier ms — keep high-water, advance the counter
    } else {
      highMs++; // counter exhausted this ms — borrow the next
      counter = 0;
    }

    const b = new Uint8Array(16);
    writeUint48(b, highMs); // bytes 0‥5: timestamp
    b[6] = 0x70 | ((counter >> 8) & 0x0f); // version 7 + counter high nibble
    b[7] = counter & 0xff; // counter low byte
    const rand = crypto.getRandomValues(new Uint8Array(8));
    b[8] = 0x80 | (rand[0] & 0x3f); // variant (10) + random
    b.set(rand.subarray(1), 9); // bytes 9‥15: random tail
    return format(b);
  };
}

/** Process-wide default generator (single writer = single monotonic sequence, §9). */
export const newId: IdGen = createIdGen();

/** Recover the millisecond timestamp an id was minted at (its first 48 bits). */
export function timeOf(id: string): number {
  return parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

function writeUint48(b: Uint8Array, ms: number): void {
  b[0] = Math.floor(ms / 2 ** 40) % 256;
  b[1] = Math.floor(ms / 2 ** 32) % 256;
  b[2] = Math.floor(ms / 2 ** 24) % 256;
  b[3] = Math.floor(ms / 2 ** 16) % 256;
  b[4] = Math.floor(ms / 2 ** 8) % 256;
  b[5] = ms % 256;
}

function format(b: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < 16; i++) hex += b[i].toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${
    hex.slice(20)
  }`;
}
