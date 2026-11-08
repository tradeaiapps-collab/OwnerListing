import { useRouter } from "expo-router";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useAuth, useUser } from "../../src/auth";
import { pendingActions, type BookingLite, type OfferLite, type Pending, type SettlementLite } from "../../src/lib/agent-today";
import { SyncBanner, useCachedLoad } from "../../src/offline";
import { Card, Empty, ErrorState, Loading, Muted, Title } from "../../src/ui/kit";
import { font, space, useColors } from "../../src/ui/theme";

interface ListingRef { id: string; title: string; status: string }
interface Today { listings: ListingRef[]; pending: Pending[]; activeSettlements: number }

/** Today: what needs a decision or a tap, then my listings. Agents see the listings they are appointed to; owners their own. */
export default function TodayScreen() {
  const { api } = useAuth();
  const user = useUser();
  const router = useRouter();
  const c = useColors();
  const { data, stale, savedAt, error, loading, refreshing, reload, refresh } = useCachedLoad<Today>("today", async () => {
    const listings: ListingRef[] = user.userType === "agent"
      ? (await api.get<{ listings: { listingId: string; title: string; status: string }[] }>("/api/agent/listings")).listings.map(l => ({ id: l.listingId, title: l.title, status: l.status }))
      : (await api.get<{ listings: ListingRef[] }>("/api/listings/mine")).listings;
    const [settlements, bookings, offers] = await Promise.all([
      api.get<{ settlements: SettlementLite[] }>("/api/settlements"),
      api.get<{ bookings: BookingLite[] }>("/api/agent/open-inspections").catch(() => ({ bookings: [] as BookingLite[] })),
      Promise.all(listings.map(async l => ({ listingId: l.id, title: l.title, offers: (await api.get<{ offers: OfferLite[] }>(`/api/listings/${l.id}/offers`).catch(() => ({ offers: [] as OfferLite[] }))).offers })))
    ]);
    return {
      listings,
      activeSettlements: settlements.settlements.filter(s => !s.completed && !s.fellThrough).length,
      pending: pendingActions({ offers, settlements: settlements.settlements, bookings: bookings.bookings, now: new Date() })
    };
  }, [user.userType]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  const d = data!;
  const open = (p: Pending) => router.push(p.kind === "offer" ? `/listing-offers/${p.listingId}` : p.kind === "settlement" ? `/settlement/${p.settlementId}` : "/inspections");

  return (
    <View style={{ flex: 1 }}>
      <SyncBanner stale={stale} savedAt={savedAt} />
      <FlatList
        data={d.pending}
        keyExtractor={p => p.key}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        ListHeaderComponent={
          <View style={s.stats}>
            <Stat n={d.listings.length} label="Listings" />
            <Stat n={d.activeSettlements} label="Settlements" />
            <Stat n={d.pending.length} label="Need action" />
          </View>
        }
        renderItem={({ item }) => (
          <Card highlight onPress={() => open(item)} label={`${item.title}. ${item.detail}`}>
            <Text style={[s.kind, { color: c.accent }]}>{item.kind === "offer" ? "Offer" : item.kind === "settlement" ? "Settlement" : "Inspection"}</Text>
            <Title>{item.title}</Title>
            <Muted>{item.detail}</Muted>
          </Card>
        )}
        ListEmptyComponent={<Empty title="Nothing needs you right now" hint="New offers, stuck settlements and finished inspections show here." />}
        ListFooterComponent={
          (
            <View>
              <Text style={[s.section, { color: c.text }]}>My listings</Text>
              {d.listings.map(l => (
                <Card key={l.id} onPress={() => router.push(`/listing-offers/${l.id}`)} label={`${l.title}, offers`}>
                  <Title>{l.title}</Title>
                  <Muted>{l.status} · offers ›</Muted>
                </Card>
              ))}
              <Card onPress={() => router.push("/notifications")} label="Alerts"><Title>Alerts</Title><Muted>Recent notifications ›</Muted></Card>
            </View>
          )
        }
      />
    </View>
  );
}

function Stat({ n, label }: { n: number; label: string }) {
  const c = useColors();
  return (
    <View style={[s.stat, { backgroundColor: c.surface, borderColor: c.border }]} accessible accessibilityLabel={`${n} ${label}`}>
      <Text style={[s.statN, { color: c.text }]}>{n}</Text>
      <Text style={[s.statL, { color: c.muted }]} numberOfLines={1}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  list: { padding: space.lg, width: "100%", maxWidth: 720, alignSelf: "center", flexGrow: 1 },
  stats: { flexDirection: "row", gap: space.sm, marginBottom: space.lg },
  stat: { flex: 1, borderWidth: 1, borderRadius: 10, padding: space.md, alignItems: "center" },
  statN: { fontSize: font.heading, fontWeight: "700" },
  statL: { fontSize: font.small },
  kind: { fontSize: font.small, fontWeight: "700", textTransform: "uppercase", marginBottom: space.xs },
  section: { fontSize: font.title, fontWeight: "700", marginTop: space.xl, marginBottom: space.sm }
});
