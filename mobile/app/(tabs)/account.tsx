import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { useState } from "react";
import { Platform, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { apiUrl, useAuth, useUser } from "../../src/auth";
import { messageOf, useLoad } from "../../src/use-load";
import { Button, Card, ErrorState, Loading, Muted, Title } from "../../src/ui/kit";
import { font, space, useColors } from "../../src/ui/theme";

interface Topic { category: string; label?: string; text?: string; locked?: boolean }
interface Prefs { topics: Record<string, boolean>; catalogue: Topic[] }

const ROLE: Record<string, string> = { owner: "Owner", agent: "Agent", buyer: "Buyer" };

/** Push topics for this account (GET/PUT /api/push/preferences) and sign out. Everything else stays in Settings on the website. */
export default function Account() {
  const { api, signOut } = useAuth();
  const user = useUser();
  const c = useColors();
  const { data, setData, error, loading, reload } = useLoad(() => api.get<Prefs>("/api/push/preferences"), [api]);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);

  const toggle = async (category: string, on: boolean) => {
    if (!data) return;
    const before = data.topics;
    setData({ ...data, topics: { ...before, [category]: on } });
    try {
      await api.put("/api/push/preferences", { topics: { [category]: on } });
      setSaveError(null);
    } catch (e) {
      setData({ ...data, topics: before });
      setSaveError(messageOf(e));
    }
  };

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Card>
        <Title>Signed in</Title>
        <Muted>{ROLE[user.userType] ?? user.userType} account</Muted>
      </Card>
      <Text style={[s.h, { color: c.text }]} accessibilityRole="header">Push notifications</Text>
      {loading && !data ? <View style={s.box}><Loading /></View> : error && !data ? <View style={s.box}><ErrorState message={error} onRetry={reload} /></View> : (
        <Card>
          {(data?.catalogue ?? []).map((t, i) => (
            <View key={t.category} style={[s.pref, i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.border }]}>
              <View style={{ flex: 1, paddingRight: space.md }}>
                <Text style={[s.prefTitle, { color: c.text }]}>{t.label ?? t.category}</Text>
                {t.text ? <Muted>{t.text}</Muted> : null}
              </View>
              <Switch
                accessibilityLabel={`Push for ${t.label ?? t.category}`}
                value={t.locked ? true : data?.topics[t.category] ?? false}
                disabled={!!t.locked}
                onValueChange={v => void toggle(t.category, v)}
                trackColor={{ true: c.primary, false: c.border }}
                thumbColor="#ffffff"
                {...(Platform.OS === "web" ? { activeThumbColor: "#ffffff" } : {})}
              />
            </View>
          ))}
          {saveError ? <Text style={{ color: c.danger, marginTop: space.sm }}>{saveError}</Text> : null}
        </Card>
      )}
      <Button title="More settings on the website" kind="secondary" onPress={() => void Linking.openURL(`${apiUrl}/settings`)} />
      <View style={{ height: space.md }} />
      <Button title="Sign out" kind="danger" busy={leaving} onPress={async () => { setLeaving(true); await signOut(); }} />
      <Text style={[s.version, { color: c.muted }]}>Version {Constants.expoConfig?.version ?? "?"}</Text>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: space.lg, width: "100%", maxWidth: 720, alignSelf: "center" },
  h: { fontSize: font.title, fontWeight: "700", marginTop: space.md, marginBottom: space.sm },
  box: { minHeight: 160 },
  pref: { flexDirection: "row", alignItems: "center", paddingVertical: space.md },
  prefTitle: { fontSize: font.body, fontWeight: "600" },
  version: { fontSize: font.small, textAlign: "center", marginTop: space.xl }
});
