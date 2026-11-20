/**
 * artifacts.ts — what agents publish (DESIGN §9): a folder for WhatsApp conversations and
 * for the agent's principals, served by main behind the edge at `<base>/artifacts/<slug>`,
 * and the login that opens it.
 *
 * A folder is one artifact, and what it holds says what it is: `public/` is what it shows,
 * its files copied into the object store as it is published; `server.ts` is its server, run
 * from the folder itself (artifact-servers.ts). Either one or both: a page, an API, an app.
 * Its row is in the vault under `artifact:<slug>`, owned by the agent that published it
 * last, so removing that agent removes it. The slug is the title's, taken at the first
 * publish and kept after. The row holds an id of its own besides: the files sit under it,
 * each named by its content (`artifacts/<id>/<hash>`), and every key that opens the
 * artifact is bound to it, so a slug taken again after a cancel opens nothing with the old
 * one's keys.
 *
 * Opening one is two steps. `/artifacts/<slug>` is the door: it admits a visitor whose
 * login belongs to the artifact, and sends them into the box, `/artifacts/<slug>/<view>/`,
 * under a view key that names the visitor's phone, signed, bound to the artifact, and good
 * for `VIEW_MS`. In the box a path that is one of `public/`'s files is served from the
 * store; any other goes to the server, with the visitor's phone in `liquen-visitor` and the
 * login cookie left out. A relative path inside the app resolves under the same key, so
 * nothing in the box needs a cookie.
 *
 * The box is closed by the headers every answer is sent with (`BOX`), the server's
 * included: it loads only its own files (`default-src 'self'`), and runs in an origin of its
 * own (`sandbox` without `allow-same-origin`), so it can't read other artifacts or reach the
 * login.
 *
 * The login is a cookie that names a phone, signed with the vault's `artifacts:sign` key.
 * Each time the door is opened, main checks the phone belongs: a direct chat's own number, a
 * principal's, or a seat on a group's roster. Without one, a direct chat's or a principal's
 * link logs its person in with its token, posted by a button so a previewer spends nothing,
 * and anyone else asks for a code: main checks the number belongs before anything is sent,
 * DMs the code from the account of a conversation that admits it, and answers the same
 * either way. ARTIFACTS.md says where this is weak.
 */

import { decodeBase64Url, encodeBase64Url } from "@std/encoding/base64url";
import type { CredentialRow, Credentials } from "./store/credentials.ts";
import { plainKey, type Storage } from "./store/storage.ts";
import { buttonPage, endPage, type Form, formPage } from "./connect/page.ts";
import { digits } from "./store/roster.ts";

/** The vault's key head for an artifact's row. */
export const ARTIFACT_KEY = "artifact:";
/** The object store's head for the artifacts' files. */
export const ARTIFACT_FILES = "artifacts/";
/** The most files an artifact shows, and the most bytes in all. */
export const ARTIFACT_FILES_MOST = 64;
export const ARTIFACT_BYTES_MOST = 25 * 1024 * 1024;
/** The most conversations an artifact is for. */
export const ARTIFACT_WITH_MOST = 10;
/** The folder of what an artifact shows, the file it opens on, and its server. */
export const PUBLIC_DIR = "public";
export const ARTIFACT_INDEX = "index.html";
export const SERVER_FILE = "server.ts";
/** The socket a server listens on, in its folder: dot-named, so no publish takes it. */
export const SERVER_SOCKET = ".artifact.sock";
/** The header a server reads its visitor's phone in; main alone sets it. */
export const VISITOR_HEADER = "liquen-visitor";
/** The longest slug a title makes. */
export const SLUG_MOST = 48;
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
/** How often main lets go of the artifacts past their deadline. */
export const ARTIFACT_SWEEP_MS = 3_600_000;
/** The login cookie's name. */
export const LOGIN_COOKIE = "liquen_login";

const SECRET_KEY = "artifacts:sign";

