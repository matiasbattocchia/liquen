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

import type { DeltaKind, PermissionVerdict } from "./types.ts";

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
    // a card's answer (§9): what was decided and how far it reaches
    verdict: {
      allowed: "allowed",
      refused: "refused",
      lapsed: "lapsed, nobody answered",
      once: "once",
      conversation: "for this conversation",
      connection: "for this connection",
      always: "always",
    },
    checkpoint: "checkpoint written",
    // the send card's rows (§9): the labels a person reads the call under
    card: {
      conversation: "Conversation",
      last: "Last message",
      subject: "Subject",
      react: "Reaction",
      reply: "Reply",
      files: "Attachments",
      location: "Location",
      // what the answered line carried beside its words, `[image]` before the caption
      carried: {
        image: "image",
        audio: "audio",
        video: "video",
        document: "document",
        sticker: "sticker",
        story: "story",
        file: "file",
        location: "location",
      },
    },
    // where a principal's line was typed, and by whom when the surface is someone else's
    via: (where: string, who?: string) => who ? `${who} via ${where}` : `via ${where}`,
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
    verdict: {
      allowed: "aprobado",
      refused: "rechazado",
      lapsed: "venció, nadie respondió",
      once: "una vez",
      conversation: "para esta conversación",
      connection: "para esta conexión",
      always: "siempre",
    },
    checkpoint: "punto de control escrito",
    card: {
      conversation: "Conversación",
      last: "Último mensaje",
      subject: "Asunto",
      react: "Reacción",
      reply: "Respuesta",
      files: "Adjuntos",
      location: "Ubicación",
      carried: {
        image: "imagen",
        audio: "audio",
        video: "video",
        document: "documento",
        sticker: "sticker",
        story: "historia",
        file: "archivo",
        location: "ubicación",
      },
    },
    via: (where: string, who?: string) => who ? `${who} por ${where}` : `por ${where}`,
    presence: { thinking: "agente pensando...", checkpoint: "agente compactando..." },
  },
};
// every tongue says everything English says — a half-written one is a type error
const _whole: Record<keyof typeof TONGUES, Words> = TONGUES;

/** A card's answer in a tongue's words — the REPL's verdict row after its handle, and the
 *  mirror's `[system]` line quoting the card. */
export function verdictSaid(v: PermissionVerdict, w: Words): string {
  if (v.lapsed) return `${w.verdict.lapsed}${v.reason ? ` (${v.reason})` : ""}`;
  const said = v.behavior === "allow" ? w.verdict.allowed : w.verdict.refused;
  return `${said} ${w.verdict[v.scope]}${v.reason ? `: ${v.reason}` : ""}`;
}

/** The tongue a libc locale names — `es_AR.UTF-8` is Spanish; one we don't speak, and no
 *  locale at all, is English. */
export function words(locale?: string | null): Words {
  const tongue = (locale ?? "").split(/[_.@-]/)[0].toLowerCase();
  return (TONGUES as Record<string, Words>)[tongue] ?? TONGUES.en;
}
