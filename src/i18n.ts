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

const times = (n: number) => n === 1 ? "tried once" : `tried ${n} times`;
const veces = (n: number) => n === 1 ? "lo intenté una vez" : `lo intenté ${n} veces`;

const TONGUES = {
  en: {
    agent: "agent",
    tool: "agent tool",
    asks: "agent asks",
    system: "system",
    // an unload's label (§5): the turn that writes down a span before a checkpoint folds it
    unload: "agent memorizing...",
    // a call below `tools` (§9): the call's line, unnamed
    working: "agent working...",
    approve: "approve",
    hint:
      "reply /y to approve · /n <reason> to refuse · or react 👍 / 👎 · 🤖 approves the whole conversation",
    // the send card's rows (§9): the labels a person reads the call under
    card: {
      conversation: "Conversation",
      last: "Last message",
      message: "Message",
      toEdit: "Message to edit",
      toDelete: "Message to delete",
      subject: "Subject",
      react: "Reaction",
      unreact: "Remove reaction",
      reply: "Reply",
      newText: "New text",
      files: "Attachments",
      location: "Location",
      contacts: "Contacts",
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
        contact: "contact",
      },
    },
    // where a principal's line was typed, and by whom when the surface is someone else's
    via: (where: string, who?: string) => who ? `${who} via ${where}` : `via ${where}`,
    // the word a presence line carries for each delta (§9): the surface's, not the log's
    presence: {
      thinking: "agent thinking...",
      checkpoint: "agent compacting...",
    } as Record<
      DeltaKind,
      string
    >,
    // why an answer settled no card (`Refusal`); `/y` and the scope words stay commands
    refusal: {
      notVerdict: "not a verdict — /y[once|conv|conn|always|all] [handle] [reason]",
      noCard: (handle: string) => `no card ${handle} is waiting`,
      answered: (waiting: number) =>
        waiting === 0
          ? "that approval was already answered"
          : `that approval was already answered — ${waiting} still waiting, /y answers the newest`,
      noneWaiting: "no approval is waiting",
    },
    // a model call that failed past its retries, by what kept it (`CallFailure`): unreached
    // (no status), busy (weather the retries covered), refused (the request's own fault).
    // The provider's words close the line as they came
    failed: {
      unreached: (tries: number, said: string) =>
        `I couldn't reach the model: ${
          times(tries)
        }. I'll pick up again with the next message. (${said})`,
      busy: (status: number, tries: number, said: string) =>
        `The model is overloaded (${status}): ${
          times(tries)
        }. I'll pick up again with the next message. (${said})`,
      refused: (status: number, said: string) =>
        `The model refused the request (${status}): ${said}`,
    },
  },
  // one Spanish for every dialect: the hint keeps to the infinitive, which tú and vos share
  es: {
    agent: "agente",
    tool: "agente usa",
    asks: "agente pregunta",
    system: "sistema",
    unload: "agente memorizando...",
    working: "agente trabajando...",
    approve: "aprobar",
    hint:
      "responder /y para aprobar · /n <motivo> para rechazar · o reaccionar 👍 / 👎 · 🤖 aprueba toda la conversación",
    card: {
      conversation: "Conversación",
      last: "Último mensaje",
      message: "Mensaje",
      toEdit: "Mensaje a editar",
      toDelete: "Mensaje a borrar",
      subject: "Asunto",
      react: "Reacción",
      unreact: "Quitar reacción",
      reply: "Respuesta",
      newText: "Texto nuevo",
      files: "Adjuntos",
      location: "Ubicación",
      contacts: "Contactos",
      carried: {
        image: "imagen",
        audio: "audio",
        video: "video",
        document: "documento",
        sticker: "sticker",
        story: "historia",
        file: "archivo",
        location: "ubicación",
        contact: "contacto",
      },
    },
    via: (where: string, who?: string) => who ? `${who} por ${where}` : `por ${where}`,
    presence: {
      thinking: "agente pensando...",
      checkpoint: "agente compactando...",
    },
    refusal: {
      notVerdict: "eso no es una respuesta — /y[once|conv|conn|always|all] [tarjeta] [motivo]",
      noCard: (handle: string) => `ninguna tarjeta ${handle} está esperando`,
      answered: (waiting: number) =>
        waiting === 0
          ? "esa aprobación ya fue respondida"
          : `esa aprobación ya fue respondida — ${
            waiting === 1 ? "queda 1 esperando" : `quedan ${waiting} esperando`
          }, /y responde la más reciente`,
      noneWaiting: "no hay ninguna aprobación esperando",
    },
    failed: {
      unreached: (tries: number, said: string) =>
        `No pude conectarme con el modelo: ${
          veces(tries)
        }. Retomo con el próximo mensaje. (${said})`,
      busy: (status: number, tries: number, said: string) =>
        `El modelo está saturado (${status}): ${
          veces(tries)
        }. Retomo con el próximo mensaje. (${said})`,
      refused: (status: number, said: string) => `El modelo rechazó el pedido (${status}): ${said}`,
    },
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