/** One file `public/` holds: what it is served as, and the content it is kept under. */
export interface ArtifactFile {
  mime: string;
  size: number;
  /** The bytes' SHA-256, cut to 32 hex: the file's name in the store. */
  hash: string;
}

/** Someone an artifact is for: a conversation, or one of the agent's principals. */
export interface Party {
  address: string;
  /** The WhatsApp account a code to a number this admits goes out from; empty when no
   *  account but the person's own reaches them. */
  connection: string;
  kind: "direct" | "group" | "principal";
  /** What the conversation or the person is called, as the agent saw it. */
  name?: string;
}

/** What an artifact's server was published with. */
export interface ArtifactServer {
  /** The hosts it may reach. */
  hosts: string[];
  /** Whether it may load the native libraries npm packages ship (`--allow-ffi`). */
  native: boolean;
}

/** An artifact as its row keeps it. */
export interface Artifact {
  slug: string;
  /** Its own id: the store's files and every key that opens it are bound to it. */
  id: string;
  /** The agent that published it last: its view vouched for `with`, and its server runs
   *  on that agent's ground. */
  agentId: string;
  /** The folder, `agents/<agent>/<path>` or `shared/<path>`: one artifact each. */
  folder: string;
  with: Party[];
  title: string;
  /** `public/`'s files by their paths from it. */
  files: Record<string, ArtifactFile>;
  server?: ArtifactServer;
  created: number;
  until: number;
  /** Each direct chat's and principal's link token by its address, until it is spent. */
  tokens: Record<string, string>;
}

/** What an artifact is, by what its folder holds. */
export type ArtifactKind = "page" | "api" | "app";

export function kindOf(a: Pick<Artifact, "files" | "server">): ArtifactKind {
  const shows = Object.keys(a.files).length > 0;
  return a.server ? (shows ? "app" : "api") : "page";
}

/** The vault field a link token is kept under. */
const TOKEN = "t:";

/** A fresh id or token: 128 random bits, in the characters a path segment takes as they
 *  are. */
export function newId(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(16)));
}

/** The slug a title makes: its words in lowercase ASCII, accents dropped, joined by
 *  dashes, cut at a word to `SLUG_MOST`. */
export function slugOf(title: string): string {
  const s = title.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (s.length <= SLUG_MOST) return s || "artifact";
  const cut = s.slice(0, SLUG_MOST);
  const at = cut.lastIndexOf("-");
  return at > SLUG_MOST / 2 ? cut.slice(0, at) : cut.replace(/-+$/, "");
}

