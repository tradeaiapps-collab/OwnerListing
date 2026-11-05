import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  API_RATE, generateKey, narrowScopes, parseKey, parseScopes, routeTemplate, secretMatches, signToken, verifyToken
} from "../src/domain/api-keys";
import { analyseUsage, answerApiQuestion } from "../src/domain/api-insights";
import { buildOpenApi, documentedOperations } from "../src/domain/openapi";
import {
  RETRY_DELAYS_SECONDS, nextAttemptDelaySeconds, parseEvents, signPayload, validateWebhookUrl, verifySignature
} from "../src/domain/webhooks";
import { authenticateClient, withClient } from "../src/server/api/api-client-auth";
import { createKey, revokeKey, logCall } from "../src/server/public-api-db";
import { runWebhooks, type Sender } from "../src/server/webhook-delivery";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/server/context", () => ({ getDb: () => state.db, getDeps: () => null, getActor: () => null }));

import { POST as tokenRoute } from "../app/api/oauth/token/route";
import { GET as offersRoute } from "../app/api/me/offers/route";
import { POST as hooksPost, GET as hooksGet } from "../app/api/developer/webhooks/route";

const SECRET = "s".repeat(40);
const root = path.join(__dirname, "..");

describe("API keys and tokens", () => {
  it("generates keys that parse and verify, and stores only a hash", () => {
    const k = generateKey();
    expect(k.fullKey).toMatch(/^olk_[a-z0-9]{12}\.[A-Za-z0-9_-]{43}$/);
    expect(parseKey(k.fullKey)).toEqual({ publicId: k.publicId, secret: k.secret });
    expect(k.secretHash).not.toContain(k.secret);
    expect(secretMatches(k.secret, k.secretHash)).toBe(true);
    expect(secretMatches(k.secret + "x", k.secretHash)).toBe(false);
    expect(generateKey().fullKey).not.toBe(k.fullKey);
    expect(parseKey("olk_short.x")).toBeNull();
  });
  it("accepts only known scopes", () => {
    expect(parseScopes(["listings.read", "listings.read"])).toEqual(["listings.read"]);
    expect(parseScopes(["admin"])).toBeNull();
    expect(parseScopes([])).toBeNull();
    expect(parseScopes("listings.read")).toBeNull();
    expect(narrowScopes(["listings.read", "offers.read"], "offers.read")).toEqual(["offers.read"]);
    expect(narrowScopes(["listings.read"], "offers.read")).toBeNull();
    expect(narrowScopes(["listings.read", "offers.read"], undefined)).toEqual(["listings.read", "offers.read"]);
  });
  it("signs tokens that expire and cannot be altered", () => {
    const t = signToken({ kid: "k1", scopes: ["listings.read"], exp: 2000 }, SECRET);
    expect(verifyToken(t, SECRET, 1000)).toEqual({ kid: "k1", scopes: ["listings.read"], exp: 2000 });
    expect(verifyToken(t, SECRET, 2000)).toBeNull();
    expect(verifyToken(t, "o".repeat(40), 1000)).toBeNull();
    const [head, sig] = t.slice(4).split(".");
    const forged = Buffer.from(JSON.stringify({ kid: "k1", scopes: ["webhooks.manage"], exp: 2000 })).toString("base64url");
    expect(verifyToken(`olt_${forged}.${sig}`, SECRET, 1000)).toBeNull();
    expect(verifyToken(`olt_${head}`, SECRET, 1000)).toBeNull();
    expect(verifyToken(t, "short", 1000)).toBeNull();
  });
  it("groups usage by route template", () => {
    expect(routeTemplate("/api/v1/public/listings/0a1b2c3d-0a1b-4c3d-8a1b-0a1b2c3d4e5f")).toBe("/public/listings/{id}");
    expect(routeTemplate("/api/me/offers")).toBe("/me/offers");
  });
});

