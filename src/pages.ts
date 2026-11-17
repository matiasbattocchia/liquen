/**
 * pages.ts — the pages agents publish (DESIGN §9): a folder for WhatsApp conversations,
 * served by main behind the edge at `<base>/pages/<id>`, and the login that opens it.
 *
 * A folder is one page. Its row is in the vault under `page:<id>`, owned by the agent that
 * published it last, so removing that agent removes the page, and its files are objects
 * under `pages/<id>/`. The row keeps the folder, the conversations with the kind of each
 * and the account it rides, the title, the files and the deadline; each direct chat's
 * token, the one its link carries, is kept until it is spent.
 *
 * Opening a page is two steps. `/pages/<id>` is the door: it admits a visitor whose login
 * belongs to the page, and sends them into the box, `/pages/<id>/<view>/`, where the files
 * are served under a view key that is signed, bound to the page, and good for `VIEW_MS`.
 * A relative path inside the app resolves under the same key, so the files need no cookie.
 *
 * The box is closed by the headers every file is sent with (`BOX`): the page loads only
 * its own files (`default-src 'self'`), and runs in an origin of its own (`sandbox`
 * without `allow-same-origin`), so it can't read other pages or reach the login.
 *
 * The login is a cookie that names a phone, signed with the vault's `pages:sign` key. Each
 * time the door is opened, main checks the phone belongs: a direct chat's own number, or a
 * seat on a group's roster. Without one, a direct chat's link logs its person in with its
 * token, posted by a button so a previewer spends nothing, and anyone else asks for a
 * code: main checks the number belongs before anything is sent, DMs the code from the
 * account of the conversation that admits it, and answers the same either way.
 */

import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import type { CredentialRow, Credentials } from "./store/credentials.ts";
import { plainKey, type Storage } from "./store/storage.ts";
import { buttonPage, endPage, type Form, formPage } from "./connect/page.ts";
import { digits } from "./store/roster.ts";

/** The vault's key head for a page's row. */
export const PAGE_KEY = "page:";
/** The object store's head for a page's files. */
export const PAGE_FILES = "pages/";
/** The most files a page holds, and the most bytes in all. */
export const PAGE_FILES_MOST = 64;
export const PAGE_BYTES_MOST = 25 * 1024 * 1024;
/** The most conversations a page is for. */
export const PAGE_WITH_MOST = 10;
/** The file a page opens on. */
export const PAGE_INDEX = "index.html";
/** How long a view key opens the box. */
export const VIEW_MS = 4 * 3_600_000;
/** How long a login lasts. */
export const LOGIN_MS = 7 * 24 * 3_600_000;
/** How long a code lives, and how many tries it takes. */
export const CODE_MS = 10 * 60_000;
export const CODE_TRIES = 5;
/** The fewest ms between two codes to one number, and the most codes an hour. */
export const CODE_GAP_MS = 60_000;
export const CODES_AN_HOUR = 5;
/** How often main lets go of the pages past their deadline. */
export const PAGE_SWEEP_MS = 3_600_000;
/** The login cookie's name. */
export const LOGIN_COOKIE = "liquen_login";

const SECRET_KEY = "pages:sign";

/** One file of a page. */
export interface PageFile {
  mime: string;
  size: number;
}

/** A conversation a page is for. */
export interface Party {
  address: string;
  /** The WhatsApp account the conversation rides: a code to a number it admits goes out
   *  from it. */
  connection: string;
  kind: "direct" | "group";
  /** What the conversation is called, as the agent saw it. */
  name?: string;
}

/** A page as its row keeps it. */
export interface Page {
  id: string;
  /** The agent that published it last: its view vouched for `with`. */
  agentId: string;
  /** The folder, `agents/<agent>/<path>` or `shared/<path>`: one page each. */
  folder: string;
  with: Party[];
  title: string;
  files: Record<string, PageFile>;
  created: number;
  until: number;
  /** Each direct chat's link token by its address, until it is spent. */
  tokens: Record<string, string>;
}

/** The vault field a direct chat's token is kept under. */
const TOKEN = "t:";

