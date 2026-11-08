import { API_USER_TYPES, type ApiScope } from "../../domain/api-keys";
import { getActor, getDb } from "../context";
import { csrfGuard } from "../csrf";
import { unauthenticated } from "../http";
import { withClient } from "./api-client-auth";
import { NextResponse } from "next/server";

/**
 * Developer routes can be called by an API key (Authorization: Bearer, needs `scope`) or by the signed-in owner/agent from the
 * dashboard (session cookie, CSRF-checked on writes). Either way the user id comes from the credential, never from the request.
 */
export async function withPrincipal(req: Request, scope: ApiScope, handler: (userId: string) => Promise<Response>): Promise<Response> {
  if (req.headers.has("authorization")) return withClient(getDb(), req, scope, c => handler(c.userId));
  const blocked = csrfGuard(req, { json: false });
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  if (!API_USER_TYPES.includes(actor.userType)) return NextResponse.json({ error: "API access is for owners and agents." }, { status: 403 });
  return handler(actor.userId);
}
