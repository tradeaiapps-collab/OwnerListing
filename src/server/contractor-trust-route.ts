import { NextResponse } from "next/server";
import type { ContentCategory, ContentSource } from "../domain/content-filter";
import type { Actor } from "../domain/listing-service";
import { guardContent } from "./content-guard";
import { createPgContentFlagStore } from "./content-flag-db";
import { getActor, getDb } from "./context";
import { csrfGuard } from "./csrf";

/** Shared start of the contractor trust and safety routes. Ids of the acting user always come from the session. */
export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const err = (status: number, error: string) => NextResponse.json({ error }, { status });

/** Signed-in user, with CSRF checked on writes. `contractor: true` also requires a vendor or agent account. */
export async function sessionActor(req: Request, o: { write?: boolean; contractor?: boolean } = {}): Promise<Actor | NextResponse> {
  if (o.write) { const blocked = csrfGuard(req); if (blocked) return blocked; }
  const actor = await getActor(req);
  if (!actor) return err(401, "Sign in required.");
  if (o.contractor && actor.userType !== "vendor" && actor.userType !== "agent") return err(403, "Only contractor accounts can do this.");
  return actor;
}

export const readBody = (req: Request) => req.json().catch(() => null) as Promise<unknown>;

/** Runs the content filter over text the user wrote. Returns the refusal response, or the `after` callback to call once stored. */
export async function guardText(
  userId: string, subjectType: string, fields: Record<string, string>, o: { source?: ContentSource; ignore?: readonly ContentCategory[] } = {}
): Promise<{ response: NextResponse } | { after: (subjectId: string) => Promise<void> }> {
  const g = await guardContent(createPgContentFlagStore(getDb()), { source: o.source ?? "message", subjectType, userId, fields, ...(o.ignore ? { ignore: o.ignore } : {}) });
  return g.ok ? { after: g.after } : { response: err(400, g.message) };
}
