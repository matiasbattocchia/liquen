/**
 * connect/token/signin.ts — a pasted token's sign-in as main holds it: a page
 * (connect/page.ts).
 *
 * The call names the token (what it is for, the variable the agent reads, the hosts and
 * paths it may be spent toward), checked as `liquen connect token` checks them before a
 * ticket opens. The page says all of it before the paste, so the person sees where the
 * token goes. The probe runs when one is named, and a token it refuses draws the page
 * again; then the ticket judges, and the row is written by the CLI door's path
 * (`grantToken`). A token is capability, not identity: no account to match, and no
 * connection to declare.
 */

import { SIGN_IN_MS, type SignInFlow } from "../signin.ts";
import { endPage, pageHandler, pageStart, whose } from "../page.ts";
import type { TicketRow } from "../../store/credentials.ts";
import {
  checkTokenArgs,
  grantToken,
  probeToken,
  type TokenArgs,
  type TokenDeps,
  tokenKey,
} from "./grant.ts";

/** The token a ticket is for, with whose it is. */
function argsOf(t: TicketRow): TokenArgs {
  const args = t.extra.token as TokenArgs;
  return { ...args, ...(t.agentId ? { agentId: t.agentId } : {}) };
}

export function createTokenSignIn(opts: TokenDeps = {}): SignInFlow {
  return {
    life: () => SIGN_IN_MS,
    declares: false,

    prepare(ask) {
      if (!ask.token) {
        throw new Error("a token's sign-in names it: `token: {name, env, hosts}`");
      }
      checkTokenArgs({ ...ask.token, ...(ask.agent ? { agentId: ask.agent } : {}) });
      return Promise.resolve({});
    },

    link: {
      handler: pageHandler({
        form(t) {
          const args = argsOf(t);
          return {
            title: `A token for ${args.name}`,
            lines: [
              `This stores ${whose(t)} token for ${args.name}. The agent reads $${args.env}, ` +
              "a stand-in: the token itself is added on the way out, and only toward " +
              (args.paths ? "these hosts, under these paths:" : "these hosts:"),
            ],
            list: [...args.hosts, ...(args.paths ?? []).map((p) => `under ${p}`)],
            fields: [{ name: "token", label: "Token", type: "password", autocomplete: "off" }],
            submit: args.probe ? "Try it and store it" : "Store it",
          };
        },

        async take(t, fields, ctx, gate, again) {
          const args = argsOf(t);
          const token = (fields.token ?? "").trim();
          if (!token) return await again("Paste the token first.");
          try {
            await probeToken(args, token, opts);
          } catch (err) {
            return await again(messageOf(err));
          }
          const key = tokenKey(args.name, args.agentId);
          const verdict = await gate.judge(t.ticket, { address: key });
          if ("refused" in verdict) return endPage("Not stored", verdict.refused, false, 403);
          try {
            // the probe ran above, before the judge spent the ticket
            const { probe: _probe, ...rest } = args;
            const { contention } = await grantToken(ctx.creds, rest, token, opts);
            // a row another claims the variable over is stored but never fronted, and the
            // call that asked for it hears so
            await gate.landed(t.ticket, contention ? `${key}; but ${contention}` : key);
            return endPage(
              "Stored",
              `The token for ${args.name} is stored. You can close this page.`,
              true,
            );
          } catch (err) {
            await gate.failed(t.ticket, messageOf(err));
            return endPage("Not stored", messageOf(err), false, 502);
          }
        },
      }),
      start: pageStart("token"),
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
