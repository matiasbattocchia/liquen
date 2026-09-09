/**
 * proxy/ca.ts — the egress proxy's certificate authority (DESIGN §9).
 *
 * The proxy terminates TLS on behalf of every host a tool dials, so it needs a leaf cert
 * for each host, signed by a root the tool trusts. That root is the liquen CA: shipped with
 * the package, laid under the data root at boot, and handed to the child ONLY as
 * `SSL_CERT_FILE` — which REPLACES the
 * system trust store (verified: gws then rejects Google's real cert as UnknownIssuer). So
 * the CA is not "one more issuer the tool trusts"; inside user space it is the ONLY one, and
 * a tool physically cannot reach any host the proxy doesn't front. The CA private key never
 * leaves the broker side (mode 600, never issued into an env).
 *
 * Leaves are minted lazily per host and cached — a handful over a process's life (the Google
 * REST hosts). openssl does the X.509 work: no pure-JS cert builder, no third-party dep.
 */

const HOST = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i;

export interface Leaf {
  cert: string; // PEM
  key: string; // PEM
}

export interface CA {
  /** The CA cert path — this is what rides into the child as `SSL_CERT_FILE`. */
  caPath: string;
  /** A leaf for `host`, signed by the CA (cached; SAN = the host). */
  leafFor(host: string): Promise<Leaf>;
}

async function sh(args: string[]): Promise<void> {
  const out = await new Deno.Command("openssl", { args, stdout: "null", stderr: "piped" }).output();
  if (!out.success) {
    throw new Error(`openssl ${args[0]} failed: ${new TextDecoder().decode(out.stderr).trim()}`);
  }
}

/** Open the CA — SHIPPED with the package (`src/proxy/ca.pem` + `ca.key`), not minted per
 *  install, and laid under the data root's `system/` at boot, write-if-absent: openssl
 *  signs against files and `SSL_CERT_FILE` names one, wherever the package itself is (a
 *  checkout's files, the registry's URLs). It is plumbing, not a credential: nothing
 *  trusts it except the children we hand `SSL_CERT_FILE`, so its whole job is making a
 *  tool dial our proxy instead of the host. */
export async function openCA(dir: string): Promise<CA> {
  const caPath = `${dir}/system/ca.pem`;
  const caKey = `${dir}/system/ca.key`;
  await Deno.mkdir(`${dir}/system`, { recursive: true });
  for (
    const [path, shipped, mode] of [[caPath, "ca.pem", 0o644], [caKey, "ca.key", 0o600]] as const
  ) {
    const exists = await Deno.stat(path).then(() => true).catch(() => false);
    if (exists) continue;
    const res = await fetch(new URL(`./${shipped}`, import.meta.url));
    await Deno.writeTextFile(path, await res.text(), { mode });
  }

  const cache = new Map<string, Promise<Leaf>>();

  const mint = async (host: string): Promise<Leaf> => {
    if (!HOST.test(host)) throw new Error(`refusing to mint a leaf for ${JSON.stringify(host)}`);
    // scratch for openssl's hand-off between key, csr and cert; the leaf lives in memory
    const tmp = await Deno.makeTempDir({ prefix: "liquen-leaf-" });
    try {
      const keyPath = `${tmp}/leaf.key`;
      const csrPath = `${tmp}/leaf.csr`;
      const crtPath = `${tmp}/leaf.crt`;
      const extPath = `${tmp}/ext.cnf`;
      await sh([
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        csrPath,
        "-subj",
        `/CN=${host}`,
      ]);
      await Deno.writeTextFile(
        extPath,
        `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\n` +
          `keyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n`,
      );
      // a random serial per leaf: no shared .srl file, so concurrent mints never race
      const serial = "0x" + Array.from(
        crypto.getRandomValues(new Uint8Array(16)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      await sh([
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        caPath,
        "-CAkey",
        caKey,
        "-set_serial",
        serial,
        "-out",
        crtPath,
        "-days",
        "825",
        "-extfile",
        extPath,
      ]);
      return {
        cert: await Deno.readTextFile(crtPath),
        key: await Deno.readTextFile(keyPath),
      };
    } finally {
      await Deno.remove(tmp, { recursive: true }).catch(() => {});
    }
  };

  return {
    caPath,
    leafFor(host: string): Promise<Leaf> {
      let p = cache.get(host);
      if (!p) {
        p = mint(host);
        cache.set(host, p);
        // a mint that throws must not poison the cache
        p.catch(() => cache.delete(host));
      }
      return p;
    },
  };
}