/** The name a file's bytes are kept under: their SHA-256, cut to 32 hex. */
export async function hashOf(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  return [...d.slice(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** An artifact's row, or null when there is none. */
export async function readArtifact(creds: Credentials, slug: string): Promise<Artifact | null> {
  if (!/^[a-z0-9-]{1,64}$/.test(slug)) return null;
  const row = await creds.get(`${ARTIFACT_KEY}${slug}`);
  return row ? artifactOf(row) : null;
}

/** Every artifact, or an agent's. */
export async function listArtifacts(creds: Credentials, agentId?: string): Promise<Artifact[]> {
  const all = (await creds.list(ARTIFACT_KEY)).map(artifactOf);
  return agentId ? all.filter((a) => a.agentId === agentId) : all;
}

/** The live artifact a folder is, or null. */
export async function artifactAt(
  creds: Credentials,
  folder: string,
  now = Date.now(),
): Promise<Artifact | null> {
  return (await listArtifacts(creds)).find((a) => a.folder === folder && a.until > now) ?? null;
}

function artifactOf(row: CredentialRow): Artifact {
  const x = (row.extra ?? {}) as Omit<Artifact, "slug" | "agentId" | "tokens">;
  return {
    ...x,
    slug: row.key.slice(ARTIFACT_KEY.length),
    agentId: row.agentId ?? "",
    tokens: Object.fromEntries(
      Object.entries(row.value).flatMap(([k, v]) =>
        k.startsWith(TOKEN) && v ? [[k.slice(TOKEN.length), v]] : []
      ),
    ),
  };
}

/** The store key of one of an artifact's files. */
const fileKey = (a: Pick<Artifact, "id">, f: ArtifactFile) => `${ARTIFACT_FILES}${a.id}/${f.hash}`;

/** Write an artifact whole: its files under its id, the ones it no longer holds let go, and
 *  its row. */
export async function writeArtifact(
  creds: Credentials,
  storage: Storage,
  a: Artifact,
  bytes: Map<string, Uint8Array>,
): Promise<void> {
  for (const [path, b] of bytes) {
    await storage.put(fileKey(a, a.files[path]), b, a.files[path].mime);
  }
  const kept = new Set(Object.values(a.files).map((f) => fileKey(a, f)));
  for await (const { key } of storage.keys(`${ARTIFACT_FILES}${a.id}/`)) {
    if (!kept.has(key)) await storage.delete(key);
  }
  const { slug, agentId, tokens, ...extra } = a;
  // the row is replaced, not merged: a file the artifact no longer holds leaves its list
  await creds.delete(`${ARTIFACT_KEY}${slug}`);
  await creds.put({
    key: `${ARTIFACT_KEY}${slug}`,
    ...(agentId ? { agentId } : {}),
    value: Object.fromEntries(Object.entries(tokens).map(([to, t]) => [`${TOKEN}${to}`, t])),
    extra: extra as unknown as Record<string, unknown>,
  });
}

/** Take an artifact down: its row and its files. */
export async function removeArtifact(
  creds: Credentials,
  storage: Storage,
  a: Pick<Artifact, "slug" | "id">,
): Promise<void> {
  await creds.delete(`${ARTIFACT_KEY}${a.slug}`);
  for await (const { key } of storage.keys(`${ARTIFACT_FILES}${a.id}/`)) await storage.delete(key);
}

/** Let go of every artifact past its deadline, and of the files no live artifact holds
 *  (its agent removed, or a cancel cut short). Answers how many artifacts went. */
export async function sweepArtifacts(
  creds: Credentials,
  storage: Storage,
  now = Date.now(),
): Promise<number> {
  const all = await listArtifacts(creds);
  let gone = 0;
  for (const a of all) {
    if (a.until > now) continue;
    await removeArtifact(creds, storage, a);
    gone++;
  }
  const kept = new Set(
    all.filter((a) => a.until > now).flatMap((a) =>
      Object.values(a.files).map((f) => fileKey(a, f))
    ),
  );
  for await (const { key } of storage.keys(ARTIFACT_FILES)) {
    if (!kept.has(key)) await storage.delete(key);
  }
  return gone;
}

/** The key the logins and the view keys are signed with, from the vault: minted once. */
export async function artifactsSecret(creds: Credentials): Promise<string> {
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
      new TextEncoder().encode(payload),
    );
  } catch {
    return false;
  }
}

/** A view key: the visitor's phone, its deadline, and a mac over the artifact's id, the
 *  phone and the deadline. */
export async function viewKey(
  secret: string,
  id: string,
  phone: string,
  until: number,
): Promise<string> {
  const at = until.toString(36);
  return `${phone}.${at}.${await sign(secret, `view:${id}:${phone}:${at}`)}`;
}

/** The phone a view key names, when it opens the artifact now; else null. */
export async function viewer(
  secret: string,
  id: string,
  key: string,
  now = Date.now(),
): Promise<string | null> {
  const [phone, at, mac] = key.split(".");
  if (!phone || !at || !mac || !/^\d+$/.test(phone) || !(parseInt(at, 36) > now)) return null;
  return await verify(secret, `view:${id}:${phone}:${at}`, mac) ? phone : null;
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

/** A file's path as the store's keys take paths: plain segments, nothing that climbs. */
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

/** The mime a file is served as, by its extension. */
export function fileMime(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/** The title an `index.html` gives itself, or null. */
export function titleOf(html: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  const t = m?.[1].replace(/\s+/g, " ").trim();
  return t ? t : null;
}

/** The headers that close every answer in its box, a file's or the server's. */
export const BOX: Record<string, string> = {
  "cache-control": "no-store",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  // the box runs in an origin of its own, so its own fetches and modules are cross-origin
  // to it: its answers open to any origin, since the view key in the path is their lock
  "access-control-allow-origin": "*",
  "content-security-policy": "sandbox allow-scripts allow-forms allow-popups; " +
    "default-src 'self' 'unsafe-inline' data: blob:; form-action 'self'; base-uri 'self'; " +
    "frame-ancestors 'none'",
};

/** A server's answer headers the box drops: the connection's own framing, rewritten by
 *  whoever serves the answer, and a cookie, which the box's origin of its own could never
 *  send back. */
const DROPPED = [
  "content-length",
  "content-encoding",
  "transfer-encoding",
  "connection",
  "set-cookie",
];

/** What the door needs of the org. */
export interface ArtifactsDeps {
  creds: Credentials;
  storage: Storage;
  /** Whether the org's address is https, so the login cookie is `Secure`. */
  secure: () => boolean;
  /** The addresses on a group's roster now, as the bridge reads it for the artifact's
   *  agent. Throws when it can't. */
  roster: (a: Artifact, group: Party) => Promise<string[]>;
  /** DM a code's words to a number, from the account of the conversation that admits it. */
  send: (from: Party, phone: string, text: string) => Promise<void>;
  /** The socket an artifact's server listens on. */
  socket: (a: Artifact) => string;
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

/** The door and the box, as one handler for `/artifacts/…`. */
export function createArtifacts(deps: ArtifactsDeps): (req: Request) => Promise<Response> {
  const now = deps.now ?? Date.now;
  const say = deps.say ?? ((line: string) => console.error(line));
  const codes = new Map<string, Code>();
  const sent = new Map<string, number[]>();
  // a token is spent once: two posts of it at once let one in
  const spending = new Set<string>();
  let secret: string | undefined;
  const key = async () => secret ??= await artifactsSecret(deps.creds);
  const clients = new Map<string, Deno.HttpClient>();
  const clientFor = (path: string): Deno.HttpClient => {
    let c = clients.get(path);
    if (!c) {
      c = Deno.createHttpClient({ proxy: { transport: "unix", path } });
      clients.set(path, c);
    }
    return c;
  };

  const tail = (phone: string) => `…${phone.slice(-4)}`;

  /** Whether `party` lets `phone` in: a direct chat or a principal by its number, a group
   *  by its roster now. Throws when a roster can't be read. */
  const lets = async (a: Artifact, party: Party, phone: string): Promise<boolean> =>
    party.kind === "group"
      ? (await deps.roster(a, party)).some((at) => digits(at) === phone)
      : digits(party.address) === phone;

  /** The party that lets a number in, a direct chat or a principal before a group, or
   *  null. With `riding`, only one a code can go out from. */
  const admits = async (a: Artifact, phone: string, riding = false): Promise<Party | null> => {
    const order = [...a.with].sort((x, y) =>
      Number(x.kind === "group") - Number(y.kind === "group")
    );
    for (const p of order) {
      if (riding && !p.connection) continue;
      if (await lets(a, p, phone)) return p;
    }
    return null;
  };

  /** Who an artifact is for, as the door says it to a visitor. */
  const whom = (a: Artifact): string => {
    const [one] = a.with;
    if (a.with.length === 1 && one.kind === "group") {
      return `This page is for the people of ${one.name ?? "a WhatsApp group"}.`;
    }
    if (a.with.length === 1) return "This page is for one person on WhatsApp.";
    return "This page is for the people it was shared with on WhatsApp.";
  };

  const gone = () =>
    endPage("This page is gone", "It was taken down, ran out, or was never here.", false, 404);

  const numberForm = (a: Artifact): Form => ({
    title: a.title,
    lines: [
      whom(a),
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

  const codeForm = (a: Artifact, phone: string): Form => ({
    title: a.title,
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

  /** Into the box as `phone`; `login` sets the cookie. */
  const enter = async (a: Artifact, phone: string, login: boolean): Promise<Response> => {
    const view = await viewKey(await key(), a.id, phone, Math.min(now() + VIEW_MS, a.until));
    const headers = new Headers({
      location: `/artifacts/${a.slug}/${view}/`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    if (login) {
      const until = now() + LOGIN_MS;
      headers.append(
        "set-cookie",
        `${LOGIN_COOKIE}=${await loginValue(await key(), phone, until)}; Path=/artifacts; ` +
          `Max-Age=${Math.floor(LOGIN_MS / 1000)}; HttpOnly; SameSite=Lax` +
          (deps.secure() ? "; Secure" : ""),
      );
    }
    say(`[artifacts] ${a.slug} opened by ${tail(phone)}`);
    return new Response(null, { status: 303, headers });
  };

  /** Send a code, when the number belongs, an account reaches it, and its caps allow. */
  const offer = async (a: Artifact, phone: string): Promise<void> => {
    const from = await admits(a, phone, true);
    if (!from) return;
    const t = now();
    const times = (sent.get(phone) ?? []).filter((at) => t - at < 3_600_000);
    if ((times.at(-1) ?? -Infinity) > t - CODE_GAP_MS || times.length >= CODES_AN_HOUR) {
      sent.set(phone, times);
      return;
    }
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000)
      .padStart(6, "0");
    codes.set(`${a.slug}:${phone}`, { code, until: t + CODE_MS, tries: 0 });
    sent.set(phone, [...times, t]);
    try {
      await deps.send(
        from,
        phone,
        `${code} is your code to open "${a.title}". It is good for 10 minutes. ` +
          "If you didn't ask for it, ignore this message.",
      );
      say(`[artifacts] ${a.slug}: a code went to ${tail(phone)}`);
    } catch (err) {
      codes.delete(`${a.slug}:${phone}`);
      say(`[artifacts] ${a.slug}: the code to ${tail(phone)} could not be sent: ${err}`);
    }
  };

  const door = async (req: Request, a: Artifact): Promise<Response> => {
    const url = new URL(req.url);
    if (req.method === "GET") {
      const token = url.searchParams.get("t");
      if (token) {
        return buttonPage(a.title, ["This page was made for you."], "Open it", { t: token });
      }
      const phone = await loginOf(await key(), req, now());
      if (phone && await admits(a, phone)) return await enter(a, phone, false);
      return formPage(numberForm(a));
    }
    if (req.method !== "POST") return endPage("Not allowed", "This page takes a form.", false, 405);
    const body = await req.text();
    if (body.length > 4096) return formPage(numberForm(a), "That was too long.", 400);
    const fields = Object.fromEntries(new URLSearchParams(body));
    if (fields.t !== undefined) {
      const whose = a.with.find((p) =>
        p.kind !== "group" && !!fields.t && a.tokens[p.address] === fields.t
      );
      const spend = whose && `${a.slug}:${whose.address}`;
      if (!whose || !spend || spending.has(spend)) {
        return formPage(
          numberForm(a),
          "This link was used already. Log in with your number.",
          400,
        );
      }
      spending.add(spend);
      try {
        await deps.creds.put({
          key: `${ARTIFACT_KEY}${a.slug}`,
          value: { [`${TOKEN}${whose.address}`]: "" },
        });
      } finally {
        spending.delete(spend);
      }
      return await enter(a, digits(whose.address), true);
    }
    const phone = digits(fields.phone ?? "");
    if (phone.length < 8 || phone.length > 15) {
      return formPage(numberForm(a), "Type the whole number, with its country code.", 400);
    }
    if (fields.code === undefined) {
      await offer(a, phone);
      return formPage(codeForm(a, phone));
    }
    const at = `${a.slug}:${phone}`;
    const c = codes.get(at);
    if (!c || c.until <= now()) {
      codes.delete(at);
      return formPage(numberForm(a), "That code ran out. Ask for a new one.", 400);
    }
    if (fields.code.replace(/\s/g, "") !== c.code) {
      c.tries++;
      if (c.tries >= CODE_TRIES) {
        codes.delete(at);
        return formPage(numberForm(a), "Too many tries. Ask for a new code.", 400);
      }
      return formPage(codeForm(a, phone), "That code is not the one sent.", 400);
    }
    codes.delete(at);
    return await enter(a, phone, true);
  };

  const boxText = (status: number, text: string) =>
    new Response(text, {
      status,
      headers: { ...BOX, "content-type": "text/plain; charset=utf-8" },
    });

  /** A request the files did not answer, handed to the server as the visitor's: `rest` is
   *  the path under the view as it came, still encoded. */
  const forward = async (req: Request, a: Artifact, rest: string, phone: string) => {
    const sock = deps.socket(a);
    // the folder is the agent's: only a socket there is spoken to, never a link to another,
    // a hard one included (a socket the server bound has the one name)
    const st = await Deno.lstat(sock).catch(() => null);
    if (!st?.isSocket || st.nlink !== 1) {
      return boxText(502, "This app's server is not running.");
    }
    const headers = new Headers(req.headers);
    // the login opens every artifact the phone belongs to: no server ever holds it
    headers.delete("cookie");
    headers.set(VISITOR_HEADER, phone);
    const body = req.method === "GET" || req.method === "HEAD" ? null : await req.arrayBuffer();
    let res: Response;
    try {
      res = await fetch(`http://localhost/${rest}${new URL(req.url).search}`, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        client: clientFor(sock),
      });
    } catch {
      return boxText(502, "This app's server is not answering.");
    }
    const out = new Headers(res.headers);
    for (const h of DROPPED) out.delete(h);
    for (const [h, v] of Object.entries(BOX)) out.set(h, v);
    return new Response(res.body, { status: res.status, headers: out });
  };

  const box = async (req: Request, a: Artifact, view: string, rest: string) => {
    let path: string;
    try {
      path = decodeURIComponent(rest);
    } catch {
      return boxText(404, "not in this page");
    }
    const phone = await viewer(await key(), a.id, view, now());
    if (!phone) {
      return new Response(null, {
        status: 303,
        headers: { location: `/artifacts/${a.slug}`, "cache-control": "no-store" },
      });
    }
    const reads = req.method === "GET" || req.method === "HEAD";
    const file = path === "" || path.endsWith("/") ? `${path}${ARTIFACT_INDEX}` : path;
    const meta = reads && plainPath(file) ? a.files[file] : undefined;
    const bytes = meta ? await deps.storage.get(fileKey(a, meta)) : null;
    if (meta && bytes) {
      return new Response(bytes as BodyInit, { headers: { ...BOX, "content-type": meta.mime } });
    }
    if (a.server) return await forward(req, a, rest, phone);
    return reads ? boxText(404, "not in this page") : boxText(405, "not allowed");
  };

  return async (req) => {
    const url = new URL(req.url);
    // the door is `/artifacts/<slug>`, a slash after it or not; the box is everything
    // under a view
    const m = /^\/artifacts\/([^/]+)(?:\/(?:([^/]+)\/(.*))?)?$/.exec(url.pathname);
    const a = m ? await readArtifact(deps.creds, m[1]) : null;
    if (!m || !a || a.until <= now()) return gone();
    try {
      if (m[2] === undefined) return await door(req, a);
      return await box(req, a, m[2], m[3]);
    } catch (err) {
      say(`[artifacts] ${a.slug}: ${err}`);
      return endPage(
        "Not now",
        "This page can't check who may open it right now. Try again in a few minutes.",
        false,
        503,
      );
    }
  };
}
