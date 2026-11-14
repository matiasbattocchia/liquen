/**
 * connect/google/signin.ts — Google's sign-in as main holds it (connect/signin.ts).
 *
 * A link: the ticket keeps the app and the scopes, and the handler (oauth.ts) is served on
 * Google's oauth socket while any Google ticket is open. A reconnect goes through the app
 * that made the grant and asks what the grant held; a new sign-in takes the vault's one
 * app and the catalog's scopes, or what the CLI named.
 */

import { appOf, scopesHeld, SIGN_IN_MS, type SignInFlow } from "../signin.ts";
import { callbackAddress } from "../../edge.ts";
import { doorAddress } from "../door.ts";
import { createGoogleOAuth } from "./oauth.ts";
import { googleConfig } from "./config.ts";
import { APP_PREFIX } from "./connect.ts";

export const googleSignIn: SignInFlow = {
  life: () => SIGN_IN_MS,

  async prepare(ask, ctx) {
    // a redirect the handler would never answer is refused before anyone consents
    doorAddress(callbackAddress(ctx.edge, "google"));
    const grant = ask.account ? await ctx.creds.get(`google:${ask.account}`) : null;
    const made = typeof grant?.extra?.client_id === "string" ? grant.extra.client_id : undefined;
    const app = await appOf(
      ctx.creds,
      APP_PREFIX,
      "liquen connect google account",
      ask.app ?? made,
    );
    const scopes = ask.scopes ?? scopesHeld(grant) ?? (await googleConfig(ctx.root)).scopes;
    return { app: app.value.client_id, scopes };
  },

  link: {
    handler: (ctx, gate) =>
      createGoogleOAuth({
        gate,
        creds: ctx.creds,
        publish: ctx.log.publish,
        store: ctx.log,
        config: async (t) => {
          const app = await appOf(
            ctx.creds,
            APP_PREFIX,
            "liquen connect google account",
            String(t.extra.app),
          );
          return {
            clientId: app.value.client_id,
            clientSecret: app.value.client_secret,
            redirectUri: callbackAddress(ctx.edge, "google"),
          };
        },
      }),
    start: (t, ctx) => {
      const door = doorAddress(callbackAddress(ctx.edge, "google"));
      const link = new URL(door.start);
      link.searchParams.set("ticket", t.ticket);
      return { link: link.href, loopback: door.loopback };
    },
  },
};
