import { beforeEach, describe, expect, it, vi } from "vitest";
import { forbiddenFor, type Action } from "../src/domain/access";
import { createInMemoryDocumentStore, listDocuments, requestDocumentDeletion } from "../src/domain/document-service";
import type { JobAssignment } from "../src/domain/job-chat";
import { createInMemoryChatRepository, postChatMessage, readChat } from "../src/domain/job-chat-service";
import {
  createDraft, createInMemoryListingRepository,
  type Actor, type DraftInput, type ListingServiceDeps
} from "../src/domain/listing-service";
import { SESSION_COOKIE, signSession, verifySession } from "../src/server/auth/session";
import type { Queryable } from "../src/server/db";
import { upsertGoogleUser } from "../src/server/users";

const state = vi.hoisted(() => ({
  actor: null as Actor | null,
  deps: null as ListingServiceDeps | null,
  db: null as Queryable | null
}));

vi.mock("../src/server/context", () => ({
  getActor: () => state.actor,
  getDeps: () => state.deps,
  getDb: () => state.db
}));

vi.mock("../src/server/auth/google", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/auth/google")>()),
  exchangeCode: async () => ({}),
  readIdentity: () => ({ sub: "google-sub-1", email: "buyer@example.com", name: "Bea Buyer" })
}));

import { GET as callbackGet } from "../app/api/auth/google/callback/route";
import { GET as startGet } from "../app/api/auth/google/start/route";
import { GET as mineGet } from "../app/api/listings/mine/route";
import { POST as createRoute } from "../app/api/listings/route";
import { POST as publishRoute } from "../app/api/listings/[id]/publish/route";
import { GET as offersGet } from "../app/api/listings/[id]/offers/route";
import { GET as getRoute, PATCH as patchRoute } from "../app/api/listings/[id]/route";

const secret = "s".repeat(40);
const now = 1_800_000_000;
const buyer: Actor = { userId: "b0000000-0000-4000-8000-000000000001", userType: "buyer" };
const owner: Actor = { userId: "o0000000-0000-4000-8000-000000000001", userType: "owner" };
const input: DraftInput = {
  title: "Family home", address: "1 Example St, Brisbane QLD", jurisdiction: "QLD",
  transactionType: "sale", useClass: "residential", propertyType: "house"
};

describe("session claim", () => {
  const payload = { uid: buyer.userId, ut: "buyer" as const, exp: now + 100 };
  it("accepts a signed buyer session", () => {
    expect(verifySession(signSession(payload, secret), secret, now)).toEqual(payload);
  });
  it("still rejects unknown, staff and malformed user types", () => {
    for (const ut of ["admin", "vendor", "staff", "super_admin", "", "BUYER", 1, null, undefined]) {
      expect(verifySession(signSession({ ...payload, ut: ut as unknown as "buyer" }, secret), secret, now)).toBeNull();
    }
  });
  it("rejects an owner token whose claim was edited to buyer or the reverse without re-signing", () => {
    for (const [from, to] of [["owner", "buyer"], ["buyer", "owner"], ["buyer", "agent"]] as const) {
      const [, sig] = signSession({ ...payload, ut: from }, secret).split(".") as [string, string];
      const forged = Buffer.from(JSON.stringify({ ...payload, ut: to })).toString("base64url");
      expect(verifySession(`${forged}.${sig}`, secret, now)).toBeNull();
    }
  });
});

describe("a buyer role is denied by default", () => {
  const actions: Action[] = ["listing.create", "listing.publish", "enquiry.handle", "offer.analyse", "offer.approve", "licence.verify", "audit.read"];
  it("fails every role-checked action", () => {
    for (const a of actions) {
      expect(forbiddenFor({ id: buyer.userId, role: "buyer" }, a)?.code).toBe("forbidden");
    }
  });
});