describe("webhook rules", () => {
  it("accepts public https URLs only", () => {
    expect(validateWebhookUrl("https://hooks.example.com/ol")).toEqual({ ok: true, url: "https://hooks.example.com/ol" });
    for (const bad of ["http://hooks.example.com", "https://localhost/x", "https://127.0.0.1/x", "https://intranet.internal/x", "https://u:p@hooks.example.com", "https://hooks.example.com:8443/x", "nope", 5, "https://a"]) {
      expect(validateWebhookUrl(bad).ok, String(bad)).toBe(false);
    }
  });
  it("signs and verifies with a time window", () => {
    const h = signPayload("whsec_x", '{"a":1}', 1000);
    expect(verifySignature("whsec_x", '{"a":1}', h, 1100)).toBe(true);
    expect(verifySignature("whsec_x", '{"a":2}', h, 1100)).toBe(false);
    expect(verifySignature("whsec_y", '{"a":1}', h, 1100)).toBe(false);
    expect(verifySignature("whsec_x", '{"a":1}', h, 1400)).toBe(false);
    expect(verifySignature("whsec_x", "{}", "garbage", 1000)).toBe(false);
  });
  it("parses events and backs off", () => {
    expect(parseEvents(["offer.submitted", "offer.submitted"])).toEqual(["offer.submitted"]);
    expect(parseEvents(["nope"])).toBeNull();
    expect(parseEvents([])).toBeNull();
    expect(nextAttemptDelaySeconds(1)).toBe(RETRY_DELAYS_SECONDS[0]);
    expect(nextAttemptDelaySeconds(5)).toBeNull();
  });
});

describe("Elena for integrators", () => {
  it("suggests fixes from usage", () => {
    const r = analyseUsage([
      { route: "/public/listings", method: "GET", status: 200, calls: 300 },
      { route: "/public/listings", method: "GET", status: 429, calls: 12 },
      { route: "/developer/webhooks", method: "POST", status: 400, calls: 4 },
      { route: "/me/offers", method: "GET", status: 403, calls: 2 }
    ], { webhookEndpoints: 0, failingEndpoints: 1 });
    expect(r.totalCalls).toBe(318);
    expect(r.suggestions.map(s => s.id).sort()).toEqual(["failing_webhooks", "missing_scope", "rate_limited", "use_webhooks", "write_errors"]);
    expect(r.topRoutes[0]).toMatchObject({ route: "/public/listings", method: "GET", calls: 312, errors: 12 });
    expect(analyseUsage([], { webhookEndpoints: 0, failingEndpoints: 0 })).toMatchObject({ totalCalls: 0, errorRate: 0, suggestions: [] });
  });
  it("answers from the documentation and admits when it cannot", () => {
    expect(answerApiQuestion("How do I verify a webhook signature?").answer).toContain("OL-Signature");
    expect(answerApiQuestion("what is the rate limit").answer).toContain(String(API_RATE.perKey));
    expect(answerApiQuestion("which endpoint lists my offers").references).toContain("GET /me/offers");
    expect(answerApiQuestion("zzzz qqqq").answer).toContain("could not find");
    expect(answerApiQuestion("   ").references).toEqual([]);
  });
});

