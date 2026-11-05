import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs } from "expo-router";
import type { ColorValue } from "react-native";
import { useUser } from "../../src/auth";
import { useColors } from "../../src/ui/theme";

type IconName = keyof typeof Ionicons.glyphMap;
const icon = (name: IconName) => ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={name} size={size} color={color as string} />;

/** Buyers get Saved; owners and agents get Appointments (their agent appointments and the messages in them). */
export default function TabsLayout() {
  const user = useUser();
  const c = useColors();
  const buyer = user.userType === "buyer";
  return (
    <Tabs screenOptions={{
      tabBarActiveTintColor: c.primary, tabBarInactiveTintColor: c.muted,
      tabBarStyle: { backgroundColor: c.surface, borderTopColor: c.border },
      headerStyle: { backgroundColor: c.surface }, headerTintColor: c.text, sceneStyle: { backgroundColor: c.bg }
    }}>
      <Tabs.Screen name="index" options={{ title: "Search", tabBarIcon: icon("search") }} />
      <Tabs.Screen name="saved" options={{ title: "Saved", tabBarIcon: icon("heart-outline"), href: buyer ? "/saved" : null }} />
      <Tabs.Screen name="appointments" options={{ title: "Appointments", tabBarIcon: icon("people-outline"), href: buyer ? null : "/appointments" }} />
      <Tabs.Screen name="notifications" options={{ title: "Alerts", tabBarIcon: icon("notifications-outline") }} />
      <Tabs.Screen name="account" options={{ title: "Account", tabBarIcon: icon("person-circle-outline") }} />
    </Tabs>
  );
}
