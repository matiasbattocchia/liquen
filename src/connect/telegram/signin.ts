/**
 * connect/telegram/signin.ts — Telegram's sign-in as main holds it: a page
 * (connect/page.ts).
 *
 * The page asks for the phone number, filled from the row when it holds one. Telegram
 * sends the account a code, and the page asks for it, then for the two-step password when
 * the account has one. A wrong code or password asks again; any other failure asks for
 * the number again, the ticket left open. The sign-in runs here, in main, the library
 * loaded only for it, and is held in memory: a restart begins the page again. Once the
 * account is known the ticket judges it (its id pins a reconnect, its phone matches a
 * grant for another agent), and the grant is written by the CLI door's path
 * (`connectTelegram`).
 */

import { digits, type FlowCtx, type Gate, SIGN_IN_MS, type SignInFlow } from "../signin.ts";
import { endPage, type Form, formPage, pageHandler, pageStart, whose } from "../page.ts";
import type { TicketRow } from "../../store/credentials.ts";
import type { SignInOptions } from "./client.ts";
import type { TgPeer } from "./wire.ts";
import { APP_KEY } from "./config.ts";
import { connectTelegram } from "./connect.ts";

type Wants = "code" | "password";

/** What the page shows next: a step the sign-in waits on, how it ended, or why it failed
 *  before anyone was judged. */
type Next = { wants: Wants; wrong: boolean } | { over: Response } | { error: string };

/** One sign-in under way: what it waits on, and the page that answers next. */
interface Run {
  wants?: Wants;
  give?: (answer: string) => void;
  wrong?: Wants;
  next: PromiseWithResolvers<Next>;
  abort: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}

/** How long a page waits on Telegram for its next step. */
const STEP_WAIT_MS = 60_000;

type SignIn = (o: SignInOptions) => Promise<{ session: string; self: TgPeer }>;

