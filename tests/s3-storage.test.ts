import { describe, expect, it } from "vitest";
import { objectStorageFromEnv } from "../src/adapters/object-storage";
import { createS3Storage } from "../src/adapters/s3-storage";

const base = { bucket: "ol-prod", region: "ap-southeast-2", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" };
const fixed = () => new Date("2026-11-05T04:00:00Z");

function fakeS3() {
  const store = new Map<string, Uint8Array>();
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => {
    calls.push({ method: init.method, url, headers: init.headers });
    const key = new URL(url).pathname;
    if (init.method === "PUT") {
      if (init.headers["if-none-match"] === "*" && store.has(key)) return new Response("", { status: 412 });
      store.set(key, init.body!);
      return new Response("", { status: 200, headers: { "x-amz-server-side-encryption": init.headers["x-amz-server-side-encryption"] ?? "" } });
    }
    if (init.method === "DELETE") { store.delete(key); return new Response(null, { status: 204 }); }
    const v = store.get(key);
    return v ? new Response(v as BodyInit, { status: 200 }) : new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, store };
}

describe("S3 object storage", () => {
  it("round-trips bytes with server-side encryption, attachment metadata and signed requests", async () => {
    const { fetchImpl, calls } = fakeS3();
    const s = createS3Storage({ ...base, fetchImpl, now: fixed });
    await s.put("listings/abc/def", new Uint8Array([1, 2, 3]), "image/webp");
    expect(Array.from(await s.get("listings/abc/def"))).toEqual([1, 2, 3]);
    const put = calls[0]!;
    expect(put.url).toBe("https://ol-prod.s3.ap-southeast-2.amazonaws.com/listings/abc/def");
    expect(put.headers["x-amz-server-side-encryption"]).toBe("AES256");
    expect(put.headers["content-disposition"]).toBe("attachment");
    expect(put.headers["cache-control"]).toBe("private, no-store");
    expect(put.headers["if-none-match"]).toBe("*");
    expect(put.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/20261105\/ap-southeast-2\/s3\/aws4_request, SignedHeaders=.*host.*x-amz-date.*, Signature=[0-9a-f]{64}$/);
    expect(put.headers["x-amz-content-sha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sends the KMS key id, never overwrites, and refuses an encryption mismatch", async () => {
    const { fetchImpl, calls } = fakeS3();
    const s = createS3Storage({ ...base, sse: "aws:kms", kmsKeyId: "arn:aws:kms:x", fetchImpl, now: fixed });
    await s.put("inspections/a/b", new Uint8Array([1]), "application/pdf");
    expect(calls[0]!.headers["x-amz-server-side-encryption"]).toBe("aws:kms");
    expect(calls[0]!.headers["x-amz-server-side-encryption-aws-kms-key-id"]).toBe("arn:aws:kms:x");
    await expect(s.put("inspections/a/b", new Uint8Array([2]), "application/pdf")).rejects.toThrow(/412/);
    const mism = createS3Storage({ ...base, sse: "aws:kms", fetchImpl: (async () => new Response("", { status: 200, headers: { "x-amz-server-side-encryption": "AES256" } })) as unknown as typeof fetch });
    await expect(mism.put("listings/a/b", new Uint8Array([1]), "image/png")).rejects.toThrow(/encryption/);
  });

  it("refuses keys that are not server-made, and deletes only identity images", async () => {
    const { fetchImpl, calls } = fakeS3();
    const s = createS3Storage({ ...base, fetchImpl, now: fixed });
    for (const k of ["../etc/passwd", "listings/a/../b", "other/a/b", "listings/a"]) {
      await expect(s.put(k, new Uint8Array([1]), "image/png")).rejects.toThrow();
      await expect(s.get(k)).rejects.toThrow();
    }
    await expect(s.remove!("listings/a/b")).rejects.toThrow(/identity/);
    await s.put("id/aa/bb", new Uint8Array([1]), "application/octet-stream");
    await s.remove!("id/aa/bb");
    await s.remove!("id/aa/bb"); // already gone counts as deleted
    expect(calls.filter(c => c.method === "DELETE")).toHaveLength(2);
    await expect(s.get("id/aa/bb")).rejects.toThrow(/404/);
  });

  it("makes short-lived signed download URLs that force attachment", () => {
    const s = createS3Storage({ ...base, now: fixed });
    const u = new URL(s.signedUrl("listings/abc/def", { ttlSeconds: 99999, filename: 'a b"c.pdf', contentType: "application/pdf" }));
    expect(u.host).toBe("ol-prod.s3.ap-southeast-2.amazonaws.com");
    expect(u.searchParams.get("X-Amz-Expires")).toBe("3600");
    expect(u.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(u.searchParams.get("response-content-disposition")).toBe('attachment; filename="a_b_c.pdf"');
    expect(u.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(u.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
    expect(s.signedUrl("listings/abc/def")).not.toBe(s.signedUrl("listings/abc/xyz"));
    expect(() => s.signedUrl("../x")).toThrow();
  });

  it("uses path-style on a custom endpoint (Wasabi, B2) and refuses http in production", () => {
    const s = createS3Storage({ ...base, endpoint: "https://s3.wasabisys.com", now: fixed });
    expect(s.signedUrl("id/aa/bb")).toMatch(/^https:\/\/s3\.wasabisys\.com\/ol-prod\/id\/aa\/bb\?/);
    const prev = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try { expect(() => createS3Storage({ ...base, endpoint: "http://minio.local:9000" })).toThrow(/https/); }
    finally { (process.env as Record<string, string | undefined>).NODE_ENV = prev; }
  });

  it("is configured from env only when complete and valid; anything else fails closed", () => {
    const ok = { STORAGE_DRIVER: "s3", S3_BUCKET: "b", S3_REGION: "r", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s", NODE_ENV: "production" };
    expect(objectStorageFromEnv(ok).configured).toBe(true);
    expect(objectStorageFromEnv({ ...ok, S3_SSE: "aws:kms" }).configured).toBe(true);
    expect(objectStorageFromEnv({ ...ok, S3_ENDPOINT: "https://s3.wasabisys.com" }).configured).toBe(true);
    for (const miss of ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]) expect(objectStorageFromEnv({ ...ok, [miss]: "" }).configured).toBe(false);
    expect(objectStorageFromEnv({ ...ok, S3_SSE: "none" }).configured).toBe(false);
    expect(objectStorageFromEnv({ ...ok, S3_ENDPOINT: "http://x.local" }).configured).toBe(false);
    expect(objectStorageFromEnv({ ...ok, S3_ENDPOINT: "not a url" }).configured).toBe(false);
  });
});
