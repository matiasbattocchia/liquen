/**
 * proxy/guard.ts — where the egress proxy may dial (DESIGN §9).
 *
 * A name is only as good as what it resolves to: whoever runs a name's DNS can point it at
 * this machine's loopback, its LAN address or a cloud's metadata endpoint, and the proxy
 * dials from this machine. So a dial resolves the name once, here, drops every address in
 * the refused set, and dials one that survives: the address judged is the address dialed.
 *
 * The refused set is loopback, unspecified, link-local, multicast and broadcast space, the
 * cloud metadata endpoints outside link-local, every address this machine's interfaces
 * hold as the dial is made, and what `system.egressRefuses` adds. An IPv6 address that
 * carries an IPv4 one (mapped, compatible, NAT64, 6to4) is judged by the IPv4 it carries
 * as well.
 */

import { lookup as dnsLookup } from "node:dns/promises";

/** A dial the guard refuses; the message is the reason, said to the client. */
export class Refused extends Error {}

export interface Guard {
  /** The address to dial for `hostname` (a name or a literal), or a `Refused`. */
  pick(hostname: string): Promise<string>;
}

interface Ip {
  v: 4 | 6;
  n: bigint;
}

interface Range {
  v: 4 | 6;
  n: bigint;
  bits: number;
  what: string;
}

const BUILT_IN: [string, string][] = [
  ["127.0.0.0/8", "a loopback"],
  ["::1/128", "a loopback"],
  ["0.0.0.0/8", "an unspecified"],
  ["::/128", "an unspecified"],
  ["169.254.0.0/16", "a link-local"],
  ["fe80::/10", "a link-local"],
  ["224.0.0.0/4", "a multicast"],
  ["ff00::/8", "a multicast"],
  ["255.255.255.255/32", "a broadcast"],
  ["100.100.100.200/32", "a cloud metadata"],
  ["168.63.129.16/32", "a cloud metadata"],
  ["192.0.0.192/32", "a cloud metadata"],
  ["fd00:ec2::/32", "a cloud metadata"],
  ["fd20:ce::254/128", "a cloud metadata"],
  ["fd00:c1::a9fe:a9fe/128", "a cloud metadata"],
  ["fd00:42::42/128", "a cloud metadata"],
];

/** A literal address, or null: dotted IPv4, or IPv6 with `::`, an IPv4 tail, brackets or a
 *  zone. */
export function parseIp(text: string): Ip | null {
  const s = text.replace(/^\[(.*)\]$/, "$1").replace(/%.*$/, "");
  const v4 = (t: string): bigint | null => {
    const parts = t.split(".");
    if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) < 256)) {
      return null;
    }
    return parts.reduce((n, p) => (n << 8n) | BigInt(p), 0n);
  };
  if (!s.includes(":")) {
    const n = v4(s);
    return n === null ? null : { v: 4, n };
  }
  let head = s;
  let tail: bigint[] = [];
  const dotted = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const n = v4(dotted[2]);
    if (n === null) return null;
    head = dotted[1].endsWith("::") ? dotted[1] : dotted[1].slice(0, -1);
    tail = [n >> 16n, n & 0xffffn];
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const groups = (h: string) => (h === "" ? [] : h.split(":"));
  const left = groups(halves[0]);
  const right = halves.length === 2 ? groups(halves[1]) : [];
  if (![...left, ...right].every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
  const known = left.length + right.length + tail.length;
  if (halves.length === 1 ? known !== 8 : known > 7) return null;
  const words = [
    ...left.map((g) => BigInt(`0x${g}`)),
    ...Array(8 - known).fill(0n),
    ...right.map((g) => BigInt(`0x${g}`)),
    ...tail,
  ];
  return { v: 6, n: words.reduce((n, w) => (n << 16n) | w, 0n) };
}

/** `address/bits`, or a bare address (all its bits). */
function parseRange(text: string, what: string): Range | null {
  const [addr, bits, more] = text.split("/");
  if (more !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const width = ip.v === 4 ? 32 : 128;
  const b = bits === undefined ? width : /^\d{1,3}$/.test(bits) ? Number(bits) : NaN;
  if (!(b >= 0 && b <= width)) return null;
  return { ...ip, bits: b, what };
}

function within(ip: Ip, r: Range): boolean {
  if (ip.v !== r.v) return false;
  const shift = BigInt((ip.v === 4 ? 32 : 128) - r.bits);
  return ip.n >> shift === r.n >> shift;
}

/** The IPv4 address an IPv6 one carries, if it carries one. */
function carried(ip: Ip): Ip | null {
  if (ip.v !== 6) return null;
  const low = ip.n & 0xffffffffn;
  if (ip.n >> 32n === 0xffffn) return { v: 4, n: low }; // ::ffff:0:0/96, mapped
  if (ip.n >> 32n === 0n && low > 1n) return { v: 4, n: low }; // ::/96, compatible
  if (ip.n >> 32n === 0x64ff9b0000000000000000n) return { v: 4, n: low }; // 64:ff9b::/96
  if (ip.n >> 112n === 0x2002n) return { v: 4, n: (ip.n >> 80n) & 0xffffffffn }; // 2002::/16
  return null;
}

/** What `system.egressRefuses` may hold: addresses and CIDR ranges. A complaint, or null
 *  when the value is fine. */
export function checkRanges(v: unknown): string | null {
  const shape = 'must be an array of addresses and CIDR ranges ("10.0.0.0/8", "fc00::/7")';
  if (!Array.isArray(v)) return shape;
  const bad = v.find((s) => typeof s !== "string" || !parseRange(s, ""));
  return bad === undefined ? null : `${shape}: ${JSON.stringify(bad)} is neither`;
}

/** Every address the name resolves to, in the resolver's order. */
export type Lookup = (hostname: string) => Promise<string[]>;

const systemLookup: Lookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

/** This machine's own addresses, as its interfaces hold them now. */
function ownAddresses(): Range[] {
  try {
    return Deno.networkInterfaces().flatMap((i) => {
      const r = parseRange(i.address, "this machine's");
      return r ? [r] : [];
    });
  } catch {
    return [];
  }
}

/** The guard over the built-in refused set, this machine's addresses and `extra` (the
 *  `system.egressRefuses` ranges). `lookup` resolves a name; the system resolver, which
 *  reads the hosts file, by default. */
export function addressGuard(extra: string[] = [], lookup: Lookup = systemLookup): Guard {
  const fixed = [
    ...BUILT_IN.map(([r, what]) => parseRange(r, what)!),
    ...extra.map((r) => parseRange(r, "a refused (system.egressRefuses)")!),
  ];
  const judge = (ip: Ip, ranges: Range[]): string | null => {
    const four = carried(ip);
    const hit = ranges.find((r) => within(ip, r) || (four !== null && within(four, r)));
    return hit?.what ?? null;
  };
  return {
    async pick(hostname) {
      const literal = parseIp(hostname);
      let addresses: string[];
      if (literal) {
        addresses = [hostname.replace(/^\[(.*)\]$/, "$1")];
      } else {
        try {
          addresses = await lookup(hostname);
        } catch {
          throw new Error(`${hostname} does not resolve`);
        }
        if (!addresses.length) throw new Error(`${hostname} does not resolve`);
      }
      const ranges = [...fixed, ...ownAddresses()];
      let first: string | null = null;
      for (const address of addresses) {
        const ip = parseIp(address);
        if (!ip) continue;
        const what = judge(ip, ranges);
        if (what === null) return address;
        first ??= what;
      }
      throw new Refused(
        `${hostname} ${literal ? "is" : "resolves to"} ${first ?? "an unreadable"} address`,
      );
    },
  };
}
