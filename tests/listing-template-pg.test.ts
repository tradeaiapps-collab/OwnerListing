import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTemplate, deleteTemplate, listTemplates, updateTemplate } from "../src/domain/listing-template";
import type { Actor } from "../src/domain/listing-service";
import { createTemplateDeps } from "../src/server/listing-template-db";
import { addListing, addUser, createTestDb, DATABASE_URL, type TestDb } from "./helpers/pg-db";

// Real PostgreSQL. Skipped without DATABASE_URL (CI sets it).
describe.skipIf(!DATABASE_URL)("listing templates on Postgres", () => {
  let t: TestDb;
  beforeAll(async () => { t = await createTestDb(); }, 60_000);
  afterAll(async () => { await t?.close(); });
  const as = (userId: string, userType: Actor["userType"] = "agent"): Actor => ({ userId, userType });

  it("saves from a listing, shares with the team and keeps teams apart", async () => {
    const d = createTemplateDeps(t.db);
    const owner = await addUser(t.db, "owner"), mgr = await addUser(t.db, "agent"), ag = await addUser(t.db, "agent"), out = await addUser(t.db, "agent");
    const team = (await t.db.query("INSERT INTO agent_team (name, created_by) VALUES ('Harbour',$1) RETURNING id", [mgr])).rows[0]!["id"] as string;
    await t.db.query("INSERT INTO agent_team_member (team_id, user_id, role, status, joined_at) VALUES ($1,$2,'manager','active',now()),($1,$3,'agent','active',now())", [team, mgr, ag]);
    const listing = await addListing(t.db, owner, { title: "Secret Title", address_text: "9 Private Rd", price_cents: 90000000, bedrooms: 4, bathrooms: 2, suburb: "Surry Hills" });
    await t.db.query("UPDATE property_listing SET description = 'Bright home', amenities = ARRAY['pool','solar'] WHERE id = $1", [listing]);
    await t.db.query("INSERT INTO listing_agent_appointment (listing_id, agent_user_id, appointed_by) VALUES ($1,$2,$3)", [listing, mgr, owner]);

    const own = await createTemplate(d, as(owner, "owner"), { fromListingId: listing, name: "My house", category: "house" });
    if (!own.ok) throw new Error(own.message);
    expect(own.value.content).toEqual({ description: "Bright home", propertyType: "house", useClass: "residential", transactionType: "sale", jurisdiction: "NSW", bedrooms: 4, bathrooms: 2, amenities: ["pool", "solar"] });
    expect(JSON.stringify(own.value)).not.toMatch(/Secret|Private|90000000|Surry/);
    expect(await createTemplate(d, as(out), { fromListingId: listing, name: "Nope", category: "house" })).toMatchObject({ ok: false, code: "not_found" });

    const shared = await createTemplate(d, as(mgr), { fromListingId: listing, name: "Team house", category: "house", teamId: team });
    if (!shared.ok) throw new Error(shared.message);
    const agentView = await listTemplates(d, as(ag));
    expect(agentView.ok && agentView.value.templates).toMatchObject([{ name: "Team house", scope: "team", canEdit: false }]);
    expect(await updateTemplate(d, as(ag), shared.value.id, { name: "x1" })).toMatchObject({ ok: false, code: "forbidden" });
    const outView = await listTemplates(d, as(out));
    expect(outView.ok && outView.value.templates).toHaveLength(0);
    expect(await updateTemplate(d, as(mgr), shared.value.id, { teamId: null })).toMatchObject({ ok: true, value: { scope: "personal" } });
    expect((await listTemplates(d, as(ag))).ok && ((await listTemplates(d, as(ag))) as { value: { templates: unknown[] } }).value.templates).toHaveLength(0);
    expect(await deleteTemplate(d, as(mgr), shared.value.id)).toMatchObject({ ok: true });
  });
});
