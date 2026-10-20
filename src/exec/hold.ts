/**
 * exec/hold.ts — a bubble's first process (exec/bubble.ts), run inside it.
 *
 * It holds the bubble's namespaces open for as long as it lives: every call enters them,
 * and a job a call leaves running stays in them. Its work is the bubble's one way out.
 *
 * It is the bubble's resolver. Every name asked of it gets an address of its own in
 * 127.64.0.0/10, and a listener on each egress port at that address, before the answer
 * leaves; a connection to one is carried to the egress proxy over its socket as
 * `CONNECT name:port`. So a client needs no proxy setting, whatever it speaks over the
 * connection reaches the world through the proxy, and the proxy judges the name. An AAAA
 * question, or any other, is answered empty, and a client falls back to the A record.
 * Nothing is asked of a resolver outside. A name not dialed for long gives its address
 * back once `MAX_NAMES` are held; a client that kept it resolves the name again.
 *
 *   deno run hold.ts <socket> <resolver address> <port,port,…>
 *
 * It prints `ready` once the resolver listens: the bubble is entered only after that.
 */

const [socket, resolver, portList] = Deno.args;
const ports = portList.split(",").map(Number);
/** The names held at once: each holds a listener per port. */
const MAX_NAMES = 4096;
/** How long an answer may be kept by the asker. */
const TTL_S = 300;
/** The first address names are given, 127.64.0.0, and how many there are. */
const BASE = (127 << 24) | (64 << 16);
const SPAN = 1 << 22;

interface Held {
  name: string;
  address: string;
  listeners: Deno.Listener[];
  used: number;
}

const byName = new Map<string, Held>();
let next = 1;

const dotted = (n: number) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");

/** The address `name` dials, its listeners up before it is said. */
function hold(name: string): Held {
  let held = byName.get(name);
  if (held) {
    held.used = Date.now();
    return held;
  }
  if (byName.size >= MAX_NAMES) {
    const [oldest] = [...byName.values()].sort((a, b) => a.used - b.used);
    for (const l of oldest.listeners) l.close();
    byName.delete(oldest.name);
  }
  let address: string;
  do {
    address = dotted(BASE + next);
    next = next % (SPAN - 2) + 1;
  } while ([...byName.values()].some((h) => h.address === address));
  held = { name, address, listeners: [], used: Date.now() };
  for (const port of ports) {
    const listener = Deno.listen({ hostname: address, port });
    held.listeners.push(listener);
    void carry(listener, name, port);
  }
  byName.set(name, held);
  return held;
}

async function carry(listener: Deno.Listener, name: string, port: number): Promise<void> {
  try {
    for await (const conn of listener) void tunnel(conn, `${name}:${port}`);
  } catch { /* closed: the name gave its address back */ }
}

/** One connection, carried to the proxy as a CONNECT. A refusal reaches the client as the
 *  proxy said it, which a plain HTTP client prints, and is said here too. */
async function tunnel(conn: Deno.Conn, authority: string): Promise<void> {
  let up: Deno.Conn;
  try {
    up = await Deno.connect({ transport: "unix", path: socket });
  } catch (err) {
    console.error(`no way to the egress proxy: ${err instanceof Error ? err.message : err}`);
    return conn.close();
  }
  try {
    await write(up, new TextEncoder().encode(`CONNECT ${authority} HTTP/1.1\r\n\r\n`));
    const head = await readHead(up);
    const status = /^HTTP\/1\.1 (\d{3}) ?(.*)\r\n/.exec(new TextDecoder().decode(head.bytes));
    const open = status?.[1] === "200";
    if (!open) {
      console.error(`${authority}: ${status ? `${status[1]} ${status[2]}` : "no answer"}`);
      await write(conn, head.bytes);
    }
    if (head.rest.length) await write(conn, head.rest);
    if (!open) {
      await up.readable.pipeTo(conn.writable).catch(() => {});
      return;
    }
  } catch {
    conn.close();
    up.close();
    return;
  }
  await Promise.all([
    conn.readable.pipeTo(up.writable).catch(() => {}),
    up.readable.pipeTo(conn.writable).catch(() => {}),
  ]);
}

