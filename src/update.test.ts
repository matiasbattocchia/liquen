import { assertEquals } from "@std/assert";
import { linked, PACKAGE, pinned } from "./update.ts";

Deno.test("pinned: the exact version the org's lock resolved the harness to", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    Deno.writeTextFileSync(
      `${tmp}/deno.lock`,
      JSON.stringify({
        version: "5",
        specifiers: { "jsr:@std/jsonc@1": "1.0.2", [`jsr:${PACKAGE}@0.1`]: "0.1.32" },
      }),
    );
    assertEquals(pinned(tmp), "0.1.32");
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("pinned: an org with no lock, or a lock without us, pins nothing", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    assertEquals(pinned(tmp), null);
    Deno.writeTextFileSync(`${tmp}/deno.lock`, JSON.stringify({ version: "5" }));
    assertEquals(pinned(tmp), null);
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});

Deno.test("linked: a checkout standing in for the registry is the org's version, and is said so", () => {
  const tmp = Deno.makeTempDirSync();
  try {
    const org = `${tmp}/org`, checkout = `${tmp}/liquen`;
    Deno.mkdirSync(org), Deno.mkdirSync(checkout);
    Deno.writeTextFileSync(`${checkout}/deno.json`, JSON.stringify({ name: PACKAGE }));
    Deno.writeTextFileSync(`${org}/deno.jsonc`, `{ // the org\n  "links": ["../liquen"]\n}`);
    assertEquals(linked(org), `${org}/../liquen`);
    Deno.writeTextFileSync(`${org}/deno.jsonc`, `{ "links": [${JSON.stringify(checkout)}] }`);
    assertEquals(linked(org), checkout); // absolute links are taken as they are
    Deno.writeTextFileSync(`${org}/deno.jsonc`, `{ "links": ["../elsewhere"] }`);
    assertEquals(linked(org), null); // a link to something that is not the harness is not ours
    Deno.writeTextFileSync(`${org}/deno.jsonc`, `{ "imports": {} }`);
    assertEquals(linked(org), null); // the shape every deployed org has
  } finally {
    Deno.removeSync(tmp, { recursive: true });
  }
});
