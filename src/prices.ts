/**
 * prices.ts — what a model call cost, in dollars, read off the usage table at read time.
 *
 * A price is a row: a model, the day it took effect (`valid_since`), and its rates in USD
 * per million tokens. A model's price over time is several rows, so a call is priced at
 * the rate in effect when it was made, and a correction to a row reprices history the
 * next time it is read: nothing priced is ever stored. The package ships `PRICES`, the
 * providers' list prices as their pages state them; `system.prices` in `config.jsonc`
 * holds an org's own rows (a negotiated rate, a model the list lacks), and an org row in
 * effect wins over the package's.
 *
 * A call nobody can price — its model has no row in effect at its time, or it spent tokens
 * of a kind its row gives no rate for — is UNPRICED, never $0: every total says how many
 * calls it leaves out.
 *
 * The usage table's counts are disjoint: `input_tokens` excludes what the cache served
 * (`cache_read_tokens`) and what was written to it (`cache_write_tokens`), and output
 * includes thinking — the transports normalize every provider to that shape.
 */

import type { UsageRow } from "./store/log.ts";

/** Rates in USD per million tokens. */
export interface Rates {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

export interface Price extends Rates {
  model: string;
  /** The first day (UTC, `YYYY-MM-DD`) the rates apply; they hold until the model's next row. */
  valid_since: string;
  /** Rates for a call whose context (input + cache read + cache write) is above
   *  `above_context` tokens. The highest tier the call passes applies. */
  tiers?: (Rates & { above_context: number })[];
}

/**
 * The providers' list prices, standard tier. Each model's first row starts on the day the
 * provider made it generally available where the provider dates that; otherwise on the day
 * the row was read off the provider's page, so earlier calls read as unpriced rather than
 * at a rate nobody stated. Anthropic's `cache_write` is its 5-minute write rate.
 */
export const PRICES: Price[] = [
  // Google — ai.google.dev/gemini-api/docs/pricing
  {
    model: "gemini-3.8-flash",
    valid_since: "2026-09-02",
    input: 0.75,
    output: 3.75,
    cache_read: 0.075,
  },
  {
    model: "gemini-3.8-flash",
    valid_since: "2027-01-01",
    input: 1.5,
    output: 7.5,
    cache_read: 0.15,
  },
  {
    model: "gemini-3.6-flash",
    valid_since: "2026-07-21",
    input: 0.75,
    output: 3.75,
    cache_read: 0.075,
  },
  {
    model: "gemini-3.6-flash",
    valid_since: "2027-01-01",
    input: 1.5,
    output: 7.5,
    cache_read: 0.15,
  },
  {
    model: "gemini-3.5-flash-lite",
    valid_since: "2026-07-21",
    input: 0.3,
    output: 2.5,
    cache_read: 0.03,
  },
  {
    model: "gemini-3.1-pro-preview",
    valid_since: "2026-02-19",
    input: 2,
    output: 12,
    cache_read: 0.2,
    tiers: [{ above_context: 200_000, input: 4, output: 18, cache_read: 0.4 }],
  },
  { model: "gemini-4-argon", valid_since: "2026-10-13", input: 2, output: 10, cache_read: 0.1 },
  { model: "gemini-4-argon", valid_since: "2026-12-01", input: 4, output: 20, cache_read: 0.2 },
  // Anthropic — platform.claude.com/docs/en/about-claude/pricing
  {
    model: "claude-fable-5-1",
    valid_since: "2026-10-19",
    input: 10,
    output: 50,
    cache_read: 0.25,
    cache_write: 12.5,
  },
  {
    model: "claude-opus-5-5",
    valid_since: "2026-10-19",
    input: 4,
    output: 20,
    cache_read: 0.2,
    cache_write: 5,
  },
  {
    model: "claude-opus-5",
    valid_since: "2026-10-19",
    input: 5,
    output: 25,
    cache_read: 0.5,
    cache_write: 6.25,
  },
  {
    model: "claude-sonnet-5-5",
    valid_since: "2026-10-19",
    input: 2,
    output: 10,
    cache_read: 0.1,
    cache_write: 2.5,
  },
  {
    model: "claude-sonnet-5",
    valid_since: "2026-10-19",
    input: 2,
    output: 10,
    cache_read: 0.2,
    cache_write: 2.5,
  },
  {
    model: "claude-haiku-5-5",
    valid_since: "2026-10-19",
    input: 0.1,
    output: 0.5,
    cache_read: 0.01,
    cache_write: 0.125,
    tiers: [{
      above_context: 100_000,
      input: 0.5,
      output: 2.5,
      cache_read: 0.05,
      cache_write: 0.625,
    }],
  },
  {
    model: "claude-haiku-4-5",
    valid_since: "2026-10-19",
    input: 1,
    output: 5,
    cache_read: 0.1,
    cache_write: 1.25,
  },
];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const RATE_KEYS = ["input", "output", "cache_read", "cache_write"] as const;

/** A boot check for `system.prices`: a complaint ("must be …") or null. */
export function checkPrices(v: unknown): string | null {
  if (!Array.isArray(v)) return "must be an array of price rows";
  for (const [i, row] of v.entries()) {
    const at = `row ${i}`;
    if (typeof row !== "object" || row === null) return `${at} must be an object`;
    const r = row as Record<string, unknown>;
    for (const key of Object.keys(r)) {
      if (!["model", "valid_since", "tiers", ...RATE_KEYS].includes(key)) {
        return `${at} has an unknown key "${key}"`;
      }
    }
    if (typeof r.model !== "string" || !r.model) return `${at} needs a model`;
    if (typeof r.valid_since !== "string" || !DAY.test(r.valid_since)) {
      return `${at} needs valid_since as YYYY-MM-DD`;
    }
    const rates = checkRates(r, at);
    if (rates) return rates;
    if (r.tiers !== undefined) {
      if (!Array.isArray(r.tiers)) return `${at}: tiers must be an array`;
      for (const [j, tier] of r.tiers.entries()) {
        const t = tier as Record<string, unknown>;
        const there = `${at} tier ${j}`;
        if (typeof t?.above_context !== "number" || t.above_context < 0) {
          return `${there} needs above_context, a token count`;
        }
        const bad = checkRates(t, there);
        if (bad) return bad;
      }
    }
  }
  return null;
}

function checkRates(r: Record<string, unknown>, at: string): string | null {
  for (const key of RATE_KEYS) {
    const v = r[key];
    const required = key === "input" || key === "output";
    if (v === undefined && !required) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      return `${at}: ${key} must be a rate in USD per million tokens`;
    }
  }
  return null;
}

