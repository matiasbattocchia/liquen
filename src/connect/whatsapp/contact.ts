/**
 * connect/whatsapp/contact.ts — the address book's write side, whatsapp's port (§9).
 *
 * The `contact` tool's wire leg: one `POST /dispatch` of type `contact` at the bridge,
 * which writes the account's address book with the same app-state patch a linked WhatsApp
 * Web writes. The call answers once WhatsApp has the patch, with the name it carried —
 * the model's own, or the wire's word for the person when the model named nobody — so
 * the tool result IS the outcome and the log keeps no entry of its own. The book stays
 * WhatsApp's; what the log sees of it is `sender_saved` on the person's next line, which
 * renders `contact="…"` where it read `external="…"` before.
 *
 * The bridge's error contract is the dispatch's: 4xx permanent, 5xx transient. Either is
 * the tool's failure here — an errored `tool_result` the model reads and re-decides.
 */

import type { ContactPort } from "../../xi.ts";
import { DispatchError } from "../errors.ts";
import { timedFetch } from "../http.ts";

/** Bind the port to a bridge: `base` is `connections.whatsapp.bridgeUrl`, `token` the
 *  shared `WA_BRIDGE_TOKEN`. */
export function whatsappContact(
  base: string,
  token: string,
  fetchApi: typeof fetch = timedFetch,
): ContactPort {
  return async ({ connection, address, name, remove }) => {
    const res = await fetchApi(`${base}/dispatch`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        type: "contact",
        record: { organization_address: connection, conversation_address: address },
        contact: { name: name ?? "", remove: remove === true },
      }),
    });
    if (!res.ok) {
      const reason = (await res.text()).slice(0, 256).trim();
      throw new DispatchError(`bridge /dispatch HTTP ${res.status}: ${reason}`, res.status);
    }
    const out = await res.json() as { name?: string };
    return out.name ? { name: out.name } : {};
  };
}
