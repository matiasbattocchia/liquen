/**
 * bin/fetch.ts — the HTTP binary (DESIGN §9): `fetch`, laid beside aread · awrite · aedit.
 *
 * An HTTP call needs nothing of main's: the credential boundary is the egress proxy, which
 * hands user space `HTTPS_PROXY`, a trust file and a `mu-grant-…` handle per fronted
 * grant, and swaps the handle for the live token wherever a header carries it. So this
 * binary is credential-blind — an agent writes `-H "Authorization: Bearer $GH_TOKEN"` and
 * the proxy does the rest — and what it adds over a raw client is the discipline an agent
 * needs from a read of the world:
 *
 *   fetch [-X METHOD] [-H 'k: v']… [-d BODY | -d @- | -d @FILE] [-i] [-o PATH] URL [limit] [maxBytes]
 *
 *   • a status outside 2xx is a FAILURE: the status and the body on stdout, exit 1 — the
 *     `is_error` path bash already defines, so a 500 is the model's self-correction and
 *     never a silent 0
 *   • the body is HEAD-truncated under aread's rule (2000 lines / 50KB, the two positional
 *     overrides in aread's order) — a response is a read, so its beginning is the useful
 *     end; `-o` saves the whole thing for `aread` to page
 *   • JSON is printed pretty; bytes the model cannot read (an image, a PDF) are named,
 *     never dumped
 *   • `-d` implies POST and a JSON content-type unless a header says otherwise; `@-` is
 *     the body on stdin (heredoc-friendly, like awrite), `@FILE` a file's
 *   • `-i` prints the status line and the headers before the body
 *
 * Transport failures are sentences (`said`, connect/http.ts): `cannot reach <host> — …`,
 * `no answer from <host> within …`, printed as one line like every refusal.
 */

import { report } from "../entry.ts";
import { said, withTimeout } from "../connect/http.ts";
import { MAX_BYTES, MAX_LINES, truncateHead } from "../exec/truncate.ts";
import { isBytes } from "../store/media.ts";

/** One call's bound, headers to body. Under bash's own default cap (120s), so a stalled
 *  origin is named by this binary rather than by the turn's timeout. */
export const FETCH_TIMEOUT_MS = 100_000;

export interface FetchArgs {
  url: string;
  method?: string;
  headers: [string, string][];
  body?: string; // as given; `@-` and `@path` are resolved by `run`
  include: boolean;
  out?: string;
  limit?: number;
  maxBytes?: number;
}

const USAGE =
  "usage: fetch [-X METHOD] [-H 'k: v']... [-d BODY|@-|@FILE] [-i] [-o PATH] URL [limit] [maxBytes]";

/** curl's spelling for the flags an agent already knows, and aread's for the numbers. */
export function parseArgs(argv: string[]): FetchArgs {
  const args: FetchArgs = { url: "", headers: [], include: false };
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value\n${USAGE}`);
      return v;
    };
    if (a === "-X" || a === "--request") args.method = value().toUpperCase();
    else if (a === "-H" || a === "--header") {
      const h = value();
      const at = h.indexOf(":");
      if (at <= 0) throw new Error(`not a header: ${h} (want 'name: value')`);
      args.headers.push([h.slice(0, at).trim(), h.slice(at + 1).trim()]);
    } else if (a === "-d" || a === "--data") args.body = value();
    else if (a === "-o" || a === "--output") args.out = value();
    else if (a === "-i" || a === "--include") args.include = true;
    else if (a.startsWith("-") && a.length > 1) throw new Error(`unknown flag ${a}\n${USAGE}`);
    else words.push(a);
  }
  const [url, limit, maxBytes] = words;
  if (!url) throw new Error(USAGE);
  try {
    new URL(url);
  } catch {
    throw new Error(`not a url: ${url}`);
  }
  args.url = url;
  for (const [name, raw] of [["limit", limit], ["maxBytes", maxBytes]] as const) {
    if (raw === undefined) continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`${name} must be a positive integer: ${raw}`);
    }
    args[name] = n;
  }
  args.method ??= args.body !== undefined ? "POST" : "GET";
  return args;
}

async function readStdin(): Promise<string> {
  return await new Response(Deno.stdin.readable).text();
}

/** What the body flag names: itself, stdin (`@-`), or a file (`@path`). */
async function bodyOf(given: string): Promise<string> {
  if (given === "@-") return await readStdin();
  if (given.startsWith("@")) return await Deno.readTextFile(given.slice(1));
  return given;
}

const textual = (mime: string) =>
  /^text\//.test(mime) || /json|xml|javascript|x-www-form-urlencoded|yaml|csv/.test(mime);

/** The body as the model should read it: JSON pretty when it parses, else verbatim. */
export function present(text: string, mime: string): string {
  if (!/json/.test(mime)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

export interface Answer {
  status: number;
  headers: Headers;
  bytes: Uint8Array;
}

/** Render one answer for the turn: status + headers when asked, then the body under the
 *  read discipline. Pure over the answer, so the shape is testable without a socket. */
export function render(args: FetchArgs, a: Answer): string {
  const mime = (a.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const head = args.include
    ? [`HTTP ${a.status}`, ...[...a.headers].map(([k, v]) => `${k}: ${v}`)].join("\n") + "\n\n"
    : "";
  if (a.bytes.length === 0) return `${head}[HTTP ${a.status} — no body]`;
  if (mime && !textual(mime) && (isBytes(mime) || /octet-stream/.test(mime))) {
    return `${head}[${mime} · ${a.bytes.length} bytes — save it: fetch -o <path> ${args.url}]`;
  }
  const text = present(new TextDecoder().decode(a.bytes), mime);
  const t = truncateHead(text, { maxLines: args.limit, maxBytes: args.maxBytes });
  if (t.shownLines === 0) {
    return `${head}[line 1 alone exceeds the byte cap (${
      args.maxBytes ?? MAX_BYTES
    } bytes) — raise maxBytes: fetch ${args.url} ${args.limit ?? MAX_LINES} <bytes>, ` +
      `or save it: fetch -o <path> ${args.url}]`;
  }
  const footer = t.truncated
    ? `\n\n[showing lines 1-${t.shownLines} of ${t.totalLines} — whole response: ` +
      `fetch -o <path> ${args.url}, then aread <path>]`
    : "";
  return head + t.text + footer;
}

/** Entry for the shim. `fetchImpl` is injectable for tests; the default is the global
 *  fetch, bounded and said. */
export async function run(
  argv: string[],
  fetchImpl: typeof fetch = said(
    withTimeout((input, init) => fetch(input, init), FETCH_TIMEOUT_MS),
    FETCH_TIMEOUT_MS,
  ),
): Promise<number> {
  try {
    const args = parseArgs(argv);
    const headers = new Headers(args.headers);
    const body = args.body === undefined ? undefined : await bodyOf(args.body);
    if (body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const res = await fetchImpl(args.url, { method: args.method, headers, body });
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (args.out) {
      const dir = args.out.replace(/\/[^/]*$/, "");
      if (dir && dir !== args.out) await Deno.mkdir(dir, { recursive: true });
      await Deno.writeFile(args.out, bytes);
      console.log(`saved ${bytes.length} bytes to ${args.out} (HTTP ${res.status})`);
      return res.ok ? 0 : 1;
    }
    const answer = { status: res.status, headers: res.headers, bytes };
    console.log(
      res.ok || args.include ? render(args, answer) : `HTTP ${res.status}\n${render(args, answer)}`,
    );
    return res.ok ? 0 : 1;
  } catch (err) {
    report(err);
    return 1;
  }
}

if (import.meta.main) Deno.exit(await run(Deno.args));
