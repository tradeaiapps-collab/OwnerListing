import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs } from "expo-router";
import type { ColorValue } from "react-native";
import { useUser } from "../../src/auth";
import { useColors } from "../../src/ui/theme";

type IconName = keyof typeof Ionicons.glyphMap;
const icon = (name: IconName) => ({ color, size }: { color: ColorValue; size: number }) => <Ionicons name={name} size={size} color={color as string} />;

/** Buyers get Saved; owners and agents get Today, Settlements, Inspections and Messages (their agent appointments and the messages in them); Alerts open from Today. */
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
      <Tabs.Screen name="today" options={{ title: "Today", tabBarIcon: icon("today-outline"), href: buyer ? null : "/today" }} />
      <Tabs.Screen name="settlements" options={{ title: "Settlements", tabBarIcon: icon("git-branch-outline"), href: buyer ? null : "/settlements" }} />
      <Tabs.Screen name="inspections" options={{ title: "Inspections", tabBarIcon: icon("calendar-outline"), href: buyer ? null : "/inspections" }} />
      <Tabs.Screen name="index" options={{ title: "Search", tabBarIcon: icon("search"), href: buyer ? "/" : null }} />
      <Tabs.Screen name="saved" options={{ title: "Saved", tabBarIcon: icon("heart-outline"), href: buyer ? "/saved" : null }} />
      <Tabs.Screen name="appointments" options={{ title: "Messages", tabBarIcon: icon("chatbubbles-outline"), href: buyer ? null : "/appointments" }} />
      <Tabs.Screen name="notifications" options={{ title: "Alerts", tabBarIcon: icon("notifications-outline"), href: buyer ? "/notifications" : null }} />
      <Tabs.Screen name="account" options={{ title: "Account", tabBarIcon: icon("person-circle-outline") }} />
    </Tabs>
  );
}
