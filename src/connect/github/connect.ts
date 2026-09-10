/**
 * src/connect/github/connect.ts — `liquen connect github`: the three doors (slack's twins, §4).
 *
 *   app    the GitHub App's credentials, pasted once: App ID + private key (.pem) +
 *          webhook secret → vault `github:app:<app_id>` — what the broker signs
 *          installation JWTs with and what the ingest verifies deliveries against. The
 *          door opens with a link that prefills the registration form (`appForm`) off
 *          `connections.github.events`, so what the app is subscribed to and what the
 *          ingest maps are the same list, and offers a secret for the field no link can
 *          carry.
 *   bot    the org's shared identity: the app's INSTALLATION. Discovered over the app's
 *          JWT (`GET /app/installations` — which also proves the pasted key really is the
 *          app's) → connections: the `github` anchor, org-credentialed → vault
 *          `github:org` (extra: `app_id` + `installation_id`; the broker mints the hourly
 *          installation token from there on demand — nothing static to store).
 *   user   the principal's own leg, by either route — verified via `GET /user` → connections:
 *          the OWNED grant (address = the GitHub login, agent_id = the principal) → vault
 *          `github:<principal>`. The DEFAULT route is the device flow: the app's own
 *          client_id asks GitHub for a user code, the human types it at github.com/login/
 *          device, and the poll returns a user-to-server token — the same thing `gh auth
 *          login` does with its own client id, and no secret ever passes through a
 *          terminal. Where the app expires user tokens (the setting to leave ON), that is
 *          an 8h `access_token` + a rotating `refresh_token`, and the broker re-issues it
 *          hourly like any other (§9). The other route is a pasted personal token
 *          (`--token`): static, no app required, and the fallback when no app is vaulted.
 *
 * WHO POSTS is dispatch's call (the slack resolver policy): the author's user grant when
 * the vault holds one, else `github:org`. The same rows feed the egress proxy: each door
 * writes the proxy declaration (`extra.env` + `extra.hosts`, below) onto its row, and main
 * fronts the org identity (else a lone user grant) as a GH_TOKEN placeholder spendable
 * only toward GitHub — an agent's `gh` works with no real credential in user space (§9).
 *
 * Arg (user door): the principal (default: the OS username). Env: none.
 */

import { helpFlag } from "../help.ts";
import {
  type Appender,
  appJwt,
  type Connections,
  type CredentialRow,
  type Credentials,
  declared,
  type Draft,
  findRoot,
  type MessageEvent,
  orgFlag,
} from "../../connector.ts";
import { entry } from "../../entry.ts";

export const APP_PREFIX = "github:app:";
export const ORG_KEY = "github:org";
/** The grant's proxy declaration (§9), written onto every identity row this connector
 *  mints: the env var main fronts the placeholder under (gh reads GH_TOKEN), and the only
 *  hosts the token may be spent toward (the swap refuses any other dial). */
export const GRANT_ENV = "GH_TOKEN";
export const GRANT_HOSTS = ["api.github.com", "uploads.github.com"];

/* ── the app door: the App's credentials into the vault ──────────────────────────────── */

export interface GithubApp {
  appId: string;
  privateKey: string; // the .pem GitHub downloads (PKCS#1 — node:crypto reads it)
  webhookSecret?: string; // verifies deliveries at the ingest; absent ⇒ unsigned dev mode
  clientId?: string; // the user-to-server OAuth pair — the device flow signs people in with it
  clientSecret?: string;
}

/** Store the App under its own id (the slack/google app doors' twin). The vault's merge
 *  lets a re-paste rotate one field without losing its siblings. */
export async function connectGithubApp(
  app: GithubApp,
  creds: Pick<Credentials, "put">,
): Promise<string> {
  if (!app.appId || !app.privateKey) throw new Error("app id and private key required");
  if (!/^\d+$/.test(app.appId)) {
    throw new Error(`the App ID is the number on the app's About page — got "${app.appId}"`);
  }
  if (!app.privateKey.includes("PRIVATE KEY")) {
    throw new Error("not a PEM private key — point at the .pem the app page generated");
  }
  const key = `${APP_PREFIX}${app.appId}`;
  await creds.put({
    key,
    value: {
      private_key: app.privateKey,
      ...(app.webhookSecret ? { webhook_secret: app.webhookSecret } : {}),
      ...(app.clientId ? { client_id: app.clientId } : {}),
      ...(app.clientSecret ? { client_secret: app.clientSecret } : {}),
    },
  });
  return key;
}

