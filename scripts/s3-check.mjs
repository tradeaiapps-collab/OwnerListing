// Health check of the production object-storage bucket, using the same S3_* env vars as the app. Standalone (own SigV4, no SDK), so it
// tests the real bucket and keys, not the app's code. Usage: S3_BUCKET=... S3_REGION=ap-southeast-2 S3_ACCESS_KEY_ID=... S3_SECRET_ACCESS_KEY=... npm run check:s3
// Writes ONE tiny object under id/ (the only prefix the app may delete), reads it, then deletes it. With bucket versioning the delete leaves a
// marker that the lifecycle rule removes within about 2 days. Also run by `npm run smoke:prod` when S3_BUCKET is set.
import { createHash, createHmac, randomBytes } from "node:crypto";

const sha = d => createHash("sha256").update(d).digest("hex");
const hmac = (k, d) => createHmac("sha256", k).update(d).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());

export function target(env, key) {
  const { S3_BUCKET: bucket, S3_REGION: region } = env;
  const custom = env.S3_ENDPOINT ? new URL(env.S3_ENDPOINT) : null;
  const pathStyle = env.S3_FORCE_PATH_STYLE ? env.S3_FORCE_PATH_STYLE === "1" : custom !== null;
  const host = custom ? (pathStyle ? custom.host : `${bucket}.${custom.host}`) : (pathStyle ? `s3.${region}.amazonaws.com` : `${bucket}.s3.${region}.amazonaws.com`);
  const path = (pathStyle ? `/${bucket}/` : "/") + key.split("/").map(enc).join("/");
  return { host, path, scheme: custom ? custom.protocol : "https:" };
}

async function call(env, method, key, body = null, extra = {}) {
  const { host, path, scheme } = target(env, key);
  const t = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), day = t.slice(0, 8);
  const h = { host, "x-amz-content-sha256": sha(body ?? ""), "x-amz-date": t, ...extra };
  const names = Object.keys(h).map(x => x.toLowerCase()).sort();
  const low = Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const canonical = [method, path, "", names.map(n => `${n}:${low[n]}\n`).join(""), names.join(";"), h["x-amz-content-sha256"]].join("\n");
  const scope = `${day}/${env.S3_REGION}/s3/aws4_request`;
  const key4 = hmac(hmac(hmac(hmac("AWS4" + env.S3_SECRET_ACCESS_KEY, day), env.S3_REGION), "s3"), "aws4_request");
  const sig = createHmac("sha256", key4).update(["AWS4-HMAC-SHA256", t, scope, sha(canonical)].join("\n")).digest("hex");
  const { host: _h, ...send } = h;
  send.authorization = `AWS4-HMAC-SHA256 Credential=${env.S3_ACCESS_KEY_ID}/${scope}, SignedHeaders=${names.join(";")}, Signature=${sig}`;
  return fetch(`${scheme}//${host}${path}`, { method, headers: send, ...(body ? { body } : {}), signal: AbortSignal.timeout(20000) });
}

function signedGet(env, key, ttl = 60) {
  const { host, path, scheme } = target(env, key);
  const t = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), day = t.slice(0, 8);
  const scope = `${day}/${env.S3_REGION}/s3/aws4_request`;
  const q = { "X-Amz-Algorithm": "AWS4-HMAC-SHA256", "X-Amz-Credential": `${env.S3_ACCESS_KEY_ID}/${scope}`, "X-Amz-Date": t, "X-Amz-Expires": String(ttl), "X-Amz-SignedHeaders": "host", "response-content-disposition": 'attachment; filename="check.txt"' };
  const qs = Object.keys(q).sort().map(k => `${enc(k)}=${enc(q[k])}`).join("&");
  const canonical = ["GET", path, qs, `host:${host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const key4 = hmac(hmac(hmac(hmac("AWS4" + env.S3_SECRET_ACCESS_KEY, day), env.S3_REGION), "s3"), "aws4_request");
  const sig = createHmac("sha256", key4).update(["AWS4-HMAC-SHA256", t, scope, sha(canonical)].join("\n")).digest("hex");
  return { url: `${scheme}//${host}${path}?${qs}&X-Amz-Signature=${sig}`, bare: `${scheme}//${host}${path}` };
}