/** A fresh id: 128 random bits, in the characters a path segment takes as they are. */
export function pageId(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** A page's row, or null when there is none. */
export async function readPage(creds: Credentials, id: string): Promise<Page | null> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null;
  const row = await creds.get(`${PAGE_KEY}${id}`);
  return row ? pageOf(row) : null;
}

/** Every page, or an agent's. */
export async function listPages(creds: Credentials, agentId?: string): Promise<Page[]> {
  const pages = (await creds.list(PAGE_KEY)).map(pageOf);
  return agentId ? pages.filter((p) => p.agentId === agentId) : pages;
}

/** The live page a folder is, or null. */
export async function pageAt(
  creds: Credentials,
  folder: string,
  now = Date.now(),
): Promise<Page | null> {
  return (await listPages(creds)).find((p) => p.folder === folder && p.until > now) ?? null;
}

function pageOf(row: CredentialRow): Page {
  const x = (row.extra ?? {}) as Omit<Page, "id" | "agentId" | "tokens">;
  return {
    ...x,
    id: row.key.slice(PAGE_KEY.length),
    agentId: row.agentId ?? "",
    tokens: Object.fromEntries(
      Object.entries(row.value).flatMap(([k, v]) =>
        k.startsWith(TOKEN) && v ? [[k.slice(TOKEN.length), v]] : []
      ),
    ),
  };
}

/** Write a page whole: its files under `pages/<id>/`, the ones it no longer holds let go,
 *  and its row. */
export async function writePage(
  creds: Credentials,
  storage: Storage,
  page: Page,
  bytes: Map<string, Uint8Array>,
): Promise<void> {
  for (const [path, b] of bytes) {
    await storage.put(`${PAGE_FILES}${page.id}/${path}`, b, page.files[path].mime);
  }
  for await (const { key } of storage.keys(`${PAGE_FILES}${page.id}/`)) {
    if (!(key.slice(`${PAGE_FILES}${page.id}/`.length) in page.files)) {
      await storage.delete(key);
    }
  }
  const { id, agentId, tokens, ...extra } = page;
  // the row is replaced, not merged: a file the page no longer holds leaves its list
  await creds.delete(`${PAGE_KEY}${id}`);
  await creds.put({
    key: `${PAGE_KEY}${id}`,
    ...(agentId ? { agentId } : {}),
    value: Object.fromEntries(Object.entries(tokens).map(([a, t]) => [`${TOKEN}${a}`, t])),
    extra: extra as unknown as Record<string, unknown>,
  });
}

/** Take a page down: its row and its files. */
export async function removePage(creds: Credentials, storage: Storage, id: string): Promise<void> {
  await creds.delete(`${PAGE_KEY}${id}`);
  for await (const { key } of storage.keys(`${PAGE_FILES}${id}/`)) await storage.delete(key);
}

/** Let go of every page past its deadline, and of the files of a page whose row is gone
 *  (its agent removed). Answers how many pages went. */
export async function sweepPages(
  creds: Credentials,
  storage: Storage,
  now = Date.now(),
): Promise<number> {
  const pages = await listPages(creds);
  let gone = 0;
  for (const p of pages) {
    if (p.until > now) continue;
    await removePage(creds, storage, p.id);
    gone++;
  }
  const kept = new Set(pages.filter((p) => p.until > now).map((p) => p.id));
  for await (const { key } of storage.keys(PAGE_FILES)) {
    const id = key.slice(PAGE_FILES.length).split("/")[0];
    if (!kept.has(id)) await storage.delete(key);
  }
  return gone;
}

/** The key the logins and the view keys are signed with, from the vault: minted once. */
export async function pagesSecret(creds: Credentials): Promise<string> {
  const row = await creds.get(SECRET_KEY);
  if (row?.value.secret) return row.value.secret;
  const secret = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  await creds.put({ key: SECRET_KEY, value: { secret } });
  // re-read: another process on first boot may have written its own
  return (await creds.get(SECRET_KEY))!.value.secret;
}

const hmac = (secret: string, use: "sign" | "verify") =>
  crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [use],
  );

