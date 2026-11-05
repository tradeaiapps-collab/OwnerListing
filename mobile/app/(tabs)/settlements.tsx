import { useRouter } from "expo-router";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../src/auth";
import { stageLine, type SettlementLite } from "../../src/lib/agent-today";
import { SyncBanner, useCachedLoad } from "../../src/offline";
import { Card, Empty, ErrorState, Loading, Muted, Title } from "../../src/ui/kit";
import { font, space, useColors } from "../../src/ui/theme";

interface Row extends SettlementLite { doneStages: number; totalStages: number }

/** Settlements the person is part of, stuck ones first. Works offline from the last saved copy. */
export default function Settlements() {
  const { api } = useAuth();
  const router = useRouter();
  const c = useColors();
  const { data, stale, savedAt, error, loading, refreshing, reload, refresh } = useCachedLoad("settlements", async () => (await api.get<{ settlements: Row[] }>("/api/settlements")).settlements);
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  return (
    <View style={{ flex: 1 }}>
      <SyncBanner stale={stale} savedAt={savedAt} />
      <FlatList
        data={data ?? []}
        keyExtractor={r => r.id}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        renderItem={({ item }) => (
          <Card highlight={item.stuck.stuck} onPress={() => router.push(`/settlement/${item.id}`)} label={`${item.listingTitle}. ${stageLine(item)}`}>
            <Title>{item.listingTitle}</Title>
            <Text style={[s.stage, { color: item.stuck.stuck || item.fellThrough ? c.danger : c.muted }]}>{stageLine(item)}</Text>
            <Muted>{item.doneStages} of {item.totalStages} stages done{item.nextTarget ? ` · next target ${item.nextTarget}` : ""}</Muted>
          </Card>
        )}
        ListEmptyComponent={<Empty title="No settlements yet" hint="An accepted offer is tracked here once the owner or agent starts its settlement." />}
      />
    </View>
  );
}
const s = StyleSheet.create({
  list: { padding: space.lg, width: "100%", maxWidth: 720, alignSelf: "center", flexGrow: 1 },
  stage: { fontSize: font.body, fontWeight: "600", marginVertical: space.xs }
});
