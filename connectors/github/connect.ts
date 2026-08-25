/**
 * connectors/github/connect.ts — `mu connect github`: the three doors (slack's twins, §4).
 *
 *   app    the GitHub App's credentials, pasted once: App ID + private key (.pem) +
 *          webhook secret → vault `github:app:<app_id>` — what the broker signs
 *          installation JWTs with and what the ingest verifies deliveries against.
 *   bot    the org's shared identity: the app's INSTALLATION. Discovered over the app's
 *          JWT (`GET /app/installations` — which also proves the pasted key really is the
 *          app's) → connections: the `github` anchor, org-credentialed → vault
 *          `github:org` (extra: `app_id` + `installation_id`; the broker mints the hourly
 *          installation token from there on demand — nothing static to store).
 *   user   the principal's own leg: a pasted personal token (fine-grained PAT), verified
 *          via `GET /user` → connections: the OWNED grant (address = the GitHub login,
 *          agent_id = the principal) → vault `github:<principal>` (`token`, static).
 *
 * WHO POSTS is dispatch's call (the slack resolver policy): the author's user grant when
 * the vault holds one, else `github:org`. The same rows feed the egress proxy: main fronts
 * the org identity (else a lone user grant) as a GH_TOKEN placeholder, so an agent's `gh`
 * works with no real credential in user space (§9).
 *
 * Arg (user door): the principal (default: the OS username). Env: none.
 */

import {
  type Appender,
  appJwt,
  type Connections,
  type Credentials,
  type Draft,
  type MessageEvent,
} from "../../src/connector.ts";

export const APP_PREFIX = "github:app:";
export const ORG_KEY = "github:org";

/* ── the app door: the App's credentials into the vault ──────────────────────────────── */

export interface GithubApp {
  appId: string;
  privateKey: string; // the .pem GitHub downloads (PKCS#1 — node:crypto reads it)
  webhookSecret?: string; // verifies deliveries at the ingest; absent ⇒ unsigned dev mode
  clientId?: string; // the user-to-server OAuth pair — unused until a hosted door needs it
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
  const apps = await deps.creds.list(APP_PREFIX);
  if (apps.length === 0) {
    throw new Error("no github app in the vault — `mu connect github app` first");
  }
  if (apps.length > 1) {
    const ids = apps.map((a) => a.key.slice(APP_PREFIX.length)).join("\n  ");
    throw new Error(`several apps in the vault — this door expects one:\n  ${ids}`);
  }
  const app = apps[0];
  const appId = app.key.slice(APP_PREFIX.length);
  if (!app.value.private_key) {
    throw new Error(`${app.key} holds no private key — re-run \`mu connect github app\``);
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

/* ── the user door: the principal's own leg ──────────────────────────────────────────── */

export interface GithubUserDeps {
  /** The registry name the pasted grant belongs to (v0: principal name = agent name). */
  principal: string;
  creds: Pick<Credentials, "put">;
  store: Pick<Connections, "upsertConnections" | "upsertMemberships">;
  publish: Appender["publish"];
  /** `GET /user` with the pasted token — injectable; default hits api.github.com. */
  whoami?: (token: string) => Promise<{ login?: string; message?: string }>;
  now?: () => string;
}

/** Finish a pasted personal-token grant: verify with GitHub, write the map, notify the
 *  log. Throws (writing nothing) when GitHub rejects the token. */
export async function connectGithubUser(
  token: string,
  deps: GithubUserDeps,
): Promise<{ login: string }> {
  const now = deps.now ?? (() => new Date().toISOString());

  // shape guard BEFORE the API call: every current GitHub token is prefixed, and the app
  // page shows the client secret and webhook secret nearby — the paste-slips to catch
  if (!/^(gh[pousr]_|github_pat_)/.test(token)) {
    throw new Error("not a GitHub token (ghp_… / github_pat_…) — that paste goes elsewhere");
  }

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
  await deps.creds.put({
    key: credentialKey,
    value: { token },
    agentId: deps.principal,
    extra: { login: who.login },
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

async function defaultListInstallations(jwt: string): Promise<Installation[]> {
  const res = await fetch("https://api.github.com/app/installations", {
    headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json" },
  });
  const out = await res.json() as Installation[] | { message?: string };
  if (!Array.isArray(out)) {
    throw new Error(`GET /app/installations: ${out.message ?? `HTTP ${res.status}`}`);
  }
  return out;
}

async function defaultWhoami(token: string): Promise<{ login?: string; message?: string }> {
  const res = await fetch("https://api.github.com/user", {
    headers: { authorization: `token ${token}`, accept: "application/vnd.github+json" },
  });
  return await res.json() as { login?: string; message?: string };
}

/* ── local entry: the three doors ───────────────────────────────────────────────────────
 *
 *   deno task connect:github app                # App ID + .pem path + webhook secret
 *   deno task connect:github bot [account]      # bind the installation → the org
 *   deno task connect:github user [principal]   # paste a PAT → the principal's leg
 *
 * A bare invocation (or a bare principal name) is the user door — the common case. */
if (import.meta.main) {
  const { openLog, openCredentials } = await import("../../src/connector.ts");
  const { userInfo } = await import("node:os");

  const dir = "./data";
  const [first, ...rest] = Deno.args;
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
    console.error("  — set a webhook secret; generate a private key (downloads the .pem)\n");
    const appId = ask("App ID (the number on the About page):");
    const pemPath = ask("Private key file (path to the .pem):");
    if (!appId || !pemPath) {
      console.error("nothing pasted — nothing written");
      Deno.exit(2);
    }
    const privateKey = await Deno.readTextFile(pemPath);
    const webhookSecret = ask("Webhook secret (verifies ingest; empty to skip):");
    const clientId = ask("Client ID (empty to skip):");
    const clientSecret = clientId ? ask("Client secret:") : undefined;
    const creds = await openCredentials(dir);
    try {
      const key = await connectGithubApp(
        { appId, privateKey, webhookSecret, clientId, clientSecret },
        creds,
      );
      console.error(
        `✓ app stored: ${key} — next: \`mu connect github bot\` binds the installation`,
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

  console.error(`Connecting GitHub as principal "${principal}".\n`);
  console.error("Create a fine-grained token (repo scope: Issues + Pull requests, read & write):");
  console.error("  https://github.com/settings/personal-access-tokens/new\n");
  const token = ask("Paste the token (github_pat_… / ghp_…):");
  if (!token) {
    console.error("no token pasted — nothing written");
    Deno.exit(2);
  }

  const log = await openLog(`${dir}/log`);
  const creds = await openCredentials(dir);
  try {
    const { login } = await connectGithubUser(token, {
      principal,
      creds,
      store: log, // connections live on the Log (§4)
      publish: log.publish,
    });
    console.error(`\n✓ connected: github user ${login} → ${principal}`);
    console.error("  (deno task status shows the map)");
  } finally {
    await creds.close();
    await log.close();
  }
}
