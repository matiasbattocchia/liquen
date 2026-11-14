/**
 * connect/github/signin.ts — a GitHub user grant by the device flow, as main holds it
 * (connect/signin.ts).
 *
 * A code: main asks GitHub for a device code through an app with a client id, notes it on
 * the ticket, says the code and where to type it, and polls until the person finishes.
 * The ticket then judges the login, and the grant is written as the user door writes one
 * (`connectGithubUser`). A restart takes the poll up from the noted code.
 */

import { SIGN_IN_MS, type SignInFlow } from "../signin.ts";
import type { CredentialRow } from "../../store/credentials.ts";
import {
  APP_PREFIX,
  connectGithubUser,
  type DeviceCode,
  githubDeviceFlow,
  githubWhoami,
  ORG_KEY,
  type UserTokens,
} from "./connect.ts";

const COMMAND = "liquen connect github user";

export function createGithubSignIn(
  opts: {
    requestCode?: (clientId: string) => Promise<DeviceCode>;
    poll?: (body: URLSearchParams) => Promise<UserTokens>;
    whoami?: (token: string) => Promise<{ login?: string; message?: string }>;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): SignInFlow {
  const whoami = opts.whoami ?? githubWhoami;
  return {
    life: () => SIGN_IN_MS,

    async prepare(ask, ctx) {
      const grant = ask.account
        ? await ctx.creds.get(ask.agent ? `github:${ask.agent}` : ORG_KEY)
        : null;
      const made = typeof grant?.extra?.app_id === "string" ? grant.extra.app_id : undefined;
      const named = ask.app ?? made;
      let app: CredentialRow | null;
      if (named) {
        app = await ctx.creds.get(`${APP_PREFIX}${named}`);
        if (!app) throw new Error(`no GitHub app ${named} in the vault`);
      } else {
        const apps = (await ctx.creds.list(APP_PREFIX)).filter((a) => a.value.client_id);
        if (apps.length === 0) {
          throw new Error(
            "GitHub signs in by the device flow through an app with a client id, and the " +
              "vault holds none: `liquen connect github app` adds one; a token is pasted at " +
              "`liquen connect github user --token`",
          );
        }
        if (apps.length > 1) {
          throw new Error(`several apps in the vault: \`${COMMAND} --app <id>\` picks one`);
        }
        app = apps[0];
      }
      if (!app.value.client_id) {
        throw new Error(`GitHub app ${named} has no client id: the device flow needs one`);
      }
      // the org's account is the anchor `github`; the login its grant recorded is what a
      // reconnect of it must come back as
      const login = ask.account === "github" && typeof grant?.extra?.login === "string"
        ? grant.extra.login
        : undefined;
      return {
        app: app.key.slice(APP_PREFIX.length),
        clientId: app.value.client_id,
        ...(login ? { account: login } : {}),
      };
    },

    async run(t, ctx, gate, signal) {
      const clientId = String(t.extra.clientId);
      const noted = t.extra.device as DeviceCode | undefined;
      const tok = await githubDeviceFlow({
        clientId,
        signal,
        ...(noted ? { started: noted } : {}),
        ...(opts.requestCode ? { requestCode: opts.requestCode } : {}),
        ...(opts.poll ? { poll: opts.poll } : {}),
        ...(opts.sleep ? { sleep: opts.sleep } : {}),
        show: async (code) => {
          if (!noted) await gate.note(t.ticket, { device: code });
          await gate.say(t.ticket, {
            code: code.user_code!,
            where: `Open ${code.verification_uri} and enter the code.`,
            until: t.deadline,
          });
        },
      });
      const who = await whoami(tok.access_token ?? "");
      if (!who.login) throw new Error(`GET /user: ${who.message ?? "no login in response"}`);
      const verdict = await gate.judge(t.ticket, {
        address: t.agentId ? who.login : "github",
        account: who.login,
      });
      if ("refused" in verdict) return;
      await connectGithubUser({ ...tok, appId: String(t.extra.app) }, {
        ...(verdict.agent ? { principal: verdict.agent } : {}),
        creds: ctx.creds,
        store: ctx.log,
        publish: ctx.log.publish,
        whoami: () => Promise.resolve(who),
      });
      await gate.landed(t.ticket, who.login);
    },
  };
}