async function sign(secret: string, payload: string): Promise<string> {
  const mac = await crypto.subtle.sign(
    "HMAC",
    await hmac(secret, "sign"),
    new TextEncoder().encode(payload),
  );
  return encodeBase64Url(new Uint8Array(mac));
}

/** `crypto.subtle.verify`: the comparison is constant-time there. */
async function verify(secret: string, payload: string, mac: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify(
      "HMAC",
      await hmac(secret, "verify"),
      decodeBase64Url(mac) as BufferSource,
      new TextEncoder().encode(payload) as BufferSource,
    );
  } catch {
    return false;
  }
}

/** A view key for a page: its deadline and a mac over the page and the deadline. */
export async function viewKey(secret: string, id: string, until: number): Promise<string> {
  const at = until.toString(36);
  return `${at}.${await sign(secret, `view:${id}:${at}`)}`;
}

/** Whether a view key opens a page now. */
export async function viewOpens(
  secret: string,
  id: string,
  key: string,
  now = Date.now(),
): Promise<boolean> {
  const [at, mac] = key.split(".");
  if (!at || !mac || !(parseInt(at, 36) > now)) return false;
  return await verify(secret, `view:${id}:${at}`, mac);
}

/** A login's cookie value: the phone, its deadline, and a mac over both. */
export async function loginValue(secret: string, phone: string, until: number): Promise<string> {
  const at = until.toString(36);
  return `${phone}.${at}.${await sign(secret, `login:${phone}:${at}`)}`;
}

/** The phone a request's login names, or null when it has none good now. */
export async function loginOf(
  secret: string,
  req: Request,
  now = Date.now(),
): Promise<string | null> {
  const cookie = req.headers.get("cookie") ?? "";
  const value = cookie.split(";").map((c) => c.trim())
    .find((c) => c.startsWith(`${LOGIN_COOKIE}=`))?.slice(LOGIN_COOKIE.length + 1);
  if (!value) return null;
  const [phone, at, mac] = value.split(".");
  if (!phone || !at || !mac || !/^\d+$/.test(phone) || !(parseInt(at, 36) > now)) return null;
  return await verify(secret, `login:${phone}:${at}`, mac) ? phone : null;
}

/** A page's file path as a store key takes it: plain segments, nothing that climbs. */
export function plainPath(path: string): boolean {
  return plainKey(path);
}

/** ext → mime, for what a web page is made of; anything else is bytes. */
const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json",
  map: "application/json",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  wasm: "application/wasm",
  pdf: "application/pdf",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
};

/** The mime a page's file is served as, by its extension. */
export function pageMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/** The title an `index.html` gives itself, or null. */
export function titleOf(html: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const t = m?.[1].replace(/\s+/g, " ").trim();
  return t ? t : null;
}

/** The headers that close a page's file in its box. */
export const BOX: Record<string, string> = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  // the box runs in an origin of its own, so its own fetches and modules are cross-origin
  // to it: the files open to any origin, since the view key in the path is their lock
  "access-control-allow-origin": "*",
  "content-security-policy": "sandbox allow-scripts allow-forms allow-popups; " +
    "default-src 'self' 'unsafe-inline' data: blob:; form-action 'self'; base-uri 'self'; " +
    "frame-ancestors 'none'",
};

/** What the door needs of the org. */
export interface PagesDeps {
  creds: Credentials;
  storage: Storage;
  /** Whether the org's address is https, so the login cookie is `Secure`. */
  secure: () => boolean;
  /** The addresses on a group's roster now, as the bridge reads it for the page's agent.
   *  Throws when it can't. */
  roster: (page: Page, group: Party) => Promise<string[]>;
  /** DM a code's words to a number, from the account of the conversation that admits it. */
  send: (from: Party, phone: string, text: string) => Promise<void>;
  /** A line for the run log. */
  say?: (line: string) => void;
  now?: () => number;
}

/** A code in flight, kept in main alone: a restart asks for a new one. */
interface Code {
  code: string;
  until: number;
  tries: number;
}

