import { assertEquals } from "@std/assert";
import { claimMentions, resolveMentions } from "./mentions.ts";

// a swimming group as the log and the roster know it: one address can go by two names
const GROUP = [
  { address: "5492616000001", name: "Cristina Natación" },
  { address: "5492615406773", name: "Diego" },
  { address: "5492615123222", name: "Diego Zeta" },
  { address: "5492615438698", name: "Facundo Díaz Araujo" },
  { address: "5492616534310", name: "Pablo Las Heras" },
  { address: "5492616534310", name: "Pablo" },
  { address: "5492615550110", name: "Ana María López" },
  { address: "5492617000002", name: "Isabel (Mamá de Ana María)" },
  { address: "5492617000003" },
];

Deno.test("resolve: a first name that one person wears is their mention, spelled as typed", () => {
  const r = resolveMentions("Buen día @Cristina! ¿Estoy a tiempo?", GROUP);
  assertEquals(r.unresolved, []);
  assertEquals(r.mentions, [{ address: "5492616000001", name: "Cristina" }]);
});

Deno.test("resolve: the token takes the words that still name somebody, accents and case folded", () => {
  const r = resolveMentions("@facundo diaz te paso la lista, y @Ana María también", GROUP);
  assertEquals(r.unresolved, []);
  assertEquals(r.mentions, [
    { address: "5492615438698", name: "facundo diaz" },
    { address: "5492615550110", name: "Ana María" },
  ]);
});

Deno.test("resolve: a name several people wear refuses with all of them; more words settle it", () => {
  const r = resolveMentions("@Diego, ¿venís?", GROUP);
  assertEquals(r.mentions, []);
  assertEquals(r.unresolved, [{
    token: "@Diego",
    many: true,
    candidates: [
      { address: "5492615406773", name: "Diego" },
      { address: "5492615123222", name: "Diego Zeta" },
    ],
  }]);
  assertEquals(resolveMentions("@Diego Zeta, ¿venís?", GROUP).mentions, [
    { address: "5492615123222", name: "Diego Zeta" },
  ]);
});

Deno.test("resolve: an address is always precise, and one person under two names is one", () => {
  const r = resolveMentions("@5492615406773 y @Pablo, ¿vienen?", GROUP);
  assertEquals(r.unresolved, []);
  assertEquals(r.mentions, [
    { address: "5492615406773", name: "5492615406773" },
    { address: "5492616534310", name: "Pablo" },
  ]);
});

Deno.test("resolve: a relation in a parenthesis names somebody else", () => {
  // "Ana María" is in Isabel's book name, but only as whose mother she is
  assertEquals(resolveMentions("@Ana María", GROUP).mentions, [
    { address: "5492615550110", name: "Ana María" },
  ]);
});

Deno.test("resolve: nobody by that name refuses, offering the near names, else everyone", () => {
  const near = resolveMentions("hola @Cristian", GROUP).unresolved;
  assertEquals(near, [{
    token: "@Cristian",
    many: false,
    candidates: [{ address: "5492616000001", name: "Cristina Natación" }],
  }]);
  const none = resolveMentions("hola @Zulema", GROUP).unresolved[0];
  assertEquals(none.candidates.length, 7); // one per named address
});

Deno.test("resolve: a sigil that opens no token is spelling — mail, paths, code, a lone @", () => {
  const text = "foo@bar.com, https://medium.com/@cristina, `@Diego`, nos vemos @ 5 y (@Cristina)";
  const r = resolveMentions(text, GROUP);
  assertEquals(r.unresolved, []);
  assertEquals(r.mentions, [{ address: "5492616000001", name: "Cristina" }]);
});

Deno.test("resolve: a handle is no name; the wire's own handles go as written", () => {
  const r = resolveMentions("seguinos en @liquen.dev o @matias_b", GROUP);
  assertEquals(r.unresolved.map((u) => u.token), ["@liquen.dev", "@matias_b"]);
  const tg = resolveMentions("escribile a @matias_b", GROUP, {
    native: (h) => /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(h),
  });
  assertEquals(tg, { mentions: [], unresolved: [] });
});

Deno.test("resolve: a known #channel is claimed; any other # is a hashtag and stays text", () => {
  const r = resolveMentions("avisá en #general, #viernes", [], {
    channels: [{ address: "C061EG9T25", name: "general", type: "#" }],
  });
  assertEquals(r, {
    mentions: [{ address: "C061EG9T25", name: "general", type: "#" }],
    unresolved: [],
  });
});

Deno.test("claim: the resolved spelling is found where the send found it, sentence marks and all", () => {
  const said = [{ address: "5492616000001", name: "Cristina" }];
  const c = claimMentions("Gracias @Cristina. Y @cristina, otra vez", said);
  assertEquals(c.map((x) => [x.index, x.length]), [[8, 9], [21, 9]]);
  // inside a word, a path or code it is not the token
  assertEquals(claimMentions("x@Cristina /@Cristina `@Cristina`", said), []);
});

Deno.test("claim: longest first, so a longer name is never half-claimed", () => {
  const said = [
    { address: "1", name: "Ana" },
    { address: "2", name: "Ana María" },
  ];
  assertEquals(
    claimMentions("@Ana María y @Ana", said).map((c) => [c.address, c.length]),
    [["2", 10], ["1", 4]],
  );
});
