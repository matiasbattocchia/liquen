/**
 * connect/slack/signin.ts — a member's Slack leg, signed in as main holds it
 * (connect/signin.ts).
 *
 * A link, always someone's: the ticket names the agent, keeps the app and the user
 * scopes, and the handler (oauth.ts) is served on Slack's oauth socket while any Slack
 * ticket is open. Slack registers https redirects only, so the org needs its public
 * address (`edge.publicUrl`).
 */

import { appOf, SIGN_IN_MS, type SignInFlow } from "../signin.ts";
import { callbackAddress } from "../../edge.ts";
import { createSlackOAuth } from "./oauth.ts";
import { slackConfig } from "./config.ts";
import { APP_PREFIX, slackDoor } from "./connect.ts";

const COMMAND = "liquen connect slack user";

export const slackSignIn: SignInFlow = {
  life: () => SIGN_IN_MS,

  async prepare(ask, ctx) {
    if (!ask.agent) throw new Error("a Slack user token is always someone's: name the agent");
    if (ctx.edge.publicUrl === null) {
      throw new Error(
        "Slack redirects to https only, and this org has no public address: edge.publicUrl " +
          "names it, and `liquen connect slack app` registers <publicUrl>/slack/oauth/callback",
      );
    }
    slackDoor(callbackAddress(ctx.edge, "slack"));
    const app = await appOf(ctx.creds, APP_PREFIX, COMMAND, ask.app);
    const scopes = ask.scopes ?? (await slackConfig(ctx.root)).userScopes;
    return { app: app.value.client_id, scopes };
  },

  link: {
    handler: (ctx, gate) =>
      createSlackOAuth({
        gate,
        creds: ctx.creds,
        publish: ctx.log.publish,
        store: ctx.log,
        config: async (t) => {
          const app = await appOf(ctx.creds, APP_PREFIX, COMMAND, String(t.extra.app));
          return {
            clientId: app.value.client_id,
            clientSecret: app.value.client_secret,
            redirectUri: callbackAddress(ctx.edge, "slack"),
          };
        },
      }),
    start: (t, ctx) => {
      const door = slackDoor(callbackAddress(ctx.edge, "slack"));
      const link = new URL(door.start);
      link.searchParams.set("ticket", t.ticket);
      return { link: link.href, loopback: door.loopback };
    },
  },
};