/** The door and the box, as one handler for `/pages/…`. */
export function createPages(deps: PagesDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const say = deps.say ?? ((line: string) => console.error(line));
  const codes = new Map<string, Code>();
  const sent = new Map<string, number[]>();
  // a token is spent once: two posts of it at once let one in
  const spending = new Set<string>();
  let secret: string | undefined;
  const key = async () => secret ??= await pagesSecret(deps.creds);

  const tail = (phone: string) => `…${phone.slice(-4)}`;

  /** The conversation that lets a number open a page, its direct chat before a group, or
   *  null. Throws when a group's roster can't be read. */
  const admits = async (page: Page, phone: string): Promise<Party | null> => {
    const direct = page.with.find((p) => p.kind === "direct" && digits(p.address) === phone);
    if (direct) return direct;
    for (const p of page.with) {
      if (p.kind !== "group") continue;
      if ((await deps.roster(page, p)).some((a) => digits(a) === phone)) return p;
    }
    return null;
  };

  /** Who a page is for, as the door says it to a visitor. */
  const whom = (page: Page): string => {
    const [one] = page.with;
    if (page.with.length === 1 && one.kind === "group") {
      return `This page is for the people of ${one.name ?? "a WhatsApp group"}.`;
    }
    if (page.with.length === 1) return "This page is for one person on WhatsApp.";
    return "This page is for the people it was shared with on WhatsApp.";
  };

  const gone = () =>
    endPage("This page is gone", "It was taken down, ran out, or was never here.", false, 404);

  const numberForm = (page: Page): Form => ({
    title: page.title,
    lines: [
      whom(page),
      "Type your WhatsApp number, with its country code, and a code is sent to it there.",
    ],
    fields: [{
      name: "phone",
      label: "WhatsApp number",
      type: "tel",
      autocomplete: "tel",
      inputmode: "tel",
    }],
    submit: "Send me a code",
  });

  const codeForm = (page: Page, phone: string): Form => ({
    title: page.title,
    lines: [
      "If that number can open this page, a code is on its way to it on WhatsApp.",
      "Type it here. It is good for 10 minutes.",
    ],
    fields: [
      {
        name: "phone",
        label: "WhatsApp number",
        type: "tel",
        autocomplete: "tel",
        inputmode: "tel",
        value: `+${phone}`,
      },
      {
        name: "code",
        label: "Code",
        type: "text",
        autocomplete: "one-time-code",
        inputmode: "numeric",
      },
    ],
    submit: "Open the page",
  });

  /** Into the box, logged in as `phone`; `login` sets the cookie. */
  const enter = async (page: Page, phone: string, login: boolean): Promise<Response> => {
    const view = await viewKey(await key(), page.id, Math.min(now() + VIEW_MS, page.until));
    const headers = new Headers({
      location: `/pages/${page.id}/${view}/`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    if (login) {
      const until = now() + LOGIN_MS;
      headers.append(
        "set-cookie",
        `${LOGIN_COOKIE}=${await loginValue(await key(), phone, until)}; Path=/pages; ` +
          `Max-Age=${Math.floor(LOGIN_MS / 1000)}; HttpOnly; SameSite=Lax` +
          (deps.secure() ? "; Secure" : ""),
      );
    }
    say(`[pages] ${page.id} opened by ${tail(phone)}`);
    return new Response(null, { status: 303, headers });
  };

  /** Send a code, when the number belongs and its caps allow. */
  const offer = async (page: Page, phone: string): Promise<void> => {
    const from = await admits(page, phone);
    if (!from) return;
    const t = now();
    const times = (sent.get(phone) ?? []).filter((at) => t - at < 3_600_000);
    if ((times.at(-1) ?? -Infinity) > t - CODE_GAP_MS || times.length >= CODES_AN_HOUR) {
      sent.set(phone, times);
      return;
    }
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000)
      .padStart(6, "0");
    codes.set(`${page.id}:${phone}`, { code, until: t + CODE_MS, tries: 0 });
    sent.set(phone, [...times, t]);
    try {
      await deps.send(
        from,
        phone,
        `${code} is your code to open "${page.title}". It is good for 10 minutes. ` +
          "If you didn't ask for it, ignore this message.",
      );
      say(`[pages] ${page.id}: a code went to ${tail(phone)}`);
    } catch (err) {
      codes.delete(`${page.id}:${phone}`);
      say(`[pages] ${page.id}: the code to ${tail(phone)} could not be sent: ${err}`);
    }
  };

  const door = async (req: Request, page: Page): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET") {
      const token = url.searchParams.get("t");
      if (token) {
        return buttonPage(page.title, ["This page was made for you."], "Open it", { t: token });
      }
      const phone = await loginOf(await key(), req, now());
      if (phone && await admits(page, phone)) return await enter(page, phone, false);
      return formPage(numberForm(page));
    }
    if (req.method !== "POST") return endPage("Not allowed", "This page takes a form.", false, 405);
    const body = await req.text();
    if (body.length > 4096) return formPage(numberForm(page), "That was too long.", 400);
    const fields = Object.fromEntries(new URLSearchParams(body));
    if (fields.t !== undefined) {
      const chat = page.with.find((p) =>
        p.kind === "direct" && !!fields.t && page.tokens[p.address] === fields.t
      );
      const spend = chat && `${page.id}:${chat.address}`;
      if (!chat || !spend || spending.has(spend)) {
        return formPage(
          numberForm(page),
          "This link was used already. Log in with your number.",
          400,
        );
      }
      spending.add(spend);
      try {
        await deps.creds.put({
          key: `${PAGE_KEY}${page.id}`,
          value: { [`${TOKEN}${chat.address}`]: "" },
        });
      } finally {
        spending.delete(spend);
      }
      return await enter(page, digits(chat.address), true);
    }
    const phone = digits(fields.phone ?? "");
    if (phone.length < 8 || phone.length > 15) {
      return formPage(numberForm(page), "Type the whole number, with its country code.", 400);
    }
    if (fields.code === undefined) {
      await offer(page, phone);
      return formPage(codeForm(page, phone));
    }
    const at = `${page.id}:${phone}`;
    const c = codes.get(at);
    if (!c || c.until <= now()) {
      codes.delete(at);
      return formPage(numberForm(page), "That code ran out. Ask for a new one.", 400);
    }
    if (fields.code.replace(/\s/g, "") !== c.code) {
      c.tries++;
      if (c.tries >= CODE_TRIES) {
        codes.delete(at);
        return formPage(numberForm(page), "Too many tries. Ask for a new code.", 400);
      }
      return formPage(codeForm(page, phone), "That code is not the one sent.", 400);
    }
    codes.delete(at);
    return await enter(page, phone, true);
  };

  const box = async (page: Page, view: string, path: string): Promise<Response> => {
    if (!(await viewOpens(await key(), page.id, view, now()))) {
      return new Response(null, {
        status: 303,
        headers: { location: `/pages/${page.id}`, "cache-control": "no-store" },
      });
    }
    const file = path === "" || path.endsWith("/") ? `${path}${PAGE_INDEX}` : path;
    const meta = page.files[file];
    const bytes = meta && plainPath(file)
      ? await deps.storage.get(`${PAGE_FILES}${page.id}/${file}`)
      : null;
    if (!meta || !bytes) {
      return new Response("not in this page", {
        status: 404,
        headers: { ...BOX, "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(bytes as BodyInit, { headers: { ...BOX, "content-type": meta.mime } });
  };

  return async (req) => {
    const url = new URL(req.url);
    // the door is `/pages/<id>`, a slash after it or not; the box is everything under a view
    const m = /^\/pages\/([^/]+)(?:\/(?:([^/]+)\/(.*))?)?$/.exec(url.pathname);
    const page = m ? await readPage(deps.creds, m[1]) : null;
    if (!m || !page || page.until <= now()) return gone();
    try {
      if (m[2] === undefined) return await door(req, page);
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("not allowed", { status: 405 });
      }
      let path: string;
      try {
        path = decodeURIComponent(m[3]);
      } catch {
        return new Response("not in this page", { status: 404, headers: BOX });
      }
      return await box(page, m[2], path);
    } catch (err) {
      say(`[pages] ${page.id}: ${err}`);
      return endPage(
        "Not now",
        "This page can't check who may open it right now. Try again in a few minutes.",
        false,
        503,
      );
    }
  };
}
