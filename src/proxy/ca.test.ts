import { assert, assertEquals, assertRejects } from "@std/assert";
import { openCA } from "./ca.ts";

async function verify(caPath: string, certPem: string): Promise<{ ok: boolean; text: string }> {
  const tmp = await Deno.makeTempDir();
  const leaf = `${tmp}/leaf.crt`;
  await Deno.writeTextFile(leaf, certPem);
  const out = await new Deno.Command("openssl", {
    args: ["verify", "-CAfile", caPath, leaf],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) + new TextDecoder().decode(out.stderr);
  await Deno.remove(tmp, { recursive: true });
  return { ok: out.success, text };
}

/** The cert's human-readable dump (for SAN inspection). */
async function certText(certPem: string): Promise<string> {
  const tmp = await Deno.makeTempDir();
  const leaf = `${tmp}/leaf.crt`;
  await Deno.writeTextFile(leaf, certPem);
  const out = await new Deno.Command("openssl", {
    args: ["x509", "-in", leaf, "-noout", "-text"],
    stdout: "piped",
    stderr: "null",
  }).output();
  await Deno.remove(tmp, { recursive: true });
  return new TextDecoder().decode(out.stdout);
}

Deno.test("openCA: mints a leaf that verifies against the CA and names the host", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ca = await openCA();
    const leaf = await ca.leafFor("www.googleapis.com");
    assert(leaf.cert.includes("BEGIN CERTIFICATE"));
    assert(leaf.key.includes("PRIVATE KEY"));
    const v = await verify(ca.caPath, leaf.cert);
    assert(v.ok, `chain should verify: ${v.text}`);
    // the SAN carries the host — the client checks it against the tunnel target
    const text = await certText(leaf.cert);
    assert(text.includes("DNS:www.googleapis.com"), "SAN must name the host");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("openCA: the CA persists — reopening reuses the same root", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const first = await openCA();
    const caPem = await Deno.readTextFile(first.caPath);
    const second = await openCA();
    assertEquals(await Deno.readTextFile(second.caPath), caPem); // not regenerated
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("openCA: the same host is minted once (cached)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ca = await openCA();
    const [a, b] = await Promise.all([
      ca.leafFor("x.googleapis.com"),
      ca.leafFor("x.googleapis.com"),
    ]);
    assertEquals(a.cert, b.cert); // one mint, shared
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("openCA: a bogus host is refused, not shelled out", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const ca = await openCA();
    await assertRejects(() => ca.leafFor("evil/../$(whoami)"), Error, "refusing");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
