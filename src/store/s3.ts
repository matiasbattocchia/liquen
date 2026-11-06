/**
 * store/s3.ts — the object store over the S3 API (§8): R2, S3, Supabase Storage, MinIO —
 * whatever answers it, named by the bucket's URL in `deployment.storage`.
 *
 * The URL is path-style, `https://<endpoint>/<bucket>`, with `?region=` where the service
 * wants one (`auto` otherwise, R2's word). The keys are secrets, so they ride the
 * environment: `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`. Every request is
 * signed with AWS Signature Version 4 over its body's hash, with the runtime's own crypto:
 * no SDK.
 */

import type { Storage } from "./storage.ts";
import { plainKey } from "./storage.ts";

/** Where a bucket is and what opens it. */
export interface S3Address {
  endpoint: string; // `https://host[:port]`
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The address `deployment.storage` names, the keys read from `env`. Throws a sentence when
 *  the URL names no bucket or a key is missing. */
export function s3AddressOf(
  url: string,
  env: (name: string) => string | undefined = (n) => Deno.env.get(n),
): S3Address {
  const u = new URL(url);
  const bucket = u.pathname.split("/").filter(Boolean)[0];
  if (!bucket) {
    throw new Error(`deployment.storage ${url} names no bucket: https://<endpoint>/<bucket>`);
  }
  const accessKeyId = env("STORAGE_ACCESS_KEY_ID") ?? "";
  const secretAccessKey = env("STORAGE_SECRET_ACCESS_KEY") ?? "";
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      `deployment.storage is a bucket (${url}): its keys are STORAGE_ACCESS_KEY_ID and ` +
        "STORAGE_SECRET_ACCESS_KEY in .env",
    );
  }
  return {
    endpoint: u.origin,
    bucket,
    region: u.searchParams.get("region") ?? "auto",
    accessKeyId,
    secretAccessKey,
  };
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = async (data: Uint8Array) =>
  hex(await crypto.subtle.digest("SHA-256", data as BufferSource));
async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** RFC 3986 encoding, as SigV4 canonicalizes: every byte but the unreserved ones, and `/`
 *  kept where a path keeps it. */
function uriEncode(s: string, slash: boolean): string {
  return [...enc.encode(s)].map((b) => {
    const c = String.fromCharCode(b);
    if (/[A-Za-z0-9\-._~]/.test(c) || (slash && c === "/")) return c;
    return `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
  }).join("");
}

/** A request signed with SigV4: the headers to send it with. */
export async function signed(
  at: S3Address,
  method: string,
  path: string,
  query: Record<string, string>,
  body: Uint8Array,
  now = new Date(),
): Promise<{ url: string; headers: Record<string, string> }> {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const host = new URL(at.endpoint).host;
  const payload = await sha256(body);
  const canonicalPath = uriEncode(path, true);
  const canonicalQuery = Object.keys(query).sort()
    .map((k) => `${uriEncode(k, false)}=${uriEncode(query[k], false)}`).join("&");
  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": payload,
    "x-amz-date": amzDate,
  };
  const names = Object.keys(headers).sort();
  const canonical = [
    method,
    canonicalPath,
    canonicalQuery,
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    names.join(";"),
    payload,
  ].join("\n");
  const scope = `${day}/${at.region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256(enc.encode(canonical))].join(
    "\n",
  );
  let key = await hmac(enc.encode(`AWS4${at.secretAccessKey}`), day);
  for (const part of [at.region, "s3", "aws4_request"]) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  const { host: _, ...sent } = headers;
  return {
    url: `${at.endpoint}${canonicalPath}${canonicalQuery ? `?${canonicalQuery}` : ""}`,
    headers: {
      ...sent,
      authorization: `AWS4-HMAC-SHA256 Credential=${at.accessKeyId}/${scope}, ` +
        `SignedHeaders=${names.join(";")}, Signature=${signature}`,
    },
  };
}

/** The S3 backend of the object store. */
export function s3Storage(at: S3Address, fetchApi: typeof fetch = fetch): Storage {
  const pathOf = (key: string) => {
    if (!plainKey(key)) throw new Error(`not a storage key: ${key}`);
    return `/${at.bucket}/${key}`;
  };
  const call = async (
    method: string,
    path: string,
    query: Record<string, string> = {},
    body: Uint8Array = new Uint8Array(),
    extra: Record<string, string> = {},
  ) => {
    const { url, headers } = await signed(at, method, path, query, body);
    return fetchApi(url, {
      method,
      headers: { ...headers, ...extra },
      ...(body.length ? { body: body as BodyInit } : {}),
    });
  };
  const fail = async (what: string, res: Response) => {
    throw new Error(`storage ${what}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  };
  return {
    async put(key, bytes, mime) {
      const res = await call("PUT", pathOf(key), {}, bytes, { "content-type": mime });
      if (!res.ok) await fail(`put ${key}`, res);
      await res.body?.cancel();
    },
    async get(key) {
      const res = await call("GET", pathOf(key));
      if (res.status === 404) {
        await res.body?.cancel();
        return null;
      }
      if (!res.ok) await fail(`get ${key}`, res);
      return new Uint8Array(await res.arrayBuffer());
    },
    async delete(key) {
      const res = await call("DELETE", pathOf(key));
      if (!res.ok && res.status !== 404) await fail(`delete ${key}`, res);
      await res.body?.cancel();
    },
    async *keys(prefix) {
      let token: string | undefined;
      do {
        const query: Record<string, string> = {
          "list-type": "2",
          prefix,
          ...(token ? { "continuation-token": token } : {}),
        };
        const res = await call("GET", `/${at.bucket}`, query);
        if (!res.ok) await fail(`list ${prefix}`, res);
        const xml = await res.text();
        for (const c of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const key = unescapeXml(/<Key>([\s\S]*?)<\/Key>/.exec(c[1])?.[1] ?? "");
          const at = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(c[1])?.[1];
          if (key) yield { key, at: at ? new Date(at) : new Date(0) };
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? unescapeXml(
            /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1] ?? "",
          )
          : undefined;
      } while (token);
    },
  };
}

const unescapeXml = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
