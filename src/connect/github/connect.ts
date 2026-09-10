/**
 * src/connect/github/connect.ts — `liquen connect github`: the three doors (slack's twins, §4).
 *
 *   app    the GitHub App's credentials, pasted once: App ID + private key (.pem) +
 *          webhook secret → vault `github:app:<app_id>` — what the broker signs
 *          installation JWTs with and what the ingest verifies deliveries against.
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

/** The one app in the vault, with its id read back off the key. Both doors that build on
 *  the app — the installation and the device flow — want exactly one and say so the same
 *  way: a missing app and an ambiguous one are different mistakes with different fixes. */
export async function theApp(
  creds: Pick<Credentials, "list">,
): Promise<{ app: CredentialRow; appId: string }> {
  const apps = await creds.list(APP_PREFIX);
  if (apps.length === 0) {
    throw new Error("no github app in the vault — `liquen connect github app` first");
  }
  if (apps.length > 1) {
    const ids = apps.map((a) => a.key.slice(APP_PREFIX.length)).join("\n  ");
    throw new Error(`several apps in the vault — this door expects one:\n  ${ids}`);
  }
  return { app: apps[0], appId: apps[0].key.slice(APP_PREFIX.length) };
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

/** Bind the org to the app's installation: prove the key (the listing only answers a valid
 *  app JWT), pick the installation (`pick` = an account login or id when there are
 *  several), write the org-credentialed anchor, and record the mint coordinates in the
 *  vault. Throws (writing nothing) when the app is missing, uninstalled, or ambiguous. */
export async function connectGithubBot(
  deps: GithubBotDeps,
  pick?: string,
): Promise<{ appId: string; installationId: string; account?: string }> {
  const now = deps.now ?? (() => new Date().toISOString());
  const { app, appId } = await theApp(deps.creds);
  if (!app.value.private_key) {
    throw new Error(`${app.key} holds no private key — re-run \`liquen connect github app\``);
  }

  const jwt = appJwt(appId, app.value.private_key, Date.now());
  const installs = await (deps.listInstallations ?? defaultListInstallations)(jwt);
  const inst = pick
    ? installs.find((i) => i.account?.login === pick || String(i.id) === pick)
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
      pick
        ? `no installation "${pick}" — installed on: ${names}`
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

/* ── the user door: the principal's own leg ──────────────────────────────────────────── */

/** What the door is handed. A string is a pasted personal token: static, nothing to
 *  refresh. The object is what the device flow returned, carrying `appId` — the coordinate
 *  the broker re-issues by, since only that app's client secret can spend the grant. */
export type UserGrant = string | (UserTokens & { appId: string });

export interface GithubUserDeps {
  /** The registry name the grant belongs to (v0: principal name = agent name). */
  principal: string;
  creds: Pick<Credentials, "put">;
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  publish: Appender["publish"];
  /** `GET /user` with the pasted token — injectable; default hits api.github.com. */
  whoami?: (token: string) => Promise<{ login?: string; message?: string }>;
  now?: () => string;
}

/** Finish a user grant by either route: verify with GitHub, write the map, notify the log.
 *  Throws (writing nothing) when GitHub rejects the token. */
export async function connectGithubUser(
  grant: UserGrant,
  deps: GithubUserDeps,
): Promise<{ login: string }> {
  const now = deps.now ?? (() => new Date().toISOString());
  const flow = typeof grant === "string" ? undefined : grant;
  const token = flow ? flow.access_token ?? "" : grant as string;

  // shape guard BEFORE the API call, on the paste only (the flow's token came from GitHub
  // itself): every current token is prefixed, and the app page shows the client secret and
  // webhook secret nearby — the paste-slips to catch
  if (!flow && !/^(gh[pousr]_|github_pat_)/.test(token)) {
    throw new Error("not a GitHub token (ghp_… / github_pat_…) — that paste goes elsewhere");
  }
  if (!token) throw new Error("no access token in the grant");

  const who = await (deps.whoami ?? defaultWhoami)(token);
  if (!who.login) throw new Error(`GET /user: ${who.message ?? "no login in response"}`);

  // two rows (§4): the service anchor — what opens the publish gate — and the OWNED grant,
  // the identity/credential edge the classifier and dispatch resolve through
  const credentialKey = `github:${deps.principal}`;
  deps.store.upsertConnections([
    { service: "github", address: "github" },
    { service: "github", address: who.login, agentId: deps.principal, credentialKey },
  ]);
  deps.store.upsertMemberships([
    { service: "github", connection: "github", conversation: "connect", agentId: deps.principal },
  ]);
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
    agentId: deps.principal,
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
        text: `GitHub connected: ${deps.principal} (github user ${who.login})`,
      }],
    } satisfies Draft<MessageEvent>,
  );
  return { login: who.login };
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
       liquen connect github bot [account]
       liquen connect github user [agent] [--token]

  Connect GitHub — the App into the vault, its installation to the org, a member by
  device flow; pasted at a prompt or piped one per line; knobs: connections.github.

  app     the GitHub App: ID, private key (.pem path), webhook secret, client id and secret
  bot     bind the App's installation on [account] to the org
  user    sign [agent] in (default: your OS username) by the device flow — the default
          door; --token pastes a personal access token instead
  --dir <org>   the org, when run from elsewhere`;

if (import.meta.main) {
  await entry(async () => {
    const { openLog, openCredentials } = await import("../../connector.ts");
    const { userInfo } = await import("node:os");

    const org = orgFlag();
    helpFlag(org.args, USAGE);
    const root = findRoot(org);
    const dir = `${root}/data`;
    const flags = new Set(org.args.filter((a) => a.startsWith("--")));
    const [first, ...rest] = org.args.filter((a) => !a.startsWith("--"));
    const verb = first === "app" || first === "bot" || first === "user" ? first : "user";

    /** TTY: interactive prompt; piped stdin: consumed line by line (secret managers). */
    const lines = Deno.stdin.isTerminal()
      ? null
      : (await new Response(Deno.stdin.readable).text()).split("\n").map((l) => l.trim());
    const ask = (label: string): string | undefined =>
      (lines ? lines.shift() : prompt(label)?.trim()) || undefined;

    if (verb === "app") {
      console.error("Register the app (once): https://github.com/settings/apps/new");
      console.error(
        "  — permissions: Issues + Pull requests (read & write); subscribe to their events",
      );
      console.error("  — set a webhook secret; generate a private key (downloads the .pem)");
      console.error(
        "  — tick Enable Device Flow, and LEAVE ON expire user authorization tokens\n" +
          "    (that pair is what `liquen connect github user` signs a person in with)\n",
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
        console.error(
          `✓ app stored: ${key} — next: \`liquen connect github bot\` binds the installation`,
        );
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
        }, rest[0]);
        console.error(
          `\n✓ connected: app ${appId} on ${
            account ?? "?"
          } (installation ${installationId}) → the org`,
        );
        console.error("  (deno task status shows the map)");
        await declared(root, "github");
      } finally {
        await creds.close();
        await log.close();
      }
      Deno.exit(0);
    }

    const principal = (first === "user" ? rest[0] : first) ?? (() => {
      try {
        return userInfo().username;
      } catch {
        return "principal";
      }
    })();

    console.error(`Connecting GitHub as agent "${principal}".\n`);

    const log = await openLog(`${dir}/log`);
    const creds = await openCredentials(dir);

    // the device flow is the route when there is an app to run it with and a human at the
    // terminal to type the code; `--token` and piped stdin both mean the paste instead
    const vaulted = flags.has("--token") || lines
      ? undefined
      : await theApp(creds).catch(() => undefined);
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
        if (!flags.has("--token")) {
          console.error("(no app with a client id in the vault — pasting a token instead)\n");
        }
        console.error("Create a fine-grained token (repo: Issues + Pull requests, read & write):");
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
        principal,
        creds,
        store: log, // connections live on the Log (§4)
        publish: log.publish,
      });
      console.error(`\n✓ connected: github user ${login} → ${principal}`);
      console.error("  (deno task status shows the map)");
      await declared(root, "github");
    } finally {
      await creds.close();
      await log.close();
    }
  });
}