export async function checkS3(env = process.env) {
  const results = [];
  const run = async (name, fn) => {
    try { const [ok, detail] = await fn(); results.push({ name, ok, detail }); }
    catch (e) { results.push({ name, ok: false, detail: String(e.cause?.code || e.message || e) }); }
  };
  const e = { ...env }, sse = e.S3_SSE || "AES256";
  const key = `id/s3check${randomBytes(6).toString("hex")}/s3check${randomBytes(6).toString("hex")}`;
  const bytes = Buffer.from("s3 check " + randomBytes(8).toString("hex"));
  const wr = { "content-type": "text/plain", "content-disposition": "attachment", "x-amz-server-side-encryption": sse, "if-none-match": "*" };
  if (sse === "aws:kms" && e.S3_KMS_KEY_ID) wr["x-amz-server-side-encryption-aws-kms-key-id"] = e.S3_KMS_KEY_ID;
  if (e.S3_CONDITIONAL_PUT === "0") delete wr["if-none-match"];
  await run("write with server-side encryption", async () => { const r = await call(e, "PUT", key, bytes, wr); const echoed = r.headers.get("x-amz-server-side-encryption"); return [r.ok && (!echoed || echoed === sse), `status ${r.status}${echoed ? ", " + echoed : ""}`]; });
  await run("write without encryption header is refused", async () => { const { "x-amz-server-side-encryption": _x, ...h } = wr; const k = key + "x"; const r = await call(e, "PUT", k, bytes, h); if (r.ok) await call(e, "DELETE", k).catch(() => {}); return [!r.ok || !!r.headers.get("x-amz-server-side-encryption"), `status ${r.status} (200 without the header means the bucket policy deny is missing; S3 default encryption still applies)`]; });
  if (e.S3_CONDITIONAL_PUT !== "0") await run("overwrite is refused (If-None-Match)", async () => { const r = await call(e, "PUT", key, bytes, wr); return [r.status === 412 || r.status === 409, `status ${r.status}`]; });
  await run("read back matches", async () => { const r = await call(e, "GET", key); return [r.ok && Buffer.from(await r.arrayBuffer()).equals(bytes), `status ${r.status}`]; });
  await run("signed link downloads as attachment", async () => { const r = await fetch(signedGet(e, key).url, { signal: AbortSignal.timeout(20000) }); return [r.ok && /attachment/.test(r.headers.get("content-disposition") || ""), `status ${r.status}`]; });
  await run("tampered signed link is refused", async () => { const r = await fetch(signedGet(e, key).url.replace(/.$/, c => (c === "0" ? "1" : "0")), { signal: AbortSignal.timeout(20000) }); return [r.status === 403, `status ${r.status}`]; });
  await run("unsigned bucket URL is refused", async () => { const r = await fetch(signedGet(e, key).bare, { signal: AbortSignal.timeout(20000) }); return [r.status === 403 || r.status === 401, `status ${r.status}`]; });
  await run("delete of an id/ object works", async () => { const r = await call(e, "DELETE", key); return [r.ok, `status ${r.status}`]; });
  await run("delete outside id/ is refused", async () => { const k = `listings/s3check${randomBytes(4).toString("hex")}/s3check`; const r = await call(e, "DELETE", k); return [r.status === 403, `status ${r.status} (204 means the app key can delete listing files: tighten the IAM policy)`]; });
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const need = ["S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"].filter(k => !process.env[k]);
  if (need.length) { console.error(`Missing: ${need.join(", ")}`); process.exit(2); }
  const res = await checkS3();
  for (const r of res) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.ok ? "" : r.detail}`);
  process.exit(res.every(r => r.ok) ? 0 : 1);
}
