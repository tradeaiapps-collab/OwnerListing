import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { actorFromRequestChecked } from "../src/server/auth/actor";
import { SESSION_COOKIE, signSession } from "../src/server/auth/session";
import { activateRole, readRoles, saveCurrentRole } from "../src/server/user-roles-db";
import { createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

const secret = "s".repeat(40);
const now = Math.floor(Date.now() / 1000);

describe.skipIf(!DATABASE_URL)("multi-role accounts (Postgres)", () => {
  let t: TestDb;
  let uid: string;
  beforeAll(async () => {
    t = await createTestDb();
    const r = await t.db.query(`INSERT INTO app_user (email, display_name, user_type, status) VALUES ('r@example.com','R','buyer','active') RETURNING id`);
    uid = String(r.rows[0]!["id"]);
  });
  afterAll(async () => { await t?.close(); });
  const req = (ut: "owner" | "agent" | "buyer", cr?: "investor") =>
    new Request("http://x", { headers: { cookie: `${SESSION_COOKIE}=${signSession({ uid, ut, exp: now + 100, mfa: now, ...(cr ? { cr } : {}) }, secret)}` } });

  it("starts single-role and refuses roles it has not activated", async () => {
    expect((await readRoles(t.db, uid))?.roles).toEqual(["buyer"]);
    expect(await actorFromRequestChecked(t.db, req("owner"), secret, now)).toBeNull();
    expect(await actorFromRequestChecked(t.db, req("buyer", "investor"), secret, now)).toBeNull();
  });
  it("activating a role lets the session run as it, with the same user and data", async () => {
    expect(await activateRole(t.db, uid, "owner")).toEqual(["buyer", "owner"]);
    expect(await actorFromRequestChecked(t.db, req("owner"), secret, now)).toEqual({ userId: uid, userType: "owner" });
    expect(await actorFromRequestChecked(t.db, req("buyer"), secret, now)).toEqual({ userId: uid, userType: "buyer" });
    expect(await actorFromRequestChecked(t.db, req("agent"), secret, now)).toBeNull();
  });
  it("investor adds buyer too and activating twice changes nothing", async () => {
    await activateRole(t.db, uid, "investor");
    expect(await activateRole(t.db, uid, "investor")).toEqual(["buyer", "owner", "investor"]);
    expect(await actorFromRequestChecked(t.db, req("buyer", "investor"), secret, now)).toEqual({ userId: uid, userType: "buyer" });
  });
  it("remembers the last role switched to", async () => {
    await saveCurrentRole(t.db, uid, "owner");
    expect((await readRoles(t.db, uid))?.currentRole).toBe("owner");
  });
  it("rejects a role outside the allowed four", async () => {
    await expect(t.db.query(`UPDATE app_user SET roles = ARRAY['admin'] WHERE id = $1`, [uid])).rejects.toThrow();
  });
});
