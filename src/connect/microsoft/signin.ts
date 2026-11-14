/**
 * connect/microsoft/signin.ts — Microsoft's sign-in as main holds it (connect/signin.ts).
 *
 * Google's twin: a link, the ticket keeping the app registration and the scopes, the
 * handler (oauth.ts) served on Microsoft's oauth socket while any Microsoft ticket is
 * open. The tenant is the app row's.
 */

import { appOf, scopesHeld, SIGN_IN_MS, type SignInFlow } from "../signin.ts";
import { callbackAddress } from "../../edge.ts";
import { doorAddress } from "../door.ts";
import { createMicrosoftOAuth } from "./oauth.ts";
import { microsoftConfig } from "./config.ts";
import { APP_PREFIX } from "./connect.ts";

const COMMAND = "liquen connect microsoft account";

export const microsoftSignIn: SignInFlow = {
  life: () => SIGN_IN_MS,

  async prepare(ask, ctx) {
    // a redirect the handler would never answer is refused before anyone consents
    doorAddress(callbackAddress(ctx.edge, "microsoft"));
    const grant = ask.account ? await ctx.creds.get(`microsoft:${ask.account}`) : null;
    const made = typeof grant?.extra?.client_id === "string" ? grant.extra.client_id : undefined;
    const app = await appOf(ctx.creds, APP_PREFIX, COMMAND, ask.app ?? made);
    const scopes = ask.scopes ?? scopesHeld(grant) ?? (await microsoftConfig(ctx.root)).scopes;
    return { app: app.value.client_id, scopes };
  },

  link: {
    handler: (ctx, gate) =>
      createMicrosoftOAuth({
        gate,
        creds: ctx.creds,
        publish: ctx.log.publish,
        store: ctx.log,
        config: async (t) => {
          const app = await appOf(ctx.creds, APP_PREFIX, COMMAND, String(t.extra.app));
          return {
            clientId: app.value.client_id,
            clientSecret: app.value.client_secret,
            tenant: String(app.extra?.tenant ?? "organizations"),
            redirectUri: callbackAddress(ctx.edge, "microsoft"),
          };
        },
      }),
    start: (t, ctx) => {
      const door = doorAddress(callbackAddress(ctx.edge, "microsoft"));
      const link = new URL(door.start);
      link.searchParams.set("ticket", t.ticket);
      return { link: link.href, loopback: door.loopback };
    },
  },
};
