import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { hostProblem, normaliseHost, platformHostsFrom } from "../../../../../src/domain/white-label";
import { getDb } from "../../../../../src/server/context";
import { NO_STORE, readBoundedJson } from "../../../../../src/server/site-route";
import { fail } from "../../../../../src/server/staff-route";
import { dnsVerified, clearTenantCache } from "../../../../../src/server/white-label";
import { addDomain, getTenantForTeam, markVerified, removeDomain } from "../../../../../src/server/white-label-db";
import { managerGate } from "../../../../../src/server/white-label-route";
import { withApi } from "../../../../../src/server/api/with-api";
import { tenantJson } from "../route";

async function load(req: Request) {
  const body = await readBoundedJson(req, 4 * 1024);
  if (body instanceof NextResponse) return body;
  const gate = await managerGate(req, body["teamId"]);
  if (gate instanceof NextResponse) return gate;
  const host = normaliseHost(body["host"]);
  if (!host) return fail(400, "Enter a domain name such as homes.youragency.com.au (no https://, path or port).");
  const t = await getTenantForTeam(getDb(), gate.teamId);
  if (!t) return fail(409, "Save the brand name and colours first.");
  return { gate, host, t, body };
}
const done = async (teamId: string, message: string, status = 200) => {
  clearTenantCache();
  return NextResponse.json({ tenant: tenantJson(await getTenantForTeam(getDb(), teamId)), message }, { status, headers: NO_STORE });
};

/** POST { teamId, host }: connect a domain. It is unused until the DNS TXT record shown in the response is found (PUT). */
async function handlePost(req: Request) {
  const x = await load(req);
  if (x instanceof NextResponse) return x;
  const problem = hostProblem(x.host, platformHostsFrom());
  if (problem) return fail(400, problem);
  const r = await addDomain(getDb(), x.t.id, x.gate.userId, x.host, randomBytes(18).toString("base64url"));
  if (!r.ok) return fail(r.code === "taken" ? 409 : 400, r.error);
  return done(x.gate.teamId, "Domain added. Add the DNS record shown, then choose Check.", 201);
}

/** PUT { teamId, host }: look for the DNS TXT record; the domain is verified when it matches. */
async function handlePut(req: Request) {
  const x = await load(req);
  if (x instanceof NextResponse) return x;
  const d = x.t.domains.find(v => v.host === x.host);
  if (!d) return fail(404, "That domain is not connected to your agency.");
  if (d.verifiedAt) return done(x.gate.teamId, "Already verified.");
  if (!(await dnsVerified(x.host, d.verifyToken))) return fail(422, "We could not find the DNS record yet. DNS changes can take up to an hour; check the name and value, then try again.");
  await markVerified(getDb(), x.t.id, x.host, x.gate.userId);
  return done(x.gate.teamId, x.t.status === "active" ? "Verified. Your domain is live." : "Verified. Ask the platform team to approve your brand to go live.");
}

/** DELETE { teamId, host }: disconnect a domain at once. */
async function handleDelete(req: Request) {
  const x = await load(req);
  if (x instanceof NextResponse) return x;
  if (!(await removeDomain(getDb(), x.t.id, x.host, x.gate.userId))) return fail(404, "That domain is not connected to your agency.");
  return done(x.gate.teamId, "Domain removed.");
}

export const POST = withApi(handlePost);
export const PUT = withApi(handlePut);
export const DELETE = withApi(handleDelete);
