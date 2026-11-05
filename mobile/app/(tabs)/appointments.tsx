import { useRouter } from "expo-router";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useAuth, useUser } from "../../src/auth";
import { shortDateTime } from "../../src/lib/format";
import { useLoad } from "../../src/use-load";
import { Card, Empty, ErrorState, Loading, Muted, Title } from "../../src/ui/kit";
import { font, space, useColors } from "../../src/ui/theme";

/** One row: an agent appointment on a listing, seen by the owner or by the agent. */
interface Row { id: string; kind: "invite" | "appointment"; listingId: string; listingTitle: string; counterpart: string; since: string; licensed: boolean }

interface AgentItem { kind: "invite" | "appointment"; id: string; listingId: string; listingTitle: string; ownerName: string; since: string; licensed: boolean }
interface OwnerListing { id: string; title: string; status: string }
interface OwnerAgentView {
  active: { id: string; listingId: string; agentName: string; appointedAt: string; licensed: boolean } | null;
  invites: { id: string; agentName: string; createdAt?: string; licensed: boolean }[];
}

/**
 * Agents: their invitations and active appointments (GET /api/agent/appointments). Owners: the agent appointed on each of their
 * listings (GET /api/listings/mine, then /api/listings/{id}/agent-appointments). Accepting or sending invitations stays on the website.
 */
async function loadRows(api: ReturnType<typeof useAuth>["api"], userType: string): Promise<Row[]> {
  if (userType === "agent") {
    const r = await api.get<{ items: AgentItem[] }>("/api/agent/appointments");
    return r.items.map(i => ({ id: i.id, kind: i.kind, listingId: i.listingId, listingTitle: i.listingTitle, counterpart: i.ownerName, since: i.since, licensed: i.licensed }));
  }
  const mine = await api.get<{ listings: OwnerListing[] }>("/api/listings/mine");
  const views = await Promise.all(mine.listings.map(async l => ({ l, v: await api.get<OwnerAgentView>(`/api/listings/${l.id}/agent-appointments`).catch(() => null) })));
  const rows: Row[] = [];
  for (const { l, v } of views) {
    if (v?.active) rows.push({ id: v.active.id, kind: "appointment", listingId: l.id, listingTitle: l.title, counterpart: v.active.agentName, since: v.active.appointedAt, licensed: v.active.licensed });
    for (const i of v?.invites ?? []) rows.push({ id: i.id, kind: "invite", listingId: l.id, listingTitle: l.title, counterpart: i.agentName, since: i.createdAt ?? "", licensed: i.licensed });
  }
  return rows;
}

export default function Appointments() {
  const { api } = useAuth();
  const user = useUser();
  const router = useRouter();
  const c = useColors();
  const { data, error, loading, refreshing, reload, refresh } = useLoad(() => loadRows(api, user.userType), [api, user.userType]);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  return (
    <FlatList
      data={data ?? []}
      keyExtractor={r => `${r.kind}:${r.id}`}
      contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      renderItem={({ item }) => (
        <Card
          label={`${item.listingTitle}, ${item.kind === "invite" ? "invitation" : "appointment"} with ${item.counterpart}`}
          {...(item.kind === "appointment" ? { onPress: () => router.push(`/messages/${item.id}`) } : {})}
        >
          <View style={s.row}>
            <Text style={[s.badge, { color: item.kind === "invite" ? c.accent : c.success }]}>{item.kind === "invite" ? "Invitation" : "Appointed"}</Text>
            {item.since ? <Text style={[s.date, { color: c.muted }]}>{shortDateTime(item.since)}</Text> : null}
          </View>
          <Title>{item.listingTitle}</Title>
          <Muted>{user.userType === "agent" ? `Owner: ${item.counterpart}` : `Agent: ${item.counterpart}`}{item.licensed ? "" : " · licence not verified"}</Muted>
          {item.kind === "appointment" ? <Text style={[s.link, { color: c.primary }]}>Open messages ›</Text> : <Muted>Answer this invitation on the website.</Muted>}
        </Card>
      )}
      ListEmptyComponent={<Empty title="No appointments" hint={user.userType === "agent" ? "Invitations from owners will show here." : "Appoint an agent from a listing on the website."} />}
    />
  );
}

const s = StyleSheet.create({
  list: { padding: space.lg, width: "100%", maxWidth: 720, alignSelf: "center", flexGrow: 1 },
  row: { flexDirection: "row", justifyContent: "space-between", marginBottom: space.xs },
  badge: { fontSize: font.small, fontWeight: "700", textTransform: "uppercase" },
  date: { fontSize: font.small },
  link: { fontSize: font.body, fontWeight: "600", marginTop: space.sm }
});