describe("OpenAPI document", () => {
  const ops = documentedOperations();
  const fileFor = (p: string) => {
    const dir = p === "/openapi" ? "openapi" : p.replace(/\{id\}/g, "[id]").replace(/^\//, "");
    return path.join(root, "app", "api", dir, "route.ts");
  };
  it("describes only routes that exist, with the documented method", () => {
    for (const op of ops) {
      const [m, p] = op.split(" ") as [string, string];
      const f = fileFor(p);
      expect(existsSync(f), op).toBe(true);
      expect(readFileSync(f, "utf8"), op).toMatch(new RegExp(`^export const ${m} = withApi\\(`, "m"));
    }
  });
  it("documents every public API route", () => {
    const routes = ["openapi", "oauth/token", "public/listings", "public/listings/[id]", "me/listings", "me/offers", "developer/webhooks", "developer/webhooks/[id]", "developer/usage", "developer/assistant"];
    const docs = new Set(ops.map(o => o.split(" ")[1]!.replace(/^\//, "").replace(/\{id\}/g, "[id]")));
    for (const r of routes) expect(docs.has(r), r).toBe(true);
  });
  it("is OpenAPI 3.1 with both security schemes, every event and an Idempotency-Key on writes", () => {
    const s = buildOpenApi("https://x.test") as Record<string, any>;
    expect(s.openapi).toBe("3.1.0");
    expect(Object.keys(s.components.securitySchemes)).toEqual(["apiKey", "oauth2"]);
    expect(Object.keys(s.webhooks)).toHaveLength(4);
    for (const [p, item] of Object.entries<any>(s.paths)) {
      if (p === "/oauth/token") continue;
      for (const m of ["post", "delete"]) if (item[m]) expect(JSON.stringify(item[m].parameters ?? []), `${m} ${p}`).toContain("Idempotency-Key");
    }
    expect(JSON.stringify(s)).not.toMatch(/olk_[a-z0-9]{12}\./);
  });
});

describe.skipIf(!DATABASE_URL)("public API (Postgres)", () => {
  let t: TestDb;
  const mkKey = async (scopes: any[] = ["listings.read", "offers.read", "webhooks.manage"], userType: "owner" | "agent" | "buyer" = "owner") => {
    const userId = await addUser(t.db, userType as never);
    const key = generateKey();
    const row = await createKey(t.db, userId, "test", scopes, key);
    if (row === "limit") throw new Error("limit");
    return { userId, key, row };
  };
  const req = (auth?: string, url = "https://x.test/api/me/offers", init: RequestInit = {}) =>
    new Request(url, { ...init, headers: { ...(auth ? { authorization: auth } : {}), ...(init.headers as object) } });
  beforeAll(async () => { t = await createTestDb(); state.db = t.db; }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("authenticates a key, rejects wrong secrets, revoked keys and non-owner accounts", async () => {
    const { userId, key, row } = await mkKey();
    const c = await authenticateClient(t.db, req(`Bearer ${key.fullKey}`), 0, {});
    expect(c).toMatchObject({ userId, scopes: ["listings.read", "offers.read", "webhooks.manage"] });
    expect(await authenticateClient(t.db, req(`Bearer ${key.publicId}.${"A".repeat(43)}`), 0, {})).toBeNull();
    expect(await authenticateClient(t.db, req(), 0, {})).toBeNull();
    expect(await authenticateClient(t.db, req("Basic abc"), 0, {})).toBeNull();
    const buyer = await mkKey(["listings.read"], "buyer");
    expect(await authenticateClient(t.db, req(`Bearer ${buyer.key.fullKey}`), 0, {})).toBeNull();
    expect(await revokeKey(t.db, userId, row.id)).toBe(true);
    expect(await revokeKey(t.db, userId, row.id)).toBe(false);
    expect(await authenticateClient(t.db, req(`Bearer ${key.fullKey}`), 0, {})).toBeNull();
  });

  it("does not let one user revoke another's key, and stops keys of closed accounts", async () => {
    const a = await mkKey(); const b = await mkKey();
    expect(await revokeKey(t.db, b.userId, a.row.id)).toBe(false);
    await t.db.query("UPDATE app_user SET status = 'suspended' WHERE id = $1", [a.userId]);
    expect(await authenticateClient(t.db, req(`Bearer ${a.key.fullKey}`), 0, {})).toBeNull();
  });

  it("enforces the key limit", async () => {
    const userId = await addUser(t.db, "owner");
    for (let i = 0; i < 10; i++) expect(await createKey(t.db, userId, `k${i}`, ["listings.read"], generateKey())).not.toBe("limit");
    expect(await createKey(t.db, userId, "one too many", ["listings.read"], generateKey())).toBe("limit");
  });

  it("checks scope (403), logs every call, and limits to 120 per minute (429)", async () => {
    const { key, row } = await mkKey(["listings.read"]);
    const ok = () => Promise.resolve(new Response("{}", { status: 200 }));
    const r403 = await withClient(t.db, req(`Bearer ${key.fullKey}`), "offers.read", ok, 0, {});
    expect(r403.status).toBe(403);
    expect((await withClient(t.db, req(`Bearer ${key.fullKey}`), "listings.read", ok, 0, {})).status).toBe(200);
    expect((await withClient(t.db, req("Bearer olk_aaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"), "listings.read", ok, 0, {})).status).toBe(401);
    for (let i = 0; i < API_RATE.perKey; i++) await logCall(t.db, row.id, "/x", "GET", 200);
    const limited = await withClient(t.db, req(`Bearer ${key.fullKey}`), "listings.read", ok, 0, {});
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe(String(API_RATE.windowSeconds));
    const logged = await t.db.query("SELECT status FROM api_request_log WHERE key_id = $1 AND route = '/me/offers' ORDER BY id", [row.id]);
    expect(logged.rows.map(r => r["status"])).toEqual([403, 200, 429]);
  });

  it("issues OAuth tokens that work until the key is revoked, and never widen scope", async () => {
    process.env["API_TOKEN_SECRET"] = SECRET;
    try {
      const { userId, key, row } = await mkKey(["listings.read", "offers.read"]);
      const form = (o: Record<string, string>) => new Request("https://x.test/api/oauth/token", { method: "POST", body: new URLSearchParams(o), headers: { "content-type": "application/x-www-form-urlencoded" } });
      const bad = await tokenRoute(form({ grant_type: "client_credentials", client_id: key.publicId, client_secret: "x".repeat(43) }));
      expect(bad.status).toBe(401);
      expect((await bad.json()).error).toBe("invalid_client");
      expect((await tokenRoute(form({ grant_type: "password", client_id: key.publicId, client_secret: key.secret }))).status).toBe(400);
      expect((await tokenRoute(form({ grant_type: "client_credentials", client_id: key.publicId, client_secret: key.secret, scope: "webhooks.manage" }))).status).toBe(403);
      const res = await tokenRoute(form({ grant_type: "client_credentials", client_id: key.publicId, client_secret: key.secret, scope: "offers.read" }));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const tok = await res.json();
      expect(tok).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "offers.read" });
      const now = Math.floor(Date.now() / 1000);
      expect(await authenticateClient(t.db, req(`Bearer ${tok.access_token}`), now, { API_TOKEN_SECRET: SECRET })).toMatchObject({ userId, scopes: ["offers.read"] });
      expect(await authenticateClient(t.db, req(`Bearer ${tok.access_token}`), now + 3601, { API_TOKEN_SECRET: SECRET })).toBeNull();
      await revokeKey(t.db, userId, row.id);
      expect(await authenticateClient(t.db, req(`Bearer ${tok.access_token}`), now, { API_TOKEN_SECRET: SECRET })).toBeNull();
    } finally { delete process.env["API_TOKEN_SECRET"]; }
  });

  it("returns only price and status of offers on the key owner's own listings", async () => {
    const { userId, key } = await mkKey(["offers.read"]);
    const other = await addUser(t.db, "owner"); const buyer = await addUser(t.db, "buyer");
    const mine = await addListing(t.db, userId, { status: "published" });
    const theirs = await addListing(t.db, other, { status: "published" });
    const offer = async (listing: string, price: number) => {
      const hash = `${price}`.padEnd(64, "a");
      await t.db.query("INSERT INTO offer_link (token_hash, listing_id, buyer_user_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')", [hash, listing, buyer]);
      await t.db.query("INSERT INTO formal_offer (listing_id, buyer_user_id, price_cents, conditions, settlement_days, deposit_cents, confirmed_final, link_token_hash) VALUES ($1,$2,$3,'[\"secret condition\"]',30,1,true,$4)", [listing, buyer, price, hash]);
    };
    await offer(mine, 900_000_00); await offer(theirs, 800_000_00);
    const res = await offersRoute(req(`Bearer ${key.fullKey}`));
    const body = await res.json();
    expect(body.offers).toHaveLength(1);
    expect(body.offers[0]).toMatchObject({ listingId: mine, priceCents: 900_000_00, status: "submitted" });
    expect(JSON.stringify(body)).not.toMatch(/secret condition|buyer/);
  });

  it("manages webhook endpoints through the API: validation, one-time secret, per-user limit", async () => {
    const { key } = await mkKey(["webhooks.manage"]);
    const post = (b: unknown) => hooksPost(new Request("https://x.test/api/developer/webhooks", { method: "POST", body: JSON.stringify(b), headers: { authorization: `Bearer ${key.fullKey}`, "content-type": "application/json" } }));
    expect((await post({ url: "http://a.example.com", events: ["offer.submitted"] })).status).toBe(400);
    expect((await post({ url: "https://a.example.com/h", events: ["nope"] })).status).toBe(400);
    const made = await post({ url: "https://a.example.com/h", events: ["offer.submitted"] });
    expect(made.status).toBe(201);
    expect((await made.json()).secret).toMatch(/^whsec_/);
    const list = await (await hooksGet(req(`Bearer ${key.fullKey}`, "https://x.test/api/developer/webhooks"))).json();
    expect(list.endpoints).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("whsec_");
    for (let i = 0; i < 4; i++) expect((await post({ url: `https://a${i}.example.com/h`, events: ["offer.submitted"] })).status).toBe(201);
    expect((await post({ url: "https://z.example.com/h", events: ["offer.submitted"] })).status).toBe(422);
  });

  it("records events from the database itself, for the listing owner only", async () => {
    const owner = await addUser(t.db, "owner"); const buyer = await addUser(t.db, "buyer"); const agent = await addUser(t.db, "agent");
    const before = Number((await t.db.query("SELECT count(*)::int n FROM api_event WHERE owner_user_id = $1", [owner])).rows[0]!["n"]);
    const listing = await addListing(t.db, owner, { status: "draft" });
    await t.db.query("UPDATE property_listing SET status = 'published' WHERE id = $1", [listing]);
    await t.db.query("UPDATE property_listing SET title = 'Renamed' WHERE id = $1", [listing]);
    const enq = String((await t.db.query("INSERT INTO enquiry (listing_id, buyer_user_id) VALUES ($1,$2) RETURNING id", [listing, buyer])).rows[0]!["id"]);
    await t.db.query("INSERT INTO enquiry_message (enquiry_id, sender_user_id, body) VALUES ($1,$2,'my private words')", [enq, buyer]);
    await t.db.query("INSERT INTO enquiry_message (enquiry_id, automated, body) VALUES ($1,true,'system note')", [enq]);
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listing, agent, owner]);
    const ev = await t.db.query("SELECT event_type, payload FROM api_event WHERE owner_user_id = $1 ORDER BY created_at, event_type", [owner]);
    expect(ev.rows.map(r => r["event_type"]).sort()).toEqual(["appointment.created", "listing.published", "message.created"]);
    expect(ev.rows.length - before).toBe(3);
    expect(JSON.stringify(ev.rows)).not.toMatch(/private words|system note/);
    expect((await t.db.query("SELECT 1 FROM api_event WHERE owner_user_id = ANY($1::uuid[])", [[buyer, agent]])).rows).toHaveLength(0);
  });

  it("delivers signed events once, retries failures with backoff, and disables a dead endpoint", async () => {
    const owner = await addUser(t.db, "owner");
    const good = await t.db.query("INSERT INTO api_webhook_endpoint (user_id,url,secret,events) VALUES ($1,'https://good.example.com/h','whsec_good','{listing.published}') RETURNING id", [owner]);
    await t.db.query("INSERT INTO api_webhook_endpoint (user_id,url,secret,events) VALUES ($1,'https://other.example.com/h','whsec_other','{offer.submitted}')", [owner]);
    await addListing(t.db, owner, { status: "published" });
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const ok: Sender = async i => { calls.push(i); return { status: 204 }; };
    const c1 = await runWebhooks(t.db, ok, () => 1_700_000_000);
    expect(c1).toMatchObject({ delivered: 1, failed: 0 });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://good.example.com/h");
    expect(verifySignature("whsec_good", call.body, call.headers["ol-signature"]!, 1_700_000_000)).toBe(true);
    expect(JSON.parse(call.body)).toMatchObject({ type: "listing.published", data: { transactionType: "sale" } });
    expect(call.headers["ol-event-id"]).toBe(JSON.parse(call.body).id);
    expect(await runWebhooks(t.db, ok)).toMatchObject({ events: 0, delivered: 0 });
    expect(calls).toHaveLength(1);

    const flaky = await addUser(t.db, "owner");
    const bad = await t.db.query("INSERT INTO api_webhook_endpoint (user_id,url,secret,events) VALUES ($1,'https://bad.example.com/h','whsec_bad','{listing.published}') RETURNING id", [flaky]);
    await addListing(t.db, flaky, { status: "published" });
    const down: Sender = async () => { throw new Error("connect refused"); };
    const c2 = await runWebhooks(t.db, down);
    expect(c2.retried).toBe(1);
    const d = (await t.db.query("SELECT state, attempts, last_error, next_attempt_at > now() + interval '30 seconds' AS later FROM api_webhook_delivery WHERE endpoint_id = $1", [bad.rows[0]!["id"]])).rows[0]!;
    expect(d).toMatchObject({ state: "pending", attempts: 1, last_error: "connect refused", later: true });
    // Fast-forward through the remaining attempts.
    for (let i = 0; i < 4; i++) {
      await t.db.query("UPDATE api_webhook_delivery SET next_attempt_at = now() - interval '1 second' WHERE endpoint_id = $1 AND state = 'pending'", [bad.rows[0]!["id"]]);
      await runWebhooks(t.db, async () => ({ status: 500 }));
    }
    const end = (await t.db.query("SELECT state, attempts, last_status FROM api_webhook_delivery WHERE endpoint_id = $1", [bad.rows[0]!["id"]])).rows[0]!;
    expect(end).toMatchObject({ state: "failed", attempts: 5, last_status: 500 });
    await t.db.query("UPDATE api_webhook_endpoint SET consecutive_failures = 9 WHERE id = $1", [bad.rows[0]!["id"]]);
    await addListing(t.db, flaky, { status: "published" });
    await runWebhooks(t.db, async () => ({ status: 500 }));
    expect((await t.db.query("SELECT active, disabled_at IS NOT NULL AS off FROM api_webhook_endpoint WHERE id = $1", [bad.rows[0]!["id"]])).rows[0]).toMatchObject({ active: false, off: true });
    expect((await t.db.query("SELECT consecutive_failures FROM api_webhook_endpoint WHERE id = $1", [good.rows[0]!["id"]])).rows[0]!["consecutive_failures"]).toBe(0);
  });
});
