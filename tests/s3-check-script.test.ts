import { afterEach, describe, expect, it, vi } from "vitest";
import { createS3Storage } from "../src/adapters/s3-storage";
// @ts-expect-error plain JS script
import { checkS3 } from "../scripts/s3-check.mjs";

const env = { S3_BUCKET: "ol-prod", S3_REGION: "ap-southeast-2", S3_ACCESS_KEY_ID: "AKIAEXAMPLE", S3_SECRET_ACCESS_KEY: "secret" };

/** A bucket that behaves like the intended production one: SSE required, no overwrite, signed reads only, deletes only under id/. */
function fakeBucket() {
  const store = new Map<string, Uint8Array>();
  const goodSigs = new Set<string>();
  const calls: { method: string; url: string; headers: Record<string, string> }[] = [];
  const impl = async (url: string, init: { method?: string; headers?: Record<string, string>; body?: Uint8Array } = {}) => {
    const method = init.method ?? "GET", headers = init.headers ?? {}, u = new URL(url), key = u.pathname;
    calls.push({ method, url, headers });
    if (u.searchParams.has("X-Amz-Signature")) {
      const sig = u.searchParams.get("X-Amz-Signature")!;
      if (!goodSigs.size) goodSigs.add(sig);
      const v = store.get(key);
      return v && goodSigs.has(sig) ? new Response(v as BodyInit, { status: 200, headers: { "content-disposition": u.searchParams.get("response-content-disposition") ?? "" } }) : new Response("", { status: 403 });
    }
    if (!headers.authorization) return new Response("", { status: 403 });
    if (method === "PUT") {
      if (headers["x-amz-server-side-encryption"] !== "AES256") return new Response("", { status: 403 });
      if (headers["if-none-match"] === "*" && store.has(key)) return new Response("", { status: 412 });
      store.set(key, init.body!);
      return new Response("", { status: 200, headers: { "x-amz-server-side-encryption": "AES256" } });
    }
    if (method === "DELETE") {
      if (!/\/id\//.test(key)) return new Response("", { status: 403 });
      store.delete(key); return new Response(null, { status: 204 });
    }
    const v = store.get(key);
    return v ? new Response(v as BodyInit, { status: 200 }) : new Response("", { status: 403 });
  };
  return { impl, calls };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("scripts/s3-check.mjs", () => {
  it("passes every check against a correctly locked-down bucket", async () => {
    const b = fakeBucket();
    vi.stubGlobal("fetch", b.impl);
    const res = await checkS3(env);
    expect(res.filter((r: { ok: boolean }) => !r.ok)).toEqual([]);
    expect(res.length).toBe(9);
  });

  it("fails when the bucket lets the app key delete outside id/", async () => {
    const b = fakeBucket();
    vi.stubGlobal("fetch", (async (url: string, init: { method?: string }) => init?.method === "DELETE" ? new Response(null, { status: 204 }) : b.impl(url, init as never)) as typeof fetch);
    const res = await checkS3(env);
    expect(res.find((r: { name: string }) => r.name === "delete outside id/ is refused")?.ok).toBe(false);
  });

  it("signs with the same credential scope as the app's adapter", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-11-05T04:00:00Z"));
    const b = fakeBucket();
    vi.stubGlobal("fetch", b.impl);
    await checkS3(env);
    const first = b.calls[0]!;
    const key = new URL(first.url).pathname.slice(1);
    const adapterCalls = fakeBucket();
    const s = createS3Storage({ bucket: "ol-prod", region: "ap-southeast-2", accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", fetchImpl: adapterCalls.impl as unknown as typeof fetch, now: () => new Date("2026-11-05T04:00:00Z") });
    await s.put(key, new TextEncoder().encode("x"), "text/plain");
    const sigOf = (h: string) => /Signature=([0-9a-f]+)/.exec(h)![1];
    // Different payload and headers, so compare the scope/credential shape and signed-header list, and that a signature is present.
    const a = adapterCalls.calls[0]!.headers.authorization!, c = first.headers.authorization!;
    expect(c.split(", ")[0]).toBe(a.split(", ")[0]);
    expect(sigOf(c)).toMatch(/^[0-9a-f]{64}$/);
  });
});
