import { NextResponse } from "next/server";
import { parseDeviceInput } from "../../../../src/domain/push";
import { getActor, getDb } from "../../../../src/server/context";
import { csrfGuard } from "../../../../src/server/csrf";
import { unauthenticated } from "../../../../src/server/http";
import { failure } from "../../../../src/server/http";
import { listDevicesPg, registerDevicePg, revokeDevicePg } from "../../../../src/server/push-db";
import { getPushPorts, webPublicKey } from "../../../../src/server/push-senders";
import { withApi } from "../../../../src/server/api/with-api";
import { mobileSessionIdOf } from "../../../../src/server/auth/mobile-token";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in user's devices, and which platforms the server can push to (the browser needs `webPublicKey` to subscribe). */
async function handleGet(req: Request) {
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const ports = getPushPorts();
  return NextResponse.json({ devices: await listDevicesPg(getDb(), actor.userId), platforms: { web: ports.web.configured, android: ports.android.configured, ios: ports.ios.configured }, webPublicKey: webPublicKey(process.env) });
}

/**
 * Registers this phone or browser. Body: { platform: "web", subscription: { endpoint, keys: { p256dh, auth } }, label? }
 * or { platform: "android" | "ios", token, label? } from the mobile app. Registering again with the same token refreshes it.
 */
async function handlePost(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const parsed = parseDeviceInput(await req.json().catch(() => null));
  if (!parsed.ok) return failure(parsed);
  return NextResponse.json({ id: await registerDevicePg(getDb(), actor.userId, parsed.value, mobileSessionIdOf(req)) }, { status: 201 });
}

/** Body: { id }. Removes one of the user's own devices. */
async function handleDelete(req: Request) {
  const blocked = csrfGuard(req);
  if (blocked) return blocked;
  const actor = await getActor(req);
  if (!actor) return unauthenticated();
  const b = (await req.json().catch(() => null)) as { id?: unknown } | null;
  if (typeof b?.id !== "string" || !UUID.test(b.id)) return NextResponse.json({ error: "Send { id }." }, { status: 400 });
  return (await revokeDevicePg(getDb(), actor.userId, b.id)) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Device not found." }, { status: 404 });
}

export const GET = withApi(handleGet);
export const POST = withApi(handlePost);
export const DELETE = withApi(handleDelete);