/** The registration form, prefilled by URL parameters (GitHub reads them at
 *  /settings/apps/new): the name, the two permissions a commenter needs, and the events
 *  the ingest maps — `connections.github.events`, so the subscription and the mapping stay
 *  the one list. The webhook stays off: GitHub cannot reach a laptop, and a link cannot
 *  carry a secret, so the URL and the secret are the form's own two blanks. */
export function appForm(org: string, events: string[]): string {
  const form = new URL("https://github.com/settings/apps/new");
  const q = form.searchParams;
  q.set("name", `liquen-${org}`);
  q.set("description", "liquen agents, reading and answering on this org's repositories");
  q.set("url", "https://jsr.io/@liquen/liquen");
  q.set("public", "false");
  q.set("issues", "write");
  q.set("pull_requests", "write");
  q.set("webhook_active", "false");
  for (const e of events) q.append("events[]", e);
  return form.href;
}

/** A webhook secret worth pasting: 32 hex from the platform CSPRNG. Offered, never
 *  assumed — what the vault stores is what the person says the form holds. */
export function suggestSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The app a door builds on: the one `--app` names, the only one in the vault, or a
 *  refusal that says which choice is missing. The two routes that need an app — the
 *  installation and the device flow — pick it the same way; a pasted token needs no app
 *  and never asks. */
export async function pickGithubApp(
  creds: Pick<Credentials, "list">,
  appId?: string,
): Promise<{ app: CredentialRow; appId: string }> {
  const apps = await creds.list(APP_PREFIX);
  const idOf = (row: CredentialRow) => row.key.slice(APP_PREFIX.length);
  if (apps.length === 0) {
    throw new Error(
      "no github app in the vault — `liquen connect github app` registers one; to connect " +
        "without an app at all, paste a token (`liquen connect github user --token`)",
    );
  }
  if (appId) {
    const app = apps.find((a) => idOf(a) === appId);
    if (!app) throw new Error(`no app ${appId} — the vault holds: ${apps.map(idOf).join(" ")}`);
    return { app, appId };
  }
  if (apps.length > 1) {
    throw new Error(`several apps — name one with --app: ${apps.map(idOf).join(" ")}`);
  }
  return { app: apps[0], appId: idOf(apps[0]) };
}

/* ── the bot door: the installation — the org's shared identity ──────────────────────── */

export interface Installation {
  id: number;
  account?: { login?: string };
}

export interface GithubBotDeps {
  creds: Pick<Credentials, "list" | "put">;
  store: Pick<Connections, "upsertConnections">;
  publish: Appender["publish"];
  /** `GET /app/installations` over the app JWT — injectable; default hits api.github.com. */
  listInstallations?: (jwt: string) => Promise<Installation[]>;
  now?: () => string;
}

/** Which of the two things a bot door may have to choose between. */
export interface GithubBotPick {
  account?: string; // the installation, when the app is installed on several accounts
  app?: string; // the app, when the vault holds several
}

/** Bind the org to the app's installation: prove the key (the listing only answers a valid
 *  app JWT), pick the installation, write the org-credentialed anchor, and record the mint
 *  coordinates in the vault. Throws (writing nothing) when the app is missing, uninstalled,
 *  or ambiguous. */
