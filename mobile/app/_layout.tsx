import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider, useAuth } from "../src/auth";
import { OfflineProvider } from "../src/offline";
import { usePushTaps } from "../src/use-push-taps";
import { Loading } from "../src/ui/kit";
import { useColors } from "../src/ui/theme";

function Navigator() {
  const { state, api } = useAuth();
  const c = useColors();
  usePushTaps(api, state.status === "signedIn");

  if (state.status === "loading") return <Loading />;
  const signedIn = state.status === "signedIn";
  return (
    <OfflineProvider userId={state.status === "signedIn" ? state.user.id : null}>
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
        <Stack.Screen name="settlement/[id]" options={{ title: "Settlement" }} />
        <Stack.Screen name="listing-offers/[id]" options={{ title: "Offers" }} />
      </Stack.Protected>
    </Stack>
    </OfflineProvider>
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