export function createTelegramSignIn(
  opts: { signIn?: SignIn; stepWaitMs?: number } = {},
): SignInFlow {
  const runs = new Map<string, Run>();
  const stepWaitMs = opts.stepWaitMs ?? STEP_WAIT_MS;

  const end = (ticket: string, run: Run) => {
    clearTimeout(run.timer);
    if (runs.get(ticket) === run) runs.delete(ticket);
  };

  const form = (t: TicketRow): Form => {
    const wants = runs.get(t.ticket)?.wants;
    if (wants === "code") {
      return {
        title: "Connect Telegram",
        lines: [
          "Telegram sent the account a code, in the Telegram app or by SMS.",
          "Type it here and nowhere else: Telegram voids a code that is sent in a chat.",
        ],
        fields: [{
          name: "code",
          label: "Code",
          type: "text",
          autocomplete: "one-time-code",
          inputmode: "numeric",
        }],
        submit: "Sign in",
      };
    }
    if (wants === "password") {
      return {
        title: "Connect Telegram",
        lines: ["The account has a two-step verification password."],
        fields: [{
          name: "password",
          label: "Password",
          type: "password",
          autocomplete: "current-password",
        }],
        submit: "Sign in",
      };
    }
    const hint = typeof t.extra.hint === "string" ? t.extra.hint : undefined;
    return {
      title: "Connect Telegram",
      lines: [
        `This connects ${whose(t)} Telegram account.`,
        "Telegram sends the account a code once it has the number.",
      ],
      fields: [{
        name: "phone",
        label: "Phone number, with the country code",
        type: "tel",
        autocomplete: "tel",
        inputmode: "tel",
        ...(hint ? { value: hint } : {}),
      }],
      submit: "Send the code",
    };
  };

  /** Begin a sign-in for the number: the run, its first step still to come. */
  const begin = (t: TicketRow, phone: string, ctx: FlowCtx, gate: Gate): Run => {
    const run: Run = { next: Promise.withResolvers(), abort: new AbortController() };
    run.timer = setTimeout(() => run.abort.abort(), Math.max(0, t.deadline - Date.now()));
    runs.set(t.ticket, run);
    let waiting: PromiseWithResolvers<string> | undefined;
    run.abort.signal.addEventListener("abort", () => waiting?.reject(new Error("it lapsed")));
    const ask = (kind: Wants): Promise<string> => {
      waiting = Promise.withResolvers<string>();
      const answer = waiting;
      run.wants = kind;
      run.give = (s) => {
        run.give = undefined;
        answer.resolve(s);
      };
      const wrong = run.wrong === kind;
      run.wrong = undefined;
      run.next.resolve({ wants: kind, wrong });
      return answer.promise;
    };

    (async (): Promise<Next> => {
      const app = await ctx.creds.get(APP_KEY);
      if (!app?.value.api_id || !app.value.api_hash) {
        throw new Error("Telegram's application is not in the vault");
      }
      const signIn = opts.signIn ?? (await import("./client.ts")).signIn;
      const { session, self } = await signIn({
        apiId: Number(app.value.api_id),
        apiHash: app.value.api_hash,
        phone,
        code: () => ask("code"),
        password: () => ask("password"),
        onQr: () => {},
        invalid: (kind) => void (run.wrong = kind),
        sent: () => {},
        signal: run.abort.signal,
      });
      const verdict = await gate.judge(t.ticket, {
        address: self.id,
        ...(self.phone ? { phone: self.phone } : {}),
      });
      if ("refused" in verdict) {
        return { over: endPage("Not connected", verdict.refused, false, 403) };
      }
      try {
        await connectTelegram({
          signIn: () => Promise.resolve({ session, self }),
          ...(verdict.agent ? { principal: verdict.agent } : {}),
          self: t.extra.self === true,
          creds: ctx.creds,
          store: ctx.log,
          publish: ctx.log.publish,
        });
      } catch (err) {
        await gate.failed(t.ticket, messageOf(err));
        return { over: endPage("Not connected", messageOf(err), false, 502) };
      }
      await gate.landed(t.ticket, self.id);
      const who = self.username ? `@${self.username}` : self.name ?? self.id;
      return {
        over: endPage("Connected", `Telegram ${who} is connected. You can close this page.`, true),
      };
    })().then(
      (next) => {
        end(t.ticket, run);
        run.next.resolve(next);
      },
      (err) => {
        end(t.ticket, run);
        run.next.resolve({ error: messageOf(err) });
      },
    );
    return run;
  };

  /** The page for whatever the run says next, waited on a while. */
  const step = async (
    t: TicketRow,
    run: Run,
    again: (error: string) => Promise<Response>,
  ): Promise<Response> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const next = await Promise.race([
      run.next.promise,
      new Promise<null>((r) => timer = setTimeout(() => r(null), stepWaitMs)),
    ]);
    clearTimeout(timer);
    if (next === null) {
      return endPage(
        "Still waiting on Telegram",
        "Telegram has not answered yet. Reload this page in a moment.",
        false,
        504,
      );
    }
    if ("over" in next) return next.over;
    if ("error" in next) return await again(`Telegram said: ${next.error}. Try again.`);
    return formPage(form(t), next.wrong ? `That ${next.wants} was wrong: try again.` : undefined);
  };

  return {
    life: () => SIGN_IN_MS,

    async prepare(ask, ctx) {
      const app = await ctx.creds.get(APP_KEY);
      if (!app?.value.api_id || !app.value.api_hash) {
        throw new Error(
          "no Telegram application in the vault yet: `liquen connect telegram app` at the " +
            "terminal adds it",
        );
      }
      const row = (await ctx.log.agents()).find((a) => a.agentId === ask.agent);
      const hint = ask.phone ?? row?.phone;
      return hint ? { hint } : {};
    },

    link: {
      handler: pageHandler({
        form,
        async take(t, fields, ctx, gate, again) {
          const run = runs.get(t.ticket);
          if ("code" in fields || "password" in fields) {
            const answer = (fields.code ?? fields.password ?? "").trim();
            if (!run?.give) return await again("That step is over: give the number again.");
            if (!answer) return await again(`Type the ${run.wants} first.`);
            run.next = Promise.withResolvers();
            run.give(answer);
            return await step(t, run, again);
          }
          const phone = (fields.phone ?? "").trim();
          if (!digits(phone)) return await again("Type the account's phone number.");
          if (run) {
            run.abort.abort();
            end(t.ticket, run);
          }
          return await step(t, begin(t, phone, ctx, gate), again);
        },
      }),
      start: pageStart("telegram"),
    },
  };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
