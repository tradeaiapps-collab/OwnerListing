import { useRouter } from "expo-router";
import { FlatList, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../src/auth";
import { shortDateTime } from "../../src/lib/format";
import { hrefFor, routeForLink } from "../../src/lib/links";
import { useLoad } from "../../src/use-load";
import { Button, Card, Empty, ErrorState, Loading, Muted, Title } from "../../src/ui/kit";
import { font, space, useColors } from "../../src/ui/theme";

interface Item { id: string; title: string; body: string; link: string | null; createdAt: string; readAt: string | null }
interface Page { notifications: Item[]; nextBefore: string | null; unread: number }

/** The notification centre (the same list as the website's bell). Tapping one marks it read and opens its screen. */
export default function Notifications() {
  const { api } = useAuth();
  const router = useRouter();
  const c = useColors();
  const { data, setData, error, loading, refreshing, reload, refresh } = useLoad(() => api.get<Page>("/api/notifications?status=inbox&limit=50"), [api]);

  const markRead = async (body: { ids: string[] } | { all: true }) => {
    try {
      const r = await api.post<{ unread: number }>("/api/notifications/read", body);
      setData(d => d && {
        ...d, unread: r.unread,
        notifications: d.notifications.map(n => ("all" in body || body.ids.includes(n.id)) && !n.readAt ? { ...n, readAt: new Date().toISOString() } : n)
      });
    } catch { /* the list still shows; it is marked next time */ }
  };

  const open = (n: Item) => {
    if (!n.readAt) void markRead({ ids: [n.id] });
    if (n.link) router.push(hrefFor(routeForLink(n.link)) as never);
  };

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  return (
    <FlatList
      data={data?.notifications ?? []}
      keyExtractor={n => n.id}
      contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      ListHeaderComponent={data && data.unread > 0 ? (
        <View style={s.head}>
          <Text style={[s.count, { color: c.muted }]}>{data.unread} unread</Text>
          <Button title="Mark all read" kind="secondary" onPress={() => void markRead({ all: true })} />
        </View>
      ) : undefined}
      renderItem={({ item }) => (
        <Card onPress={() => open(item)} highlight={!item.readAt} label={`${item.readAt ? "" : "Unread. "}${item.title}`}>
          <Text style={[s.date, { color: c.muted }]}>{shortDateTime(item.createdAt)}</Text>
          <Title>{item.title}</Title>
          <Muted lines={3}>{item.body}</Muted>
        </Card>
      )}
      ListEmptyComponent={<Empty title="You're all caught up" hint="Messages, offers and listing updates will show here." />}
    />
  );
}

const s = StyleSheet.create({
  list: { padding: space.lg, width: "100%", maxWidth: 720, alignSelf: "center", flexGrow: 1 },
  head: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginBottom: space.md },
  count: { fontSize: font.body },
  date: { fontSize: font.small, marginBottom: space.xs }
});
