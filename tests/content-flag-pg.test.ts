import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scanContent } from "../src/domain/content-filter";
import { guardContent } from "../src/server/content-guard";
import { createPgContentFlagStore, listOpenContentFlagsPg, reviewContentFlagPg } from "../src/server/content-flag-db";
import { listQueuePg } from "../src/server/moderation-queue-db";
import { addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("content flags on Postgres", () => {
  let t: TestDb;
  let user: string, staff: string;
  beforeAll(async () => { t = await createTestDb(); user = await addUser(t.db, "buyer"); staff = await addUser(t.db, "admin"); }, 60_000);
  afterAll(async () => { await t?.close(); });

  it("stores refused and flagged text, lists open flags oldest first, and reviews each once", async () => {
    const store = createPgContentFlagStore(t.db);
    const blocked = await guardContent(store, { source: "message", subjectType: "enquiry_message", userId: user, fields: { body: "ring 0412 345 678" }, allowedHosts: [] });
    expect(blocked.ok).toBe(false);
    const flagged = await guardContent(store, { source: "profile", subjectType: "agent_profile", userId: user, fields: { bio: "this is crap" }, allowedHosts: [] });
    if (flagged.ok) await flagged.after(user);

    const open = await listOpenContentFlagsPg(t.db);
    expect(open.map(f => f.action)).toEqual(["block", "flag"]);
    expect(open[0]).toMatchObject({ source: "message", field: "body", categories: ["contact_details"], excerpt: "ring 0412 345 678" });
    expect(open[1]).toMatchObject({ source: "profile", subjectId: user });
    expect(scanContent(open[0]!.excerpt).action).toBe("block");

    expect(await reviewContentFlagPg(t.db, open[0]!.id, staff, "confirmed", "Phone number")).toBe(true);
    expect(await reviewContentFlagPg(t.db, open[0]!.id, staff, "dismissed")).toBe(false);
    expect((await listOpenContentFlagsPg(t.db)).map(f => f.id)).toEqual([open[1]!.id]);
  });
  it("is a permanent record: no delete, no edits to the content", async () => {
    const [f] = await listOpenContentFlagsPg(t.db);
    await expect(t.db.query("DELETE FROM content_flag WHERE id = $1", [f!.id])).rejects.toThrow(/permanent/);
    await expect(t.db.query("UPDATE content_flag SET excerpt = 'x' WHERE id = $1", [f!.id])).rejects.toThrow(/cannot change/);
  });

  it("stored flagged text also reaches the staff moderation queue, once, but refused text does not", async () => {
    const store = createPgContentFlagStore(t.db);
    const author = await addUser(t.db, "agent");
    const subject = "99999999-9999-4999-8999-999999999999";
    const flagged = await guardContent(store, { source: "message", subjectType: "deal_message", userId: author, fields: { body: "this is crap" }, allowedHosts: [], ignore: ["contact_details"] });
    if (flagged.ok) { await flagged.after(subject); await flagged.after(subject); }
    const refused = await guardContent(store, { source: "message", subjectType: "deal_message", userId: author, fields: { body: "you fucking idiot" }, allowedHosts: [], ignore: ["contact_details"] });
    expect(refused.ok).toBe(false);
    const mine = (await listQueuePg(t.db, { view: "open", subjectType: "message" })).filter(i => i.subjectOwnerId === author);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ subjectId: subject, source: "content_filter", severity: "high", detail: "this is crap" });
  });
});