export async function connectGithubBot(
  deps: GithubBotDeps,
  pick: GithubBotPick = {},
): Promise<{ appId: string; installationId: string; account?: string }> {
  const now = deps.now ?? (() => new Date().toISOString());
  const { app, appId } = await pickGithubApp(deps.creds, pick.app);
  if (!app.value.private_key) {
    throw new Error(`${app.key} holds no private key — re-run \`liquen connect github app\``);
  }

  const jwt = appJwt(appId, app.value.private_key, Date.now());
  const installs = await (deps.listInstallations ?? defaultListInstallations)(jwt);
  const inst = pick.account
    ? installs.find((i) => i.account?.login === pick.account || String(i.id) === pick.account)
    : installs.length === 1
    ? installs[0]
    : undefined;
  if (!inst) {
    if (installs.length === 0) {
      throw new Error(
        `app ${appId} is installed nowhere — github.com → the app's page → Install App`,
      );
    }
    const names = installs.map((i) => `${i.account?.login ?? "?"} (${i.id})`).join(" · ");
    throw new Error(
      pick.account
        ? `no installation "${pick.account}" — installed on: ${names}`
        : `several installations — name one: ${names}`,
    );
  }
  const account = inst.account?.login;

  // ONE row: the service anchor, org-credentialed — the app's installation IS the org's
  // identity on GitHub (§6); the mint coordinates are vault sidecar, the token itself is
  // minted hourly by the broker and only ever cached
  deps.store.upsertConnections([{ service: "github", address: "github", credentialKey: ORG_KEY }]);
  await deps.creds.put({
    key: ORG_KEY,
    value: {},
    extra: {
      app_id: appId,
      installation_id: String(inst.id),
      ...(account ? { account } : {}),
      env: GRANT_ENV,
      hosts: GRANT_HOSTS,
    },
  });

  await deps.publish(
    {
      ts: now(),
      type: "message",
      envelope: {
        service: "github",
        connection_address: "github",
        conversation: { address: "connect" },
        sender: { address: "github-connect" },
      },
      parts: [{
        type: "text",
        kind: "text",
        text: `GitHub app ${appId} connected as the org` +
          (account ? ` — installed on ${account}` : "") +
          ` (installation ${inst.id})`,
      }],
    } satisfies Draft<MessageEvent>,
  );
  return { appId, installationId: String(inst.id), ...(account ? { account } : {}) };
}

/* ── the device flow: a user token with no secret through a terminal ─────────────────── */

/** GitHub's answer to `POST /login/device/code`: the code a human types, and the pacing
 *  the poll must keep to. */
export interface DeviceCode {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  expires_in?: number; // seconds the user code stays typable
  interval?: number; // seconds between polls — GitHub errors a faster caller
  error?: string;
  error_description?: string;
}

/** The token endpoint's answer — the same shape the broker's later refreshes read (§9).
 *  `expires_in` arrives only where the app expires user tokens; without it the token is
 *  static and there is no refresh_token to rotate. */
export interface UserTokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number; // seconds — 8h, today
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface DeviceFlowDeps {
  /** The app's OAuth client id — `github:app:<app_id>`'s `client_id` (the app door's). */
  clientId: string;
  /** Where the code reaches a human: a terminal here; a message from the agent later. */
  show: (code: DeviceCode) => void;
  requestCode?: (clientId: string) => Promise<DeviceCode>;
  poll?: (body: URLSearchParams) => Promise<UserTokens>;
  sleep?: (ms: number) => Promise<void>;
}

const POLL_INTERVAL_S = 5; // GitHub's floor when it names none
const SLOW_DOWN_S = 5; // what a `slow_down` adds to the interval, per GitHub's docs
const DEVICE_TTL_S = 900; // how long a user code lives when the start doesn't say

/** Run the device flow to its end: ask for a code, show it, poll until the human finishes
 *  in their browser. Throws when they decline, when the code expires, or when GitHub
 *  complains — nothing is written here; the caller hands what comes back to the user door. */
