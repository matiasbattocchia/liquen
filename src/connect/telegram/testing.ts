/**
 * connect/telegram/testing.ts — a wire made of literals, for the folder's tests: every
 * call recorded, each answer scripted.
 */

import type { TgMessage, TgOutbound, TgPeer, TgWire } from "./wire.ts";

export const SELF: TgPeer = { id: "700100", kind: "user", name: "Ana Paz", username: "anapaz" };
export const SOL: TgPeer = { id: "700200", kind: "user", name: "Sol Ruiz", username: "solruiz" };
export const TEAM: TgPeer = { id: "-4100", kind: "group", name: "Equipo" };
export const FORUM: TgPeer = { id: "-1009000", kind: "supergroup", name: "Obra" };

/** A message as the session says it, text from Sol in her direct chat unless told. */
export function message(over: Partial<TgMessage> = {}): TgMessage {
  return {
    id: 41,
    chat: SOL,
    sender: SOL,
    out: false,
    date: "2026-11-13T15:00:00.000Z",
    text: "hola",
    entities: [],
    ...over,
  };
}

export interface FakeWire extends TgWire {
  calls: { op: string; args: unknown[] }[];
}

/** A wire whose every leg records its call. `over` scripts the answers that matter. */
export function fakeWire(over: Partial<TgWire> = {}): FakeWire {
  const calls: FakeWire["calls"] = [];
  let next = 500;
  const noted =
    <A extends unknown[], R>(op: string, answer: (...args: A) => R) =>
    (...args: A): Promise<Awaited<R>> => {
      calls.push({ op, args });
      return Promise.resolve(answer(...args)) as Promise<Awaited<R>>;
    };
  const people: Record<string, TgPeer> = {
    [SOL.id]: SOL,
    "@solruiz": SOL,
    [TEAM.id]: TEAM,
    [FORUM.id]: FORUM,
  };
  const base: TgWire = {
    self: SELF,
    send: noted("send", (chat: string, _out: TgOutbound) => ({
      id: ++next,
      chat: people[chat] ?? { id: chat, kind: "user" as const },
    })),
    edit: noted("edit", () => undefined),
    delete: noted("delete", () => undefined),
    react: noted("react", () => undefined),
    resolve: noted("resolve", (handle: string) => people[handle] ?? null),
    about: noted("about", () => "Arquitecta. Obras en Mendoza."),
    contacts: noted("contacts", () => [{ ...SOL, contact: true, phone: "5492615550107" }]),
    saveContact: noted(
      "saveContact",
      (user: string, name?: string) => ({
        ...SOL,
        id: user,
        name: name ?? SOL.name,
        contact: true,
      }),
    ),
    dropContact: noted("dropContact", () => undefined),
    createRoom: noted("createRoom", (title: string) => ({
      id: "-4200",
      kind: "group" as const,
      name: title,
    })),
    members: noted("members", () => [SELF, SOL]),
    join: noted("join", () => undefined),
    leave: noted("leave", () => undefined),
    add: noted("add", () => undefined),
    remove: noted("remove", () => undefined),
    rename: noted("rename", () => undefined),
    history: noted("history", () => [] as TgMessage[]),
  };
  const wire = { ...base, calls } as FakeWire;
  for (const [op, fn] of Object.entries(over)) {
    if (typeof fn !== "function") {
      (wire as unknown as Record<string, unknown>)[op] = fn;
      continue;
    }
    (wire as unknown as Record<string, unknown>)[op] = (...args: unknown[]) => {
      calls.push({ op, args });
      return (fn as (...a: unknown[]) => unknown)(...args);
    };
  }
  return wire;
}
