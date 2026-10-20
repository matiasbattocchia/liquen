import { assertEquals, assertRejects } from "@std/assert";
import { addressGuard, checkRanges, parseIp, Refused } from "./guard.ts";

const dns = (table: Record<string, string[]>) => (name: string) =>
  table[name] ? Promise.resolve(table[name]) : Promise.reject(new Error("NXDOMAIN"));

Deno.test("parseIp: dotted IPv4, and IPv6 in every spelling it takes", () => {
  assertEquals(parseIp("10.0.0.1"), { v: 4, n: 0x0a000001n });
  assertEquals(parseIp("::1"), { v: 6, n: 1n });
  assertEquals(parseIp("[::1]"), { v: 6, n: 1n });
  assertEquals(parseIp("fe80::1%eth0"), { v: 6, n: (0xfe80n << 112n) | 1n });
  assertEquals(parseIp("::ffff:127.0.0.1"), { v: 6, n: (0xffffn << 32n) | 0x7f000001n });
  assertEquals(parseIp("1:2:3:4:5:6:7:8")?.n, 0x00010002000300040005000600070008n);
  for (const bad of ["256.0.0.1", "1.2.3", "example.com", "1::2::3", "1:2:3:4:5:6:7:8:9"]) {
    assertEquals(parseIp(bad), null, bad);
  }
});

Deno.test("guard: loopback, metadata and the rest of the refused set are refused by class", async () => {
  const guard = addressGuard([], dns({}));
  for (
    const [host, what] of [
      ["127.0.0.1", "a loopback"],
      ["[::1]", "a loopback"],
      ["169.254.169.254", "a link-local"],
      ["100.100.100.200", "a cloud metadata"],
      ["::ffff:127.0.0.1", "a loopback"], // the IPv4 an IPv6 address carries is judged too
      ["64:ff9b::a9fe:a9fe", "a link-local"],
      ["0.0.0.0", "an unspecified"],
    ]
  ) {
    await assertRejects(() => guard.pick(host), Refused, `${host} is ${what} address`);
  }
  assertEquals(await guard.pick("93.184.215.14"), "93.184.215.14");
});

Deno.test("guard: a name dials an address that survived, or is refused if none did", async () => {
  const guard = addressGuard(
    ["10.0.0.0/8"],
    dns({
      "mixed.example": ["127.0.0.1", "10.1.2.3", "93.184.215.14"],
      "inside.example": ["10.1.2.3"],
      "home.example": ["::1"],
    }),
  );
  assertEquals(await guard.pick("mixed.example"), "93.184.215.14");
  await assertRejects(
    () => guard.pick("inside.example"),
    Refused,
    "inside.example resolves to a refused (system.egressRefuses) address",
  );
  await assertRejects(() => guard.pick("home.example"), Refused, "resolves to a loopback");
  // a name that resolves nowhere is no refusal: the dial failed
  const err = await assertRejects(() => guard.pick("nowhere.example"), Error);
  assertEquals([err instanceof Refused, (err as Error).message], [
    false,
    "nowhere.example does not resolve",
  ]);
});

Deno.test("checkRanges: addresses and CIDR ranges, nothing else", () => {
  assertEquals(checkRanges(["10.0.0.0/8", "fc00::/7", "192.168.1.5"]), null);
  for (const bad of [["10.0.0.0/33"], ["intranet"], "10.0.0.0/8", [8]]) {
    assertEquals(typeof checkRanges(bad), "string", JSON.stringify(bad));
  }
});
