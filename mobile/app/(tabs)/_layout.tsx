import { Tabs } from "expo-router";
import { Text, type ColorValue } from "react-native";
import { useUser } from "../../src/auth";
import { useColors } from "../../src/ui/theme";

const icon = (glyph: string) => ({ color }: { color: ColorValue }) => <Text style={{ color, fontSize: 18 }} accessibilityElementsHidden>{glyph}</Text>;

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
      <Tabs.Screen name="index" options={{ title: "Search", tabBarIcon: icon("⌕") }} />
      <Tabs.Screen name="saved" options={{ title: "Saved", tabBarIcon: icon("♡"), href: buyer ? "/saved" : null }} />
      <Tabs.Screen name="appointments" options={{ title: "Appointments", tabBarIcon: icon("☰"), href: buyer ? null : "/appointments" }} />
      <Tabs.Screen name="notifications" options={{ title: "Alerts", tabBarIcon: icon("◔") }} />
      <Tabs.Screen name="account" options={{ title: "Account", tabBarIcon: icon("◉") }} />
    </Tabs>
  );
}
