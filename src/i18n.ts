/**
 * i18n.ts — the harness's own words to a human, per tongue.
 *
 * The model needs no translating: the prefix states the org's `locale` and it answers in
 * it. What does is the frame the harness draws around the model's voice on a surface (the
 * mirror's tags, the reply hint under a card, the presence line — DESIGN §4). What is NOT
 * here is what must never translate: `/y` and `/n` are commands `parseVerdict` reads, a
 * tool's detail is API surface (names and argument keys), an error quotes upstream, and
 * every model-facing render (§5 stamps) stays English on purpose.
 *
 * The English row is the type: a tongue joins whole or not at all.
 */

import type { DeltaKind } from "./types.ts";

export type Words = typeof TONGUES.en;

const TONGUES = {
  en: {
    agent: "agent",
    tool: "agent tool",
    asks: "agent asks",
    system: "system",
    approve: "approve",
    hint: "reply /y to approve · /n <reason> to refuse · or react 👍 / 👎",
    withdrawn: "withdrawn",
    // the send card's rows (§9): the labels a person reads the call under
    card: {
      conversation: "Conversation",
      last: "Last message",
      reply: "Reply",
      files: "Attachments",
      location: "Location",
    },
    via: (who: string, where: string) => `${who} via ${where}`,
    // the word a presence line carries for each delta (§9): the surface's, not the log's
    presence: { thinking: "agent thinking...", checkpoint: "agent compacting..." } as Record<
      DeltaKind,
      string
    >,
  },
  // one Spanish for every dialect: the hint keeps to the infinitive, which tú and vos share
  es: {
    agent: "agente",
    tool: "agente usa",
    asks: "agente pregunta",
    system: "sistema",
    approve: "aprobar",
    hint: "responder /y para aprobar · /n <motivo> para rechazar · o reaccionar 👍 / 👎",
    withdrawn: "retirado",
    card: {
      conversation: "Conversación",
      last: "Último mensaje",
      reply: "Respuesta",
      files: "Adjuntos",
      location: "Ubicación",
    },
    via: (who: string, where: string) => `${who} por ${where}`,
    presence: { thinking: "agente pensando...", checkpoint: "agente compactando..." },
  },
};
// every tongue says everything English says — a half-written one is a type error
const _whole: Record<keyof typeof TONGUES, Words> = TONGUES;

/** The tongue a libc locale names — `es_AR.UTF-8` is Spanish; one we don't speak, and no
 *  locale at all, is English. */
export function words(locale?: string | null): Words {
  const tongue = (locale ?? "").split(/[_.@-]/)[0].toLowerCase();
  return (TONGUES as Record<string, Words>)[tongue] ?? TONGUES.en;
}