describe("upsertGoogleUser", () => {
  const who = { sub: "google-sub-1", email: "buyer@example.com", name: "Bea Buyer" };
  const fakeDb = (row: Record<string, unknown> | undefined) => {
    const calls: { text: string; params: unknown[] }[] = [];
    const db: Queryable = { async query(text, params) { calls.push({ text, params: params ?? [] }); return { rows: row ? [row] : [] }; } };
    return { db, calls };
  };
  it("creates owners by default and buyers only when asked, passing the type as a parameter", async () => {
    const a = fakeDb({ id: "u1", user_type: "owner", status: "active" });
    await upsertGoogleUser(a.db, who);
    expect(a.calls[0]!.params).toEqual([who.email, who.name, who.sub, "owner"]);
    const b = fakeDb({ id: "u2", user_type: "buyer", status: "active" });
    expect(await upsertGoogleUser(b.db, who, "buyer")).toEqual({ id: "u2", userType: "buyer" });
    expect(b.calls[0]!.params[3]).toBe("buyer");
    expect(b.calls[0]!.text).not.toMatch(/user_type\s*=\s*EXCLUDED/i);
  });
  it("keeps the stored type of an existing account, whatever was requested", async () => {
    const owned = fakeDb({ id: "u3", user_type: "owner", status: "active" });
    expect(await upsertGoogleUser(owned.db, who, "buyer")).toEqual({ id: "u3", userType: "owner" });
    const agentRow = fakeDb({ id: "u4", user_type: "agent", status: "active" });
    expect(await upsertGoogleUser(agentRow.db, who, "buyer")).toEqual({ id: "u4", userType: "agent" });
  });
  it("returns null for staff and other types, inactive accounts and no row", async () => {
    for (const t of ["admin", "vendor", "investor", "project_owner"]) {
      expect(await upsertGoogleUser(fakeDb({ id: "u", user_type: t, status: "active" }).db, who, "buyer")).toBeNull();
    }
    expect(await upsertGoogleUser(fakeDb({ id: "u", user_type: "buyer", status: "suspended" }).db, who, "buyer")).toBeNull();
    expect(await upsertGoogleUser(fakeDb(undefined).db, who, "buyer")).toBeNull();
  });
});

describe("sign-in routes", () => {
  beforeEach(() => {
    process.env["SESSION_SECRET"] = secret;
    process.env["GOOGLE_CLIENT_ID"] = "client";
    process.env["GOOGLE_CLIENT_SECRET"] = "client-secret";
    process.env["APP_URL"] = "https://app.example.com";
  });
  const roleCookie = (res: Response) => /ol_role=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];

  it("remembers buyer only for ?as=buyer; anything else means owner", async () => {
    expect(roleCookie(await startGet(new Request("http://x/api/auth/google/start?as=buyer")))).toBe("buyer");
    for (const as of ["owner", "agent", "admin", "BUYER", ""]) {
      expect(roleCookie(await startGet(new Request(`http://x/api/auth/google/start?as=${as}`)))).toBe("owner");
    }
    expect(roleCookie(await startGet(new Request("http://x/api/auth/google/start")))).toBe("owner");
  });

  const callback = async (roleValue: string | undefined, dbRowType: string) => {
    const seen: unknown[][] = [];
    state.db = { async query(_t, params) { seen.push(params ?? []); return { rows: [{ id: "u9", user_type: dbRowType, status: "active" }] }; } };
    const cookies = ["ol_state=s1", "ol_nonce=n1", "ol_verifier=v1", ...(roleValue === undefined ? [] : [`ol_role=${roleValue}`])].join("; ");
    const res = await callbackGet(new Request("http://x/api/auth/google/callback?code=c&state=s1", { headers: { cookie: cookies } }));
    return { res, requested: seen[0]?.[3] };
  };

  it("creates a buyer from the buyer cookie, sends them to saved searches and signs the buyer claim", async () => {
    const { res, requested } = await callback("buyer", "buyer");
    expect(requested).toBe("buyer");
    expect(res.headers.get("location")).toBe("https://app.example.com/buyer/saved-searches");
    const token = /ol_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    expect(SESSION_COOKIE).toBe("ol_session");
    expect(verifySession(token, secret, Math.floor(Date.now() / 1000))?.ut).toBe("buyer");
  });
  it("treats a missing or unexpected role cookie as owner, never agent or admin", async () => {
    for (const v of [undefined, "owner", "agent", "admin", "junk"]) {
      const { res, requested } = await callback(v, "owner");
      expect(requested).toBe("owner");
      expect(res.headers.get("location")).toBe("https://app.example.com/listings/new");
    }
  });
  it("lets an existing owner who picks buyer stay an owner", async () => {
    const { res } = await callback("buyer", "owner");
    const token = /ol_session=([^;]*)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
    expect(verifySession(token, secret, Math.floor(Date.now() / 1000))?.ut).toBe("owner");
    expect(res.headers.get("location")).toBe("https://app.example.com/listings/new");
  });
  it("fails the login for a staff account", async () => {
    const { res } = await callback("buyer", "admin");
    expect(res.headers.get("location")).toBe("https://app.example.com/?login=failed");
  });
});

