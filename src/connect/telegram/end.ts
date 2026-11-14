/**
 * connect/telegram/end.ts — a removal's end of an account's session on Telegram, run
 * before its key leaves the vault (`connect/remove.ts`'s `end`).
 *
 * A session whose key is gone can never be used again, so ending it loses nothing. The
 * running process holds the session, and one session takes one client: so the removal
 * asks the process first, over its socket (`END_LEG`), and the process logs the session
 * out and forgets its cache. When nothing answers on the socket, or the process held no
 * session for the account, no client holds it, and the removal logs it out itself with
 * the vault's session and the application's pair, and forgets the cache.
 */

import type { ConnectionRow } from "../../store/connections.ts";
import type { Credentials } from "../../store/credentials.ts";
import { logOutSession } from "./client.ts";
import { APP_KEY, cachePath, historyPath, sessionKey } from "./config.ts";
import { END_LEG, type PortCall, PortDown } from "./port.ts";

export interface EndDeps {
  root: string;
  creds: Pick<Credentials, "get">;
  /** The process's socket. */
  call: PortCall;
  /** End a session on Telegram, no client of it running. */
  logOut?: typeof logOutSession;
}

/** End a removed account's session. Answers the sentence the removal says; throws when
 *  Telegram could not be reached. */
export async function endTelegram(row: ConnectionRow, deps: EndDeps): Promise<string> {
  const account = row.address;
  let ended = false;
  try {
    const answer = await deps.call(END_LEG, { connection: account }) as { ended?: boolean };
    ended = answer.ended === true;
  } catch (err) {
    if (!(err instanceof PortDown)) throw err;
  }
  if (!ended) {
    const session = (await deps.creds.get(row.credentialKey ?? sessionKey(account)))?.value
      .session;
    const app = (await deps.creds.get(APP_KEY))?.value;
    if (!session || !app?.api_id || !app.api_hash) {
      throw new Error("the vault holds no session or application to end it with");
    }
    await (deps.logOut ?? logOutSession)({
      apiId: Number(app.api_id),
      apiHash: app.api_hash,
      session,
    });
    for (const path of [cachePath(deps.root, account), historyPath(deps.root, account)]) {
      await Deno.remove(path).catch((err) => {
        if (!(err instanceof Deno.errors.NotFound)) throw err;
      });
    }
  }
  return "its session on Telegram is ended: the account's devices no longer list it";
}
