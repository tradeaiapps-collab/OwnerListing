import { NextResponse } from "next/server";
import { brandInputOf, buildTenantSettings, platformHostsFrom, verifyRecordName, verifyRecordValue } from "../../../../src/domain/white-label";
import { getDb } from "../../../../src/server/context";
import { readBoundedJson, NO_STORE } from "../../../../src/server/site-route";
import { getTenantForTeam, saveBrand, type TenantRow } from "../../../../src/server/white-label-db";
import { managerGate } from "../../../../src/server/white-label-route";
import { withApi } from "../../../../src/server/api/with-api";

export const tenantJson = (t: TenantRow | null) => t && ({
  id: t.id, status: t.status, brand: brandInputOf(t.settings), hasLogo: t.logoLightId !== null, hasFavicon: t.faviconId !== null,
  logoUrl: t.logoLightId ? `/api/agency/white-label/asset?teamId=${t.teamId}&slot=logo-light&v=${t.logoLightId}` : null,
  domains: t.domains.map(d => ({
    host: d.host, verified: d.verifiedAt !== null,
    // The TXT record the agency adds at its DNS provider to prove it controls the host.
    dns: d.verifiedAt ? null : { type: "TXT", name: verifyRecordName(d.host), value: verifyRecordValue(d.verifyToken) },
    cname: platformHostsFrom()[0] ?? null
  }))
});

/** GET ?teamId=: the team's white-label brand and domains (null before it is set up). PUT { teamId, name, tagline, primary, secondary, footerText }: create or update the brand. */
async function handleGet(req: Request) {
  const gate = await managerGate(req, new URL(req.url).searchParams.get("teamId"));
  if (gate instanceof NextResponse) return gate;
  return NextResponse.json({ tenant: tenantJson(await getTenantForTeam(getDb(), gate.teamId)) }, { headers: NO_STORE });
}

async function handlePut(req: Request) {
  const body = await readBoundedJson(req, 16 * 1024);
  if (body instanceof NextResponse) return body;
  const gate = await managerGate(req, body["teamId"]);
  if (gate instanceof NextResponse) return gate;
  const built = buildTenantSettings(body);
  if (!built.ok) return NextResponse.json({ error: "Some brand settings need fixing.", errors: built.errors }, { status: 400, headers: NO_STORE });
  const db = getDb();
  const saved = await saveBrand(db, gate.teamId, gate.userId, built.settings);
  const message = saved.resetToDraft ? "Saved. A new name needs platform approval again before it goes live." : saved.status === "active" ? "Saved. Your brand is live." : "Saved. Add a domain and ask the platform team to approve your brand.";
  return NextResponse.json({ tenant: tenantJson(await getTenantForTeam(db, gate.teamId)), message }, { headers: NO_STORE });
}

export const GET = withApi(handleGet);
export const PUT = withApi(handlePut);
