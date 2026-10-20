/**
 * exec/hold.ts — a bubble's first process (exec/bubble.ts), run inside it.
 *
 * It holds the bubble's namespaces open for as long as it lives: every call enters them,
 * and a job a call leaves running stays in them. Its work is the bubble's one way out — the
 * loopback port `HTTPS_PROXY` names, carried over the unix socket the egress proxy also
 * accepts on — so a shell whose network is its own loopback reaches the proxy and nothing
 * else.
 *
 *   deno run hold.ts <socket> <port>
 *
 * It prints `ready` once the port listens: the bubble is entered only after that.
 */

const [socket, port] = Deno.args;
const listener = Deno.listen({ hostname: "127.0.0.1", port: Number(port) });
console.log("ready");
for await (const conn of listener) {
  Deno.connect({ transport: "unix", path: socket })
    .then((up) =>
      Promise.all([
        conn.readable.pipeTo(up.writable).catch(() => {}),
        up.readable.pipeTo(conn.writable).catch(() => {}),
      ])
    )
    .catch((err) => {
      console.error(`no way to the egress proxy: ${err instanceof Error ? err.message : err}`);
      try {
        conn.close();
      } catch { /* already closed */ }
    });
}
