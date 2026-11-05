import * as Notifications from "expo-notifications";
import { Stack, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef } from "react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "../src/auth";
import { hrefFor, routeForLink } from "../src/lib/links";
import { pushData, reportOpened } from "../src/push";
import { Loading } from "../src/ui/kit";
import { useColors } from "../src/ui/theme";

function Navigator() {
  const { state, api } = useAuth();
  const c = useColors();
  const router = useRouter();
  const lastResponse = Notifications.useLastNotificationResponse();
  const handled = useRef<string | null>(null);

  // A tapped push opens the matching screen once the user is signed in (a cold start waits for the keychain read).
  useEffect(() => {
    if (state.status !== "signedIn" || !lastResponse) return;
    const key = lastResponse.notification.request.identifier;
    if (handled.current === key || lastResponse.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    handled.current = key;
    const { id, link } = pushData(lastResponse.notification);
    reportOpened(api, id);
    router.push(hrefFor(routeForLink(link)) as never);
  }, [api, lastResponse, router, state.status]);

  if (state.status === "loading") return <Loading />;
  const signedIn = state.status === "signedIn";
  return (
    <Stack screenOptions={{ headerStyle: { backgroundColor: c.surface }, headerTintColor: c.text, contentStyle: { backgroundColor: c.bg } }}>
      <Stack.Protected guard={state.status === "signedOut"}>
        <Stack.Screen name="sign-in" options={{ headerShown: false }} />
      </Stack.Protected>
      <Stack.Protected guard={state.status === "mfa"}>
        <Stack.Screen name="mfa" options={{ title: "Confirm it's you" }} />
      </Stack.Protected>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="listing/[id]" options={{ title: "Property" }} />
        <Stack.Screen name="messages/[id]" options={{ title: "Messages" }} />
      </Stack.Protected>
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <AuthProvider>
        <StatusBar style="auto" />
        <Navigator />
      </AuthProvider>
    </SafeAreaProvider>
  );
}