describe("a signed-in buyer on existing owner-only and agent-only routes", () => {
  let n: number;
  let draftId: string;
  beforeEach(async () => {
    n = 0;
    state.actor = null;
    state.db = { async query() { return { rows: [] }; } };
    state.deps = {
      repo: createInMemoryListingRepository(),
      appendAudit: async () => {},
      now: () => "2026-10-24T00:00:00.000Z",
      newId: () => `id-${++n}`,
      requiredDisclosures: () => []
    };
    draftId = (await createDraft(state.deps, owner, input)).id;
    state.actor = buyer;
  });
  const json = (url: string, method: string, body?: unknown) =>
    new Request(`http://test${url}`, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

  it("cannot create a listing (403)", async () => {
    expect((await createRoute(json("/api/listings", "POST", input))).status).toBe(403);
  });
  it("cannot publish or dry-run publish (403)", async () => {
    expect((await publishRoute(json(`/api/listings/${draftId}/publish`, "POST"), ctx(draftId))).status).toBe(403);
    expect((await publishRoute(json(`/api/listings/${draftId}/publish?dryRun=1`, "POST"), ctx(draftId))).status).toBe(403);
  });
  it("cannot list My listings (403)", async () => {
    expect((await mineGet(new Request("http://test/api/listings/mine"))).status).toBe(403);
  });
  it("cannot review offers (403)", async () => {
    expect((await offersGet(new Request(`http://test/api/listings/${draftId}/offers`), ctx(draftId))).status).toBe(403);
  });
  it("cannot read or edit someone else's draft (404)", async () => {
    expect((await getRoute(new Request(`http://test/api/listings/${draftId}`), ctx(draftId))).status).toBe(404);
    expect((await patchRoute(json(`/api/listings/${draftId}`, "PATCH", { title: "Hijack" }), ctx(draftId))).status).toBe(404);
    expect((await state.deps!.repo.get(draftId))?.listing.title).toBe("Family home");
  });

  it("cannot read or post in a job chat they are not part of (404)", async () => {
    const A = "11111111-1111-4111-8111-111111111111";
    const assignment: JobAssignment = {
      id: A, listingId: "55555555-5555-4555-8555-555555555555",
      ownerUserId: owner.userId, contractorUserId: "c0000000-0000-4000-8000-000000000001", kind: "photographer", status: "approved"
    };
    const repo = createInMemoryChatRepository([assignment]);
    const ids = { newId: () => "66666666-6666-4666-8666-000000000001", now: () => "2026-10-24T00:00:00.000Z" };
    expect(await readChat(repo, buyer, A)).toMatchObject({ ok: false, code: "not_found" });
    expect(await postChatMessage(repo, buyer, A, { body: "hi" }, ids)).toMatchObject({ ok: false, code: "not_found" });
    expect(repo.messages).toHaveLength(0);
  });
  it("cannot list a draft's documents or request a document's deletion (404)", async () => {
    const { store, requests } = createInMemoryDocumentStore();
    expect(await listDocuments(state.deps!, store, buyer, draftId)).toMatchObject({ ok: false, code: "not_found" });
    expect(await requestDocumentDeletion(state.deps!, store, buyer, "d0000000-0000-4000-8000-000000000001")).toMatchObject({ ok: false, code: "not_found" });
    expect(requests).toHaveLength(0);
  });
});
