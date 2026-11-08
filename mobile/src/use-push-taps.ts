import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useEffect, useRef } from "react";
import type { ApiClient } from "./lib/api-client";
import { hrefFor, routeForLink } from "./lib/links";
import { pushData, reportOpened } from "./push";

/** A tapped push opens the matching screen once the user is signed in (a cold start waits for the keychain read). */
export function usePushTaps(api: ApiClient, signedIn: boolean) {
  const router = useRouter();
  const lastResponse = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!signedIn || !lastResponse) return;
    const key = lastResponse.notification.request.identifier;
    if (handled.current === key || lastResponse.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    handled.current = key;
    const { id, link } = pushData(lastResponse.notification);
    reportOpened(api, id);
    router.push(hrefFor(routeForLink(link)) as never);
  }, [api, lastResponse, router, signedIn]);
}
