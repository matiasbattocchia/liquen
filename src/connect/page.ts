/**
 * connect/page.ts — a sign-in page: the form a person types a secret into, drawn by main.
 *
 * A page service's link opens `GET /start?ticket=`, which draws the form. The form posts
 * back to the same address, and the flow answers with the next page: another form, the
 * outcome, or the form again with what went wrong. The secret goes from the browser
 * through main to the vault, and the model never sees it.
 *
 * Every page is plain HTML with no script. Each value is escaped, and each page is sent
 * `no-store`, with no referrer, no framing, and a policy that loads nothing and posts only
 * to itself. The ticket in the address is the page's whole authority: one sign-in, until
 * its deadline.
 */

import type { TicketRow } from "../store/credentials.ts";
import type { FlowCtx, Gate } from "./signin.ts";
import { callbackAddress } from "../edge.ts";
import { doorAddress } from "./door.ts";

/** One field of a form. */
export interface Field {
  name: string;
  label: string;
  type: "text" | "password" | "tel";
  /** The browser's autofill hint: `one-time-code`, `current-password`, `tel`, `off`. */
  autocomplete: string;
  inputmode?: "numeric" | "tel";
  value?: string;
}

/** A form as a page draws it. */
export interface Form {
  title: string;
  /** Said above the fields: what the page is for, and whose grant it makes. */
  lines: string[];
  /** Said as a list under the lines: where a token goes. */
  list?: string[];
  fields: Field[];
  submit: string;
}

/** What a page flow says: its form for an open ticket, and what it does with an answer. */
export interface PageFlow {
  form(t: TicketRow, ctx: FlowCtx): Form | Promise<Form>;
  /** Take what the form posted, and answer with the next page. `again` draws this ticket's
   *  form with what went wrong, the ticket left open. */
  take(
    t: TicketRow,
    fields: Record<string, string>,
    ctx: FlowCtx,
    gate: Gate,
    again: (error: string) => Promise<Response>,
  ): Promise<Response>;
}

/** The most a form may post. */
const MOST_BYTES = 16_384;

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; " +
    "form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};

const STYLE = `
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #fafaf8; --muted: #5f5f66;
  --line: #d6d6d0; --accent: #2f5d50; --bad: #a12a1e; --good: #2f6b3a; }
@media (prefers-color-scheme: dark) { :root { --fg: #ececea; --bg: #161616; --muted: #a3a3a8;
  --line: #3a3a3a; --accent: #8cc4b0; --bad: #f08a7c; --good: #8fd19e; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 28rem; margin: 0 auto; padding: 2.5rem 1rem; }
h1 { font-size: 1.35rem; margin: 0 0 1rem; }
p { margin: 0 0 .75rem; }
ul { margin: 0 0 1rem; padding-left: 1.25rem; }
li { font-family: ui-monospace, Menlo, monospace; font-size: .9rem; overflow-wrap: anywhere; }
.error { color: var(--bad); }
.good { color: var(--good); }
label { display: block; margin: 1rem 0 .25rem; font-weight: 600; }
input { width: 100%; padding: .6rem .7rem; font: inherit; color: inherit; background: transparent;
  border: 1px solid var(--line); border-radius: 6px; }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button { margin-top: 1.25rem; padding: .6rem 1.2rem; font: inherit; font-weight: 600;
  color: var(--bg); background: var(--accent); border: 0; border-radius: 6px; cursor: pointer; }
`;

/** A value as HTML text or an attribute. */
export function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function html(title: string, body: string, status: number): Response {
  return new Response(
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
      `<meta name="robots" content="noindex">\n<title>${escape(title)}</title>\n` +
      `<style>${STYLE}</style>\n</head>\n<body>\n<main>\n<h1>${escape(title)}</h1>\n` +
      `${body}</main>\n</body>\n</html>\n`,
    { status, headers: HEADERS },
  );
}

/** A form, with what went wrong the last time above its fields. */
export function formPage(form: Form, error?: string, status = 200): Response {
  const lines = form.lines.map((l) => `<p>${escape(l)}</p>\n`).join("");
  const list = form.list?.length
    ? `<ul>\n${form.list.map((l) => `<li>${escape(l)}</li>\n`).join("")}</ul>\n`
    : "";
  const said = error ? `<p class="error" role="alert">${escape(error)}</p>\n` : "";
  const fields = form.fields.map((f, i) =>
    `<label for="${escape(f.name)}">${escape(f.label)}</label>\n` +
    `<input id="${escape(f.name)}" name="${escape(f.name)}" type="${f.type}" ` +
    `autocomplete="${escape(f.autocomplete)}"` +
    (f.inputmode ? ` inputmode="${f.inputmode}"` : "") +
    (f.value ? ` value="${escape(f.value)}"` : "") +
    ` required${i === 0 ? " autofocus" : ""}>\n`
  ).join("");
  return html(
    form.title,
    `${lines}${list}${said}<form method="post">\n${fields}` +
      `<button type="submit">${escape(form.submit)}</button>\n</form>\n`,
    status,
  );
}

/** A page whose one act is a button: `hidden` rides the post. */
export function buttonPage(
  title: string,
  lines: string[],
  submit: string,
  hidden: Record<string, string>,
): Response {
  const said = lines.map((l) => `<p>${escape(l)}</p>\n`).join("");
  const kept = Object.entries(hidden).map(([k, v]) =>
    `<input type="hidden" name="${escape(k)}" value="${escape(v)}">\n`
  ).join("");
  return html(
    title,
    `${said}<form method="post">\n${kept}<button type="submit">${escape(submit)}</button>\n` +
      `</form>\n`,
    200,
  );
}

/** How a sign-in ended, as the person reads it. */
export function endPage(title: string, message: string, ok: boolean, status = 200): Response {
  return html(title, `<p class="${ok ? "good" : "error"}">${escape(message)}</p>\n`, status);
}

/** Whose grant a ticket makes, as a page says it. */
export function whose(t: TicketRow): string {
  return t.agentId ? `${t.agentId}'s` : "the shared";
}

/** A page service's link for one ticket: its door's `/start`, carrying the ticket. */
export function pageStart(service: string) {
  return (t: TicketRow, ctx: FlowCtx): { link: string; loopback: boolean } => {
    const door = doorAddress(callbackAddress(ctx.edge, service));
    const link = new URL(door.start);
    link.searchParams.set("ticket", t.ticket);
    return { link: link.href, loopback: door.loopback };
  };
}

/** A page flow as the handler its door serves. */
export function pageHandler(flow: PageFlow) {
  return (ctx: FlowCtx, gate: Gate) => async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (!url.pathname.endsWith("/start")) {
      return endPage("Not found", "Nothing is here.", false, 404);
    }
    const id = url.searchParams.get("ticket");
    const t = id ? await gate.view(id) : null;
    if (!t) {
      return endPage(
        "This sign-in is over",
        "This link was used, ran out, or was never good. Ask for a new one.",
        false,
        410,
      );
    }
    const again = async (error: string) => formPage(await flow.form(t, ctx), error, 400);
    if (req.method === "GET") return formPage(await flow.form(t, ctx));
    if (req.method !== "POST") return endPage("Not allowed", "This page takes a form.", false, 405);
    const body = await req.text();
    if (body.length > MOST_BYTES) return await again("That was too long to be what this asks for.");
    const fields = Object.fromEntries(new URLSearchParams(body));
    return await flow.take(t, fields, ctx, gate, again);
  };
}
