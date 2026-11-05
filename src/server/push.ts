import { type Category, type RenderedNotification } from "../domain/notifications";
import { buildPushMessage, inQuietHours, personalizePush } from "../domain/push";
import type { Queryable } from "./db";
import { activeTargetsPg, createDeliveryPg, displayNamePg, getPushPreferencesPg, revokeDeviceByIdPg, setDeliveryStatusPg, unreadInCategoryPg, userClickRatePg } from "./push-db";
import { getPushPorts, type PushPorts, type PushTransports } from "./push-senders";

type Env = Readonly<Record<string, string | undefined>>;
export interface PushResult { status: "sent" | "skipped" | "failed"; sent: number; failed: number; reason?: "topic_off" | "quiet_hours" | "no_devices" | "not_configured" }
export interface PushDeps { ports?: PushPorts; transports?: PushTransports; now?: () => Date }

let shared: PushPorts | null = null;
const portsFor = (env: Env, deps: PushDeps): PushPorts => {
  if (deps.ports) return deps.ports;
  if (env !== process.env || deps.transports) return getPushPorts(env, deps.transports);
  return (shared ??= getPushPorts(env)); // keeps the FCM and APNs tokens between sends
};

/**
 * Pushes one notification to the user's phones and browsers, if the topic is on, it is not quiet hours, and a device is registered.
 * Elena rewrites the text for this person (first name, how many are waiting); each attempt is logged for engagement figures.
 * Gone devices (uninstalled, permission withdrawn) are retired. Never throws: a push must not block the action that caused it.
 */
export async function pushToUser(db: Queryable, userId: string, kind: string, n: RenderedNotification, notificationId: string | null, env: Env = process.env, deps: PushDeps = {}): Promise<PushResult> {
  const out: PushResult = { status: "skipped", sent: 0, failed: 0 };
  try {
    const now = (deps.now ?? (() => new Date()))().toISOString();
    const category: Category = n.category;
    const ports = portsFor(env, deps);
    if (!ports.web.configured && !ports.android.configured && !ports.ios.configured) return { ...out, reason: "not_configured" };
    if (!(await getPushPreferencesPg(db, userId))[category]) return { ...out, reason: "topic_off" };
    if (inQuietHours(category, now)) return { ...out, reason: "quiet_hours" };
    const targets = (await activeTargetsPg(db, userId)).filter(t => ports[t.platform].configured);
    if (targets.length === 0) return { ...out, reason: "no_devices" };

    const [name, unread, rate] = await Promise.all([displayNamePg(db, userId), unreadInCategoryPg(db, userId, category), userClickRatePg(db, userId)]);
    const text = personalizePush(n, { firstName: name, unreadInTopic: unread, clickRate: rate });
    for (const t of targets) {
      const deliveryId = await createDeliveryPg(db, { userId, deviceId: t.id, notificationId, platform: t.platform, kind, category, personalized: text.personalized });
      const r = await ports[t.platform].send(t, buildPushMessage(deliveryId, text.title, text.body, n.link, category));
      await setDeliveryStatusPg(db, deliveryId, r.status);
      if (r.status === "sent") out.sent++; else out.failed++;
      if (r.status === "gone") await revokeDeviceByIdPg(db, t.id);
    }
    out.status = out.sent > 0 ? "sent" : "failed";
  } catch {
    out.status = "failed";
  }
  return out;
}
