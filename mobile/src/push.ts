import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import type { ApiClient } from "./lib/api-client";

/**
 * Push for the phone app. The server (PR #166) sends straight to Google (FCM) and Apple (APNs), so the app registers the phone's own
 * native token, not an Expo push token: on Android getDevicePushTokenAsync gives the FCM registration token, on iPhone the APNs
 * device token (hex). POST /api/push/devices stores it against the signed-in user; registering again refreshes it.
 */

if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: true })
  });
}

/** Android needs its channels created before the first push arrives. Same split as the server's tags. */
async function androidChannels() {
  if (Platform.OS !== "android") return;
  await Notifications.setNotificationChannelAsync("default", { name: "General", importance: Notifications.AndroidImportance.DEFAULT });
  await Notifications.setNotificationChannelAsync("messages", { name: "Messages", importance: Notifications.AndroidImportance.HIGH });
  await Notifications.setNotificationChannelAsync("offers", { name: "Offers", importance: Notifications.AndroidImportance.HIGH });
}

/** Asks for permission (once) and registers this phone. Returns the device id, or null when push is off or unavailable. */
export async function registerForPush(api: ApiClient): Promise<string | null> {
  if (Platform.OS === "web" || !Device.isDevice) return null; // the web preview and simulators have no push token
  await androidChannels();
  let { status } = await Notifications.getPermissionsAsync();
  if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
  if (status !== "granted") return null;
  const platforms = await api.get<{ platforms: { android: boolean; ios: boolean } }>("/api/push/devices");
  const platform = Platform.OS === "ios" ? "ios" : "android";
  if (!platforms.platforms[platform]) return null; // the server has no keys for this platform yet
  const token = await Notifications.getDevicePushTokenAsync();
  const label = (Device.deviceName ?? Device.modelName ?? platform).slice(0, 80);
  const r = await api.post<{ id: string }>("/api/push/devices", { platform, token: String(token.data), label });
  return r.id;
}

export async function unregisterPush(api: ApiClient, deviceId: string | null): Promise<void> {
  if (deviceId) await api.del("/api/push/devices", { id: deviceId });
}

/** The delivery id and website link a push carries (FCM data or the APNs payload). */
export function pushData(n: Notifications.Notification): { id: string | null; link: string | null } {
  const d = (n.request.content.data ?? {}) as Record<string, unknown>;
  return { id: typeof d["id"] === "string" ? d["id"] : null, link: typeof d["link"] === "string" && d["link"] ? d["link"] : null };
}

/** Records that a push was opened (the engagement log on the server). No sign-in needed: the id is unguessable. */
export function reportOpened(api: ApiClient, deliveryId: string | null) {
  if (deliveryId) void api.post("/api/push/event", { id: deliveryId, event: "clicked" }).catch(() => undefined);
}
