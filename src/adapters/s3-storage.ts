import { createHash, createHmac } from "node:crypto";
import { resolveStorageKey } from "./local-disk-core.mjs";
import type { ObjectStoragePort } from "./object-storage";

/**
 * S3 object storage (AWS S3 or any S3-compatible service: Wasabi, Backblaze B2, Cloudflare R2, MinIO).
 * No SDK: requests are signed with AWS Signature V4 using node:crypto, so there is no new dependency.
 * - TLS only in production (an http endpoint is refused).
 * - Server-side encryption on every write (AES256 = S3-managed, or aws:kms with an optional key id).
 * - Never overwrites (If-None-Match: *), objects are sent with attachment + nosniff-friendly metadata.
 * - Downloads: get() for the app's own routes, signedUrl() for short-lived direct links (forced attachment).
 */
export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Full origin of an S3-compatible service, e.g. https://s3.wasabisys.com. Empty = AWS. */
  endpoint?: string | undefined;
  /** Path-style addressing (endpoint/bucket/key). Default: virtual-hosted style on AWS, path style with a custom endpoint. */
  forcePathStyle?: boolean | undefined;
  sse?: "AES256" | "aws:kms";
  kmsKeyId?: string | undefined;
  /** Send If-None-Match: * on writes. On by default; turn off for services that reject it. */
  conditionalPut?: boolean;
  /** Test hook. */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

export interface SignedUrlOptions {
  /** 1..3600 seconds. Default 300. */
  ttlSeconds?: number;
  /** Stored content type; forced on the response together with attachment. */
  contentType?: string;
  /** Download file name (ASCII-safe characters only are kept). */
  filename?: string;
}

export interface S3StoragePort extends ObjectStoragePort {
  signedUrl(key: string, opts?: SignedUrlOptions): string;
}

const sha256hex = (d: string | Uint8Array) => createHash("sha256").update(d).digest("hex");
const hmac = (k: Buffer | string, d: string): Buffer => createHmac("sha256", k).update(d).digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p: string) => p.split("/").map(enc).join("/");
const amzDate = (d: Date) => d.toISOString().replace(/[:-]|\.\d{3}/g, "");

export function createS3Storage(cfg: S3Config): S3StoragePort {
  const f = cfg.fetchImpl ?? fetch;
  const now = cfg.now ?? (() => new Date());
  const sse = cfg.sse ?? "AES256";
  const custom = cfg.endpoint ? new URL(cfg.endpoint) : null;
  if (custom && custom.protocol !== "https:" && process.env.NODE_ENV === "production") throw new Error("S3 endpoint must use https in production.");
  const pathStyle = cfg.forcePathStyle ?? custom !== null;
  const host = custom ? (pathStyle ? custom.host : `${cfg.bucket}.${custom.host}`) : (pathStyle ? `s3.${cfg.region}.amazonaws.com` : `${cfg.bucket}.s3.${cfg.region}.amazonaws.com`);
  const scheme = custom ? custom.protocol : "https:";
  const basePath = (key: string) => (pathStyle ? `/${cfg.bucket}/` : "/") + encPath(key);

  const signingKey = (date: string) => {
    const kDate = hmac("AWS4" + cfg.secretAccessKey, date);
    const kRegion = hmac(kDate, cfg.region);
    const kService = hmac(kRegion, "s3");
    return hmac(kService, "aws4_request");
  };
  const scope = (date: string) => `${date}/${cfg.region}/s3/aws4_request`;

  async function request(method: string, key: string, payload: Uint8Array | null, extra: Record<string, string> = {}): Promise<Response> {
    const t = amzDate(now());
    const date = t.slice(0, 8);
    const hash = sha256hex(payload ?? "");
    const headers: Record<string, string> = { host, "x-amz-content-sha256": hash, "x-amz-date": t, ...extra };
    const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
    const lower: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v.trim();
    const canonical = [method, basePath(key), "", names.map(n => `${n}:${lower[n]}\n`).join(""), names.join(";"), hash].join("\n");
    const toSign = ["AWS4-HMAC-SHA256", t, scope(date), sha256hex(canonical)].join("\n");
    const sig = createHmac("sha256", signingKey(date)).update(toSign).digest("hex");
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope(date)}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
    const { host: _h, ...send } = headers;
    return f(`${scheme}//${host}${basePath(key)}`, { method, headers: send, ...(payload ? { body: payload as BodyInit } : {}) });
  }

  return {
    configured: true,
    async put(key, bytes, contentType) {
      resolveStorageKey("/x", key); // key shape check only
      const h: Record<string, string> = {
        "content-type": contentType,
        "content-disposition": "attachment",
        "cache-control": "private, no-store",
        "x-amz-server-side-encryption": sse
      };
      if (sse === "aws:kms" && cfg.kmsKeyId) h["x-amz-server-side-encryption-aws-kms-key-id"] = cfg.kmsKeyId;
      if (cfg.conditionalPut !== false) h["if-none-match"] = "*";
      const r = await request("PUT", key, bytes, h);
      if (!r.ok) throw new Error(`Object storage write failed (${r.status}).`);
      const echoed = r.headers.get("x-amz-server-side-encryption");
      if (echoed && echoed !== sse) throw new Error("Object storage did not apply the requested encryption.");
    },
    async get(key) {
      resolveStorageKey("/x", key);
      const r = await request("GET", key, null);
      if (!r.ok) throw new Error(`Object storage read failed (${r.status}).`);
      return new Uint8Array(await r.arrayBuffer());
    },
    async remove(key) {
      if (!/^id\//.test(key)) throw new Error("Only identity images can be deleted.");
      resolveStorageKey("/x", key);
      const r = await request("DELETE", key, null);
      if (!r.ok && r.status !== 404) throw new Error(`Object storage delete failed (${r.status}).`);
    },
    signedUrl(key, opts = {}) {
      resolveStorageKey("/x", key);
      const ttl = Math.min(3600, Math.max(1, Math.floor(opts.ttlSeconds ?? 300)));
      const t = amzDate(now());
      const date = t.slice(0, 8);
      const safeName = (opts.filename ?? "download").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100) || "download";
      const q: Record<string, string> = {
        "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
        "X-Amz-Credential": `${cfg.accessKeyId}/${scope(date)}`,
        "X-Amz-Date": t,
        "X-Amz-Expires": String(ttl),
        "X-Amz-SignedHeaders": "host",
        "response-content-disposition": `attachment; filename="${safeName}"`,
        "response-cache-control": "private, no-store",
        "response-content-type": opts.contentType ?? "application/octet-stream"
      };
      const qs = Object.keys(q).sort().map(k => `${enc(k)}=${enc(q[k] ?? "")}`).join("&");
      const canonical = ["GET", basePath(key), qs, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
      const toSign = ["AWS4-HMAC-SHA256", t, scope(date), sha256hex(canonical)].join("\n");
      const sig = createHmac("sha256", signingKey(date)).update(toSign).digest("hex");
      return `${scheme}//${host}${basePath(key)}?${qs}&X-Amz-Signature=${sig}`;
    }
  };
}
