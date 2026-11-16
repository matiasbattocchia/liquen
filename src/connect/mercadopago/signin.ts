/**
 * connect/mercadopago/signin.ts — Mercado Pago's sign-in as main holds it: a page
 * (connect/page.ts).
 *
 * The page asks for the account's access token. `GET /users/me` vouches for the user id,
 * and for the email a grant for another agent is matched by; a token it refuses draws the
 * page again. Once the ticket judges the account, the grant and its note are written by
 * the CLI door's path (`connectMercadopago`).
 */

import { SIGN_IN_MS, type SignInFlow } from "../signin.ts";
import { endPage, pageHandler, pageStart, whose } from "../page.ts";
import { ingestAddress } from "../../edge.ts";
import { connectMercadopago, type Me, mercadopagoWhoami } from "./connect.ts";
import { SERVICE } from "./payments.ts";

export function createMercadopagoSignIn(
  opts: { whoami?: (token: string) => Promise<Me> } = {},
): SignInFlow {
  const whoami = opts.whoami ?? mercadopagoWhoami;
  return {
    life: () => SIGN_IN_MS,
    prepare: () => Promise.resolve({}),
    link: {
      handler: pageHandler({
        form: (t) => ({
          title: "Connect Mercado Pago",
          lines: [
            `This connects ${whose(t)} Mercado Pago account` +
            (typeof t.extra.account === "string" ? `, user ${t.extra.account}.` : "."),
            "Paste the account's production Access Token (APP_USR-…), from its " +
            "application's Credentials in Mercado Pago Developers.",
          ],
          fields: [{ name: "token", label: "Access token", type: "password", autocomplete: "off" }],
          submit: "Connect",
        }),

        async take(t, fields, ctx, gate, again) {
          const token = (fields.token ?? "").trim();
          if (!token) return await again("Paste the token first.");
          let me: Me;
          try {
            me = await whoami(token);
          } catch (err) {
            return await again(`Mercado Pago did not answer: ${messageOf(err)}`);
          }
          if (me.id === undefined) {
            return await again(`Mercado Pago refused the token: ${me.message ?? "no user id"}`);
          }
          const address = String(me.id);
          const verdict = await gate.judge(t.ticket, {
            address,
            ...(me.email ? { email: me.email } : {}),
          });
          if ("refused" in verdict) return endPage("Not connected", verdict.refused, false, 403);
          try {
            const { publicUrl } = ctx.edge;
            const { account } = await connectMercadopago(token, {
              ...(verdict.agent ? { principal: verdict.agent } : {}),
              ...(publicUrl ? { ingest: ingestAddress(publicUrl, SERVICE) } : {}),
              creds: ctx.creds,
              store: ctx.log,
              publish: ctx.log.publish,
              whoami: () => Promise.resolve(me),
            });
            await gate.landed(t.ticket, account.id);
            return endPage(
              "Connected",
              `Mercado Pago ${
                account.nickname ?? account.id
              } is connected. You can close this page.`,
              true,
            );
          } catch (err) {
            await gate.failed(t.ticket, messageOf(err));
            return endPage("Not connected", messageOf(err), false, 502);
          }
        },
      }),
      start: pageStart("mercadopago"),
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
