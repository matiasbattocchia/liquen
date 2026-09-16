/**
 * connect/whatsapp/contact.ts — the address book, whatsapp's port (§9): both legs.
 *
 * `write` is the `contact` tool's wire leg: one `POST /dispatch` of type `contact` at the
 * bridge, which writes the account's address book with the same app-state patch a linked
 * WhatsApp Web writes. The call answers once WhatsApp has the patch, with the name it
 * carried — the model's own, or the wire's word for the person when the model named
 * nobody.
 *
 * `lookup` is `search`'s: `GET /contacts/{address}?q=…`, which the bridge answers
 * out of whatsmeow's own contact store — the entries the ACCOUNT named, the same ones
 * `sender_saved` marks a message with. So a person the account saved is findable before
 * they have ever written, and the book stays where it is.
 *
 * It is bounded (`timedFetch`) and unqueued, so the tool result IS the outcome and the
 * model is its own retry. That is affordable where a message's is not: the book is
 * WhatsApp's, the patch is idempotent, and a save that never landed costs a second call —
 * so nothing outlives the call for the log to track. The book stays WhatsApp's; what the
 * log sees of it is `sender_saved` on the person's next line, which renders `contact="…"`
 * where it read `external="…"` before.
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
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  return {
    write: async ({ connection, address, name, remove }) => {
      const res = await fetchApi(`${base}/dispatch`, {
        method: "POST",
        headers,
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
    },
    lookup: async ({ connection, query }) => {
      const url = `${base}/contacts/${encodeURIComponent(connection)}?q=${
        encodeURIComponent(query)
      }`;
      const res = await fetchApi(url, { headers });
      if (!res.ok) {
        const reason = (await res.text()).slice(0, 256).trim();
        throw new DispatchError(`bridge contacts HTTP ${res.status}: ${reason}`, res.status);
      }
      const out = await res.json() as {
        contacts?: { address: string; extra?: { name?: string } }[];
      };
      // the wire's entry shape is the webhook's; an entry with no name is not a book entry
      return (out.contacts ?? []).flatMap((c) =>
        c.extra?.name ? [{ name: c.extra.name, address: c.address }] : []
      );
    },
  };
}