export async function githubDeviceFlow(deps: DeviceFlowDeps): Promise<UserTokens> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const poll = deps.poll ?? defaultPoll;
  const start = await (deps.requestCode ?? defaultRequestCode)(deps.clientId);
  if (!start.device_code || !start.user_code) {
    throw new Error(`device code: ${start.error_description ?? start.error ?? "no code"}`);
  }
  deps.show(start);

  let wait = (start.interval ?? POLL_INTERVAL_S) * 1000;
  // the deadline is counted in the sleeps this loop takes, not off a clock: waiting is the
  // only time that passes here, so the poll cannot outlive the code it is redeeming
  let left = (start.expires_in ?? DEVICE_TTL_S) * 1000;
  while (left > 0) {
    await sleep(wait);
    left -= wait;
    const tok = await poll(
      new URLSearchParams({
        client_id: deps.clientId,
        device_code: start.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    );
    if (tok.access_token) return tok;
    if (tok.error === "authorization_pending") continue;
    if (tok.error === "slow_down") {
      wait += SLOW_DOWN_S * 1000;
      continue;
    }
    throw new Error(`device flow: ${tok.error_description ?? tok.error ?? "no token"}`);
  }
  throw new Error("device flow: the code expired before it was entered");
}

/* ── a pasted token: the route that needs no app at all ─────────────────────────────── */

/** Every GitHub token is prefixed, and the app page shows the client secret and the webhook
 *  secret an arm's length away — so the shape is checked before the network, and the wrong
 *  paste is named as the wrong paste rather than as a 401. */
function guardTokenShape(token: string): void {
  if (!/^(gh[pousr]_|github_pat_)/.test(token)) {
    throw new Error("not a GitHub token (ghp_… / github_pat_…) — that paste goes elsewhere");
  }
}

/* ── the user door: the principal's own leg ──────────────────────────────────────────── */

/** What the door is handed. A string is a pasted personal token: static, nothing to
 *  refresh. The object is what the device flow returned, carrying `appId` — the coordinate
 *  the broker re-issues by, since only that app's client secret can spend the grant. */
export type UserGrant = string | (UserTokens & { appId: string });

export interface GithubUserDeps {
  /** The registry name the grant belongs to (v0: principal name = agent name). Absent ⇒
   *  the grant is the ORG's: ownerless, the shared identity every agent falls back to
   *  (§6) — a machine user's token, or a person's own lent to the org. */
  principal?: string;
  creds: Pick<Credentials, "put">;
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  publish: Appender["publish"];
  /** `GET /user` with the pasted token — injectable; default hits api.github.com. */
  whoami?: (token: string) => Promise<{ login?: string; message?: string }>;
  now?: () => string;
}

/** Finish a grant by either route and for either owner: verify with GitHub, write the map,
 *  notify the log. Throws (writing nothing) when GitHub rejects the token. */
export async function connectGithubUser(
  grant: UserGrant,
  deps: GithubUserDeps,
): Promise<{ login: string }> {
  const now = deps.now ?? (() => new Date().toISOString());
  const flow = typeof grant === "string" ? undefined : grant;
  const token = flow ? flow.access_token ?? "" : grant as string;

  // the shape is guarded on the paste only: a device-flow token came from GitHub itself
  if (!flow) guardTokenShape(token);
  if (!token) throw new Error("no access token in the grant");

  const who = await (deps.whoami ?? defaultWhoami)(token);
  if (!who.login) throw new Error(`GET /user: ${who.message ?? "no login in response"}`);

  // an agent's grant is two rows (§4): the service anchor — what opens the publish gate —
  // and the OWNED grant, the identity/credential edge the classifier and dispatch resolve
  // through. The org's is the anchor itself, carrying the credential: ownerless and
  // org-credentialed is what the shared inbox IS, and it is the row the installation route
  // writes too, so neither dispatch nor the proxy can tell the two apart
  const credentialKey = deps.principal ? `github:${deps.principal}` : ORG_KEY;
  deps.store.upsertConnections(
    deps.principal
      ? [
        { service: "github", address: "github" },
        { service: "github", address: who.login, agentId: deps.principal, credentialKey },
      ]
      : [{ service: "github", address: "github", credentialKey }],
  );
  if (deps.principal) {
    deps.store.upsertMemberships([
      {
        service: "github",
        connection: "github",
        conversation: "connect",
        agentId: deps.principal,
      },
    ]);
  }
  // an expiring grant is the refreshable one: an access token to spend now, a refresh
  // token to spend later, and the app that re-issues both. Anything else — a PAT, or a
  // user token from an app that doesn't expire them — is static, and rides the `token`
  // slot the broker hands back as-is (§9).
  const refreshable = flow?.expires_in !== undefined && flow.refresh_token
    ? {
      refresh_token: flow.refresh_token,
      app_id: flow.appId,
      expiry: new Date(Date.parse(now()) + flow.expires_in * 1000).toISOString(),
    }
    : undefined;
  await deps.creds.put({
    key: credentialKey,
    // BOTH slots, every time: the vault merges what it is given, so re-connecting by the
    // other route has to blank the credential it replaces or the stale one shadows it
    value: refreshable
      ? { token: "", access_token: token, refresh_token: refreshable.refresh_token }
      : { token, access_token: "", refresh_token: "" },
    ...(deps.principal ? { agentId: deps.principal } : {}),
    extra: {
      login: who.login,
      env: GRANT_ENV,
      hosts: GRANT_HOSTS,
      ...(refreshable ? { app_id: refreshable.app_id, expiry: refreshable.expiry } : {}),
    },
  });

  await deps.publish(
    {
      ts: now(),
      type: "message",
      envelope: {
        service: "github",
        connection_address: "github",
        conversation: { address: "connect" },
        sender: { address: "github-connect" },
      },
      parts: [{
        type: "text",
        kind: "text",
        text: deps.principal
          ? `GitHub connected: ${deps.principal} (github user ${who.login})`
          : `GitHub connected as the org (github user ${who.login})`,
      }],
    } satisfies Draft<MessageEvent>,
  );
  return { login: who.login };
}

/* ── what the org still owes, read off the vault ─────────────────────────────────────── */

/** The pieces a working GitHub connection is made of. The app is one row carrying three
 *  separable things, because each is bought at a different counter on the app's page and an
 *  org may stop at any of them: the key that mints the org's identity, the secret that lets
 *  the ingest trust a delivery, the client that signs a person in. */
export interface GithubHave {
  app: boolean; // `github:app:<app_id>` — the App ID and its private key
  webhookSecret: boolean; // on the app row: what the ingest verifies deliveries against
  clientId: boolean; // on the app row: what the device flow signs a member in with
  org: boolean; // `github:org` — the org's identity, by installation or by pasted token
  user: boolean; // at least one agent's own leg — `github:<agent>`
}

/** Sort the vault's github rows into the pieces. */
export function githubHave(rows: { key: string; value: Record<string, unknown> }[]): GithubHave {
  const have: GithubHave = {
    app: false,
    webhookSecret: false,
    clientId: false,
    org: false,
    user: false,
  };
  for (const r of rows) {
    if (r.key.startsWith(APP_PREFIX)) {
      have.app = true;
      if (r.value.webhook_secret) have.webhookSecret = true;
      if (r.value.client_id) have.clientId = true;
    } else if (r.key === ORG_KEY) have.org = true;
    else have.user = true;
  }
  return have;
}

/** What is still owed, in the order a dev would do it — finishing one door is the natural
 *  moment to learn what the next one is. Nothing here is mandatory in the abstract: an org
 *  whose agents each paste their own token needs no app, and one whose only identity is a
 *  machine user's token needs no installation. What each line buys is the point. */
export function githubNext(have: GithubHave): string[] {
  const next: string[] = [];
  if (!have.org && !have.user) {
    next.push(
      "no identity yet — `liquen connect github user` (your own leg) or " +
        "`liquen connect github bot` (the org's, from an App installation)",
    );
  } else if (!have.org) {
    next.push(
      "no org identity — `liquen connect github bot` binds the App's installation, or " +
        "`liquen connect github user --org --token` pastes a machine user's; without one, " +
        "only the agents who have their own leg can post",
    );
  }
  if (!have.app) {
    next.push(
      "no app — `liquen connect github app` registers one; it is what mints the org's " +
        "token, verifies deliveries, and signs a member in. A pasted token needs none",
    );
    return next;
  }
  if (!have.webhookSecret) {
    next.push(
      "deliveries arrive unsigned — the app page's webhook secret, then re-run " +
        "`liquen connect github app` (fine behind `gh webhook forward`, wrong on a public URL)",
    );
  }
  if (!have.clientId) {
    next.push(
      "no device flow — the app page's Enable Device Flow and its client id, then re-run " +
        "`liquen connect github app`; without it `liquen connect github user` pastes a token",
    );
  }
  return next;
}

/* ── the default API edges ───────────────────────────────────────────────────────────── */

/** How long one GitHub API request may take — a stalled call fails like a refused one. */
const API_TIMEOUT_MS = 30_000;

async function defaultListInstallations(jwt: string): Promise<Installation[]> {
  const res = await fetch("https://api.github.com/app/installations", {
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  const out = await res.json() as Installation[] | { message?: string };
  if (!Array.isArray(out)) {
    throw new Error(`GET /app/installations: ${out.message ?? `HTTP ${res.status}`}`);
  }
  return out;
}

/** The device endpoints live on github.com, not the API host — and they answer form-encoded
 *  unless asked otherwise, which is what the `accept` header is for. */
async function defaultRequestCode(clientId: string): Promise<DeviceCode> {
  const res = await fetch("https://github.com/login/device/code", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ client_id: clientId }),
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  return await res.json() as DeviceCode;
}

async function defaultPoll(body: URLSearchParams): Promise<UserTokens> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  return await res.json() as UserTokens;
}

async function defaultWhoami(token: string): Promise<{ login?: string; message?: string }> {
  const res = await fetch("https://api.github.com/user", {
    headers: { authorization: `token ${token}`, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  return await res.json() as { login?: string; message?: string };
}

/* ── local entry: the three doors ───────────────────────────────────────────────────────
 *
 *   deno task connect github app                # App ID + .pem path + webhook secret
 *   deno task connect github bot [account]      # bind the installation → the org
 *   deno task connect github user [principal]   # device flow → the principal's leg
 *   deno task connect github user [principal] --token   # …by pasting a PAT instead
 *
 * A bare invocation (or a bare principal name) is the user door — the common case. It runs
 * the device flow off the vaulted app's client_id, and falls back to the paste when there
 * is no app to run it with (or when `--token` says so outright). Piped stdin is the paste
 * too: a device flow wants a human at a browser, and a secret manager isn't one. */
const USAGE = `usage: liquen connect github app
       liquen connect github bot [account] [--app <app_id>]
       liquen connect github user [agent] [--org] [--token] [--app <app_id>]

  Connect GitHub. Two identities can exist and either alone is enough to start: the ORG's,
  which every agent falls back to, and an AGENT's own, which posts under that person's
  name. Answers are pasted at a prompt, or piped one per line for a secret manager.

  app     register a GitHub App: the door prints a link that fills the form for you, then
          takes its ID, private key (.pem path), and — both optional — a webhook secret
          (the ingest verifies deliveries with it) and a client id and secret (the device
          flow signs people in with them). Several may coexist.
  bot     the org's identity from the App's INSTALLATION: nothing static is stored and the
          token is minted hourly. Needs an app; for an org that has none, the token route
          below with --org is the whole setup.
  user    a grant by the DEVICE FLOW — a code you type at github.com, no secret through the
          terminal — or by paste. Whose it is: [agent] (default: your OS username), or the
          org's with --org.

  --org         file the grant as the org's, ownerless, rather than an agent's
  --token       paste a token rather than run the device flow; also what happens on its own
                when the vault holds no app with a client id
  --app <id>    which App (its numeric App ID), when the vault holds several
  [account]     which installation, when the App is installed on several accounts
  --dir <org>   the org, when run from elsewhere

  Every door closes by naming what the org still owes. Knobs: connections.github.`;

if (import.meta.main) {
  await entry(async () => {
    const { openLog, openCredentials } = await import("../../connector.ts");
    const { userInfo } = await import("node:os");

    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const root = findRoot(org);
    const dir = `${root}/data`;
    const flags = new Set(org.args.filter((a) => a.startsWith("--")));
    const appFlag = org.args.indexOf("--app");
    const pickedApp = appFlag >= 0 ? org.args[appFlag + 1] : undefined;
    const words = org.args.filter((a) => !a.startsWith("--") && a !== pickedApp);
    const [first, ...rest] = words;
    const verb = first === "app" || first === "bot" || first === "user" ? first : "user";

    /** What the org still owes after this door — read off the vault, so finishing one door
     *  is where you learn what the next one is. */
    const owed = async (creds: { list: (p: string) => Promise<CredentialRow[]> }) => {
      const next = githubNext(githubHave(await creds.list("github:")));
      if (next.length) console.error(`\nstill to do:\n  ${next.join("\n  ")}`);
    };

    /** TTY: interactive prompt; piped stdin: consumed line by line (secret managers). */
    const lines = Deno.stdin.isTerminal()
      ? null
      : (await new Response(Deno.stdin.readable).text()).split("\n").map((l) => l.trim());
    const ask = (label: string): string | undefined =>
      (lines ? lines.shift() : prompt(label)?.trim()) || undefined;

    if (verb === "app") {
      const { githubConfig } = await import("./config.ts");
      const { ingestPort, events } = await githubConfig(root);
      console.error(
        `Register the app (once) — this link fills the form with what this org needs:\n  ${
          appForm(root.split("/").pop() ?? "liquen", events)
        }\n`,
      );
      console.error(
        `Four things a link cannot fill:\n` +
          `  — Webhook secret: a fresh one to paste there and below → ${suggestSecret()}\n` +
          `  — Webhook URL: only if this org answers from the internet; the ingest listens\n` +
          `    on :${ingestPort} at /. Locally leave the webhook off and forward instead:\n` +
          `      gh webhook forward --repo=<owner/repo> --url=http://localhost:${ingestPort}/\n` +
          `  — Enable Device Flow: tick it, and LEAVE ON expire user authorization tokens\n` +
          `    (that pair is what \`liquen connect github user\` signs a person in with)\n` +
          `  — Generate a private key: the button at the bottom downloads the .pem\n`,
      );
      const appId = ask("App ID (the number on the About page):");
      const pemPath = ask("Private key file (path to the .pem):");
      if (!appId || !pemPath) {
        console.error("nothing pasted — nothing written");
        Deno.exit(2);
      }
      const privateKey = await Deno.readTextFile(pemPath);
      const webhookSecret = ask("Webhook secret (verifies ingest; empty to skip):");
      const clientId = ask("Client ID (the device flow signs people in with it):");
      const clientSecret = clientId ? ask("Client secret:") : undefined;
      const creds = await openCredentials(dir);
      try {
        const key = await connectGithubApp(
          { appId, privateKey, webhookSecret, clientId, clientSecret },
          creds,
        );
        console.error(`✓ app stored: ${key}`);
        await owed(creds);
      } finally {
        await creds.close();
      }
      Deno.exit(0);
    }

    if (verb === "bot") {
      const log = await openLog(`${dir}/log`);
      const creds = await openCredentials(dir);
      try {
        const { appId, installationId, account } = await connectGithubBot({
          creds,
          store: log,
          publish: log.publish,
        }, { account: rest[0], app: pickedApp });
        console.error(
          `\n✓ connected: app ${appId} on ${
            account ?? "?"
          } (installation ${installationId}) → the org`,
        );
        console.error("  (deno task status shows the map)");
        await declared(root, "github");
        await owed(creds);
      } finally {
        await creds.close();
        await log.close();
      }
      Deno.exit(0);
    }

    const principal = flags.has("--org") ? undefined : ((first === "user" ? rest[0] : first) ??
      (() => {
        try {
          return userInfo().username;
        } catch {
          return "principal";
        }
      })());

    console.error(
      principal
        ? `Connecting GitHub as agent "${principal}".\n`
        : "Connecting GitHub as the org — ownerless, the identity every agent falls back to.\n",
    );

    const log = await openLog(`${dir}/log`);
    const creds = await openCredentials(dir);

    // the device flow is the route when there is an app to run it with and a human at the
    // terminal to type the code; `--token` and piped stdin both mean the paste instead
    const vaulted = flags.has("--token") || lines
      ? undefined
      : await pickGithubApp(creds, pickedApp).catch((e: Error) => {
        if (pickedApp) throw e; // an app was NAMED — a wrong name is a mistake, not a route
        return undefined;
      });
    const app = vaulted?.app.value.client_id ? vaulted : undefined;

    const grant: UserGrant | undefined = app
      ? await githubDeviceFlow({
        clientId: app.app.value.client_id,
        show: (code) => {
          console.error(`  Open ${code.verification_uri} and enter:  ${code.user_code}\n`);
          console.error("  (waiting — this window finishes on its own)");
        },
      }).then((tok) => ({ ...tok, appId: app.appId })).catch((e: Error) => {
        console.error(`\n${e.message}`);
        return undefined;
      })
      : (() => {
        if (!flags.has("--token") && !lines) {
          console.error(
            vaulted
              ? `(app ${vaulted.appId} has no client id — pasting a token instead)\n`
              : "(no app in the vault — pasting a token instead)\n",
          );
        }
        console.error(
          principal
            ? "Create a fine-grained token (repo: Issues + Pull requests, read & write):"
            : "The org's token — a machine user's, or your own (repo: Issues + Pull " +
              "requests, read & write):",
        );
        console.error("  https://github.com/settings/personal-access-tokens/new\n");
        return ask("Paste the token (github_pat_… / ghp_…):");
      })();
    if (!grant) {
      await creds.close();
      await log.close();
      console.error("nothing to connect — nothing written");
      Deno.exit(2);
    }

    try {
      const { login } = await connectGithubUser(grant, {
        ...(principal ? { principal } : {}),
        creds,
        store: log, // connections live on the Log (§4)
        publish: log.publish,
      });
      console.error(`\n✓ connected: github user ${login} → ${principal ?? "the org"}`);
      console.error("  (deno task status shows the map)");
      await declared(root, "github");
      await owed(creds);
    } finally {
      await creds.close();
      await log.close();
    }
  });
}