/** The row in effect for `model` at `at` (an ISO stamp): the org's rows first, then the
 *  package's; within one list, the latest `valid_since` on or before the call's day. */
export function priceFor(model: string, at: string, own: Price[] = []): Price | undefined {
  const day = at.slice(0, 10);
  const latest = (list: Price[]) =>
    list
      .filter((p) => p.model === model && p.valid_since <= day)
      .reduce<Price | undefined>(
        (best, p) => !best || p.valid_since > best.valid_since ? p : best,
        undefined,
      );
  return latest(own) ?? latest(PRICES);
}

/** One call's cost in USD, or undefined when it is unpriced. */
export function costOf(row: UsageRow, own: Price[] = []): number | undefined {
  const price = priceFor(row.model, row.created_at, own);
  if (!price) return undefined;
  const read = row.cache_read_tokens ?? 0;
  const write = row.cache_write_tokens ?? 0;
  const context = row.input_tokens + read + write;
  const tier = (price.tiers ?? [])
    .filter((t) => context > t.above_context)
    .reduce<(Rates & { above_context: number }) | undefined>(
      (best, t) => !best || t.above_context > best.above_context ? t : best,
      undefined,
    );
  const rates: Rates = tier ?? price;
  if (
    (read > 0 && rates.cache_read === undefined) || (write > 0 && rates.cache_write === undefined)
  ) {
    return undefined;
  }
  return (row.input_tokens * rates.input + row.output_tokens * rates.output +
    read * (rates.cache_read ?? 0) + write * (rates.cache_write ?? 0)) / 1_000_000;
}

/** What a set of calls cost: the priced ones summed, how many calls, how many unpriced. */
export interface Cost {
  usd: number;
  calls: number;
  unpriced: number;
}

export function costOfAll(rows: UsageRow[], own: Price[] = []): Cost {
  let usd = 0;
  let unpriced = 0;
  for (const r of rows) {
    const c = costOf(r, own);
    if (c === undefined) unpriced++;
    else usd += c;
  }
  return { usd, calls: rows.length, unpriced };
}

/** A cost as people read one: `$0.42`, `≥ $0.42 (3 unpriced)` when calls are left out,
 *  `$?` when none could be priced. */
export function dollars(c: Cost): string {
  if (c.calls > 0 && c.unpriced === c.calls) return "$?";
  const usd = `$${c.usd < 0.01 && c.usd > 0 ? c.usd.toFixed(4) : c.usd.toFixed(2)}`;
  return c.unpriced > 0 ? `≥ ${usd} (${c.unpriced} unpriced)` : usd;
}
