import { useState } from "react";
import { FlatList, Linking, RefreshControl, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../src/auth";
import { inspectionActions, type BookingLite } from "../../src/lib/agent-today";
import { shortDateTime } from "../../src/lib/format";
import { SyncBanner, useCachedLoad, useOffline } from "../../src/offline";
import { messageOf } from "../../src/use-load";
import { Button, Card, Empty, ErrorState, Loading, Muted, Title } from "../../src/ui/kit";
import { font, space, useColors } from "../../src/ui/theme";

interface Booking extends BookingLite { address: string; buyerPhone: string; notes: string }
const LABEL: Record<string, string> = { booked: "Booked", completed: "Completed", no_show: "No show", cancelled: "Cancelled" };

/** Open-inspection bookings on the listings I manage: call or remind the buyer, mark an inspection complete or a no-show (works offline). */
export default function Inspections() {
  const { api } = useAuth();
  const { act } = useOffline();
  const c = useColors();
  const { data, stale, savedAt, error, loading, refreshing, reload, refresh } = useCachedLoad("inspections", async () => (await api.get<{ bookings: Booking[] }>("/api/agent/open-inspections")).bookings);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;

  const change = async (b: Booking, action: "complete" | "no_show") => {
    setBusy(b.id); setNote(null);
    try {
      const r = await act({ kind: "inspection", path: "/api/agent/open-inspections", body: { ids: [b.id], action }, label: `${action === "complete" ? "Complete" : "No-show"}: ${b.title}` });
      setStatus(s => ({ ...s, [b.id]: action === "complete" ? "completed" : "no_show" }));
      if (r === "queued") setNote("Saved on this phone. It sends when you are back online.");
    } catch (e) { setNote(messageOf(e)); } finally { setBusy(null); }
  };
  const remind = async (b: Booking) => {
    setBusy(b.id); setNote(null);
    try { await api.post("/api/agent/open-inspections", { ids: [b.id], action: "remind" }); setNote(`Reminder sent to ${b.buyerName}.`); }
    catch (e) { setNote(messageOf(e)); } finally { setBusy(null); }
  };
  const now = new Date();
  const rows = (data ?? []).map(b => ({ ...b, status: status[b.id] ?? b.status }));

  return (
    <View style={{ flex: 1 }}>
      <SyncBanner stale={stale} savedAt={savedAt} />
      {note ? <Text style={[s.note, { color: c.text, backgroundColor: c.unread }]} accessibilityRole="alert">{note}</Text> : null}
      <FlatList
        data={rows}
        keyExtractor={b => b.id}
        contentContainerStyle={s.list}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
        renderItem={({ item }) => {
          const actions = inspectionActions(item, now);
          return (
            <Card>
              <Text style={[s.badge, { color: item.status === "booked" ? c.accent : c.muted }]}>{LABEL[item.status] ?? item.status}</Text>
              <Title>{item.title}</Title>
              <Muted>{shortDateTime(item.startsAt)} · {item.address}</Muted>
              <Muted>{item.buyerName}{item.buyerPhone ? ` · ${item.buyerPhone}` : ""}</Muted>
              {item.notes ? <Muted lines={3}>{item.notes}</Muted> : null}
              <View style={s.actions}>
                {item.buyerPhone ? <Button title="Call" kind="secondary" onPress={() => void Linking.openURL(`tel:${item.buyerPhone.replace(/[^\d+]/g, "")}`)} /> : null}
                {actions.includes("remind") ? <Button title="Send reminder" kind="secondary" busy={busy === item.id} onPress={() => void remind(item)} /> : null}
                {actions.includes("complete") ? <Button title="Mark complete" busy={busy === item.id} onPress={() => void change(item, "complete")} /> : null}
                {actions.includes("no_show") ? <Button title="No-show" kind="secondary" busy={busy === item.id} onPress={() => void change(item, "no_show")} /> : null}
              </View>
            </Card>
          );
        }}
        ListEmptyComponent={<Empty title="No inspections" hint="Bookings from buyers on your listings show here." />}
      />
    </View>
  );
}
const s = StyleSheet.create({
  list: { padding: space.lg, width: "100%", maxWidth: 720, alignSelf: "center", flexGrow: 1 },
  badge: { fontSize: font.small, fontWeight: "700", textTransform: "uppercase", marginBottom: space.xs },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.md },
  note: { padding: space.md, fontSize: font.small }
});