async function write(conn: Deno.Conn, bytes: Uint8Array): Promise<void> {
  for (let off = 0; off < bytes.length;) off += await conn.write(bytes.subarray(off));
}

/** The proxy's answer to the CONNECT: its head, and what came past it. */
async function readHead(conn: Deno.Conn): Promise<{ bytes: Uint8Array; rest: Uint8Array }> {
  const buf = new Uint8Array(4096);
  let n = 0;
  while (n < buf.length) {
    const read = await conn.read(buf.subarray(n));
    if (read === null) break;
    n += read;
    const text = new TextDecoder().decode(buf.subarray(0, n));
    const end = text.indexOf("\r\n\r\n");
    if (end >= 0) return { bytes: buf.slice(0, end + 4), rest: buf.slice(end + 4, n) };
  }
  return { bytes: buf.slice(0, n), rest: new Uint8Array() };
}

/** The answer to one DNS query, or null for bytes that are none. */
function answer(query: Uint8Array): Uint8Array | null {
  if (query.length < 12) return null;
  const view = new DataView(query.buffer, query.byteOffset, query.byteLength);
  const flags = view.getUint16(2);
  const questions = view.getUint16(4);
  const labels: string[] = [];
  let at = 12;
  while (at < query.length && query[at] !== 0) {
    const len = query[at];
    if (len > 63 || at + 1 + len > query.length) return null;
    labels.push(new TextDecoder().decode(query.subarray(at + 1, at + 1 + len)));
    at += 1 + len;
  }
  if (at + 5 > query.length) return null;
  const type = view.getUint16(at + 1);
  const question = query.subarray(12, at + 5);
  const opcode = (flags >> 11) & 15;
  const name = labels.join(".").toLowerCase();
  // standard query, one question, an A record asked of IN: a name of our own; anything
  // else is answered with nothing (NOTIMP for what is not a standard query)
  const a = opcode === 0 && questions === 1 && type === 1 && view.getUint16(at + 3) === 1 &&
    name !== "";
  const address = !a
    ? null
    : name === "localhost" || name.endsWith(".localhost")
    ? "127.0.0.1"
    : hold(name).address;
  const out = new Uint8Array(12 + question.length + (address ? 16 : 0));
  const o = new DataView(out.buffer);
  o.setUint16(0, view.getUint16(0));
  o.setUint16(2, 0x8080 | (flags & 0x7900) | (opcode === 0 ? 0 : 4));
  o.setUint16(4, 1);
  o.setUint16(6, address ? 1 : 0);
  out.set(question, 12);
  if (address) {
    const r = 12 + question.length;
    o.setUint16(r, 0xc00c); // the question's name
    o.setUint16(r + 2, 1); // A
    o.setUint16(r + 4, 1); // IN
    o.setUint32(r + 6, TTL_S);
    o.setUint16(r + 10, 4);
    out.set(address.split(".").map(Number), r + 12);
  }
  return out;
}

const udp = Deno.listenDatagram({ transport: "udp", hostname: resolver, port: 53 });
const tcp = Deno.listen({ hostname: resolver, port: 53 });
console.log("ready");

void (async () => {
  for await (const [query, from] of udp) {
    try {
      const reply = answer(query);
      if (reply) await udp.send(reply, from);
    } catch (err) {
      console.error(`a query went unanswered: ${err instanceof Error ? err.message : err}`);
    }
  }
})();

// DNS over TCP: each message behind its two-byte length
for await (const conn of tcp) {
  void (async () => {
    try {
      const buf = new Uint8Array(65_537);
      let n = 0;
      while (true) {
        const read = await conn.read(buf.subarray(n));
        if (read === null) break;
        n += read;
        while (n >= 2 && n >= 2 + ((buf[0] << 8) | buf[1])) {
          const len = (buf[0] << 8) | buf[1];
          const reply = answer(buf.slice(2, 2 + len));
          buf.copyWithin(0, 2 + len, n);
          n -= 2 + len;
          if (!reply) continue;
          const framed = new Uint8Array(2 + reply.length);
          framed.set([reply.length >> 8, reply.length & 255]);
          framed.set(reply, 2);
          await write(conn, framed);
        }
      }
    } catch { /* the asker went away */ }
    try {
      conn.close();
    } catch { /* already closed */ }
  })();
}
