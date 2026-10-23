/**
 * sender.ts — what a wire says about a sender beyond the address and the name the envelope
 * holds (§3). The log keeps a sender in two columns; a fact a service adds rides the row's
 * `extra`, under a `sender_*` key, so it survives the write and every reader finds it in one
 * place:
 *
 *   sender_email   the email the service knows them by, where the address is not one
 *                  already (a Slack or Teams user id): the handle that names a person on
 *                  every other surface, and tells a principal from a namesake
 *   sender_saved   the name is the ACCOUNT's word for them, out of its address book (a
 *                  WhatsApp contact), not the sender's own (a pushname): the line's
 *                  `contact` against `external`
 *
 * A mirror copy carries them over from the line it copies, and a CC from the mind row it
 * crosses, with `sender_name`, the name its tag says — what a dispatcher that knows the
 * person by the email writes in its place.
 */

import type { Event } from "./types.ts";

export const SENDER_EMAIL = "sender_email";
export const SENDER_SAVED = "sender_saved";
export const SENDER_NAME = "sender_name";

/** An address that is an email already — a mailbox's, the portal's — needs no `sender_email`. */
export function isEmail(address: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(address);
}

/** The email a row's sender is known by: the wire's, or the address where it is one. */
export function senderEmail(e: Event): string | undefined {
  const said = e.extra?.[SENDER_EMAIL];
  if (typeof said === "string" && said !== "") return said;
  const address = e.envelope.sender?.address;
  return address && isEmail(address) ? address : undefined;
}

/** The sender's name is the account's word for them (`sender_saved`). */
export function senderSaved(e: Event): boolean {
  return e.extra?.[SENDER_SAVED] === true;
}

/** The `sender_*` facts a row carries, to copy onto a row made from it. */
export function senderFacts(e: Event): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [SENDER_EMAIL, SENDER_SAVED]) {
    if (e.extra?.[key] !== undefined) out[key] = e.extra[key];
  }
  return out;
}

/** A crossing's text with the name its tag wears (`` `[Matias via sonar]` ``) replaced by
 *  the one a surface knows the person by — unchanged when the tag is not the one said. */
export function retag(text: string, tagged: string, name: string): string {
  const open = `\`[${tagged} `;
  return text.startsWith(open) ? `\`[${name} ${text.slice(open.length)}` : text;
}

/** Who a crossing names, for a dispatcher to say its own way: the email and the tag's name,
 *  both present or nothing. */
export function taggedOf(e: Event): { email: string; tagged: string } | undefined {
  const email = e.extra?.[SENDER_EMAIL];
  const tagged = e.extra?.[SENDER_NAME];
  return typeof email === "string" && typeof tagged === "string" ? { email, tagged } : undefined;
}
