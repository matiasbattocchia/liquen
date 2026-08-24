/**
 * proxy/ca.ts — the egress proxy's certificate authority (DESIGN §8).
 *
 * The proxy terminates TLS on behalf of every host a tool dials, so it needs a leaf cert
 * for each host, signed by a root the tool trusts. That root is the mu CA: generated once
 * under `<dir>/proxy`, and handed to the child ONLY as `SSL_CERT_FILE` — which REPLACES the
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

/** Open (creating on first use) the CA under `<dir>/proxy`. */
export async function openCA(dir: string): Promise<CA> {
  const root = `${dir}/proxy`;
  await Deno.mkdir(root, { recursive: true });
  const caPath = `${root}/ca.pem`;
  const caKey = `${root}/ca.key`;

  const exists = await Deno.stat(caPath).then(() => true).catch(() => false);
  if (!exists) {
    await sh([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caPath,
      "-days",
      "3650",
      "-subj",
      "/CN=mu proxy CA",
    ]);
    await Deno.chmod(caKey, 0o600);
  }

  const cache = new Map<string, Promise<Leaf>>();

  const mint = async (host: string): Promise<Leaf> => {
    if (!HOST.test(host)) throw new Error(`refusing to mint a leaf for ${JSON.stringify(host)}`);
    const tmp = await Deno.makeTempDir({ dir: root, prefix: "leaf-" });
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
      await sh([
        "x509",
        "-req",
        "-in",
        csrPath,
        "-CA",
        caPath,
        "-CAkey",
        caKey,
        "-CAcreateserial",
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
