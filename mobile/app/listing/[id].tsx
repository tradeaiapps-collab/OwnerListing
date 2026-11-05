import * as Linking from "expo-linking";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { apiUrl, useAuth, useUser } from "../../src/auth";
import { formatPrice, roomsLine } from "../../src/lib/format";
import { messageOf, useLoad } from "../../src/use-load";
import { Body, Button, Card, ErrorState, Loading, Muted } from "../../src/ui/kit";
import { font, space, useColors } from "../../src/ui/theme";

interface Listing {
  id: string; title: string; address: string; transactionType: "sale" | "rent"; propertyType: string; description?: string;
  suburb?: string; postcode?: string; priceCents?: number; bedrooms?: number; bathrooms?: number; parking?: number; amenities?: string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One property (GET /api/listings/{id}). Buyers can save it. Enquiries, offers and inspections need the buyer's ID check, which runs
 * on the website, so those open the website.
 */
export default function ListingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useAuth();
  const user = useUser();
  const c = useColors();
  const valid = typeof id === "string" && UUID.test(id);
  const { data, error, loading, reload } = useLoad(async () => {
    if (!valid) throw new Error("bad id");
    const [l, saved] = await Promise.all([
      api.get<{ listing: Listing }>(`/api/listings/${id}`),
      user.userType === "buyer" ? api.get<{ listings: { listingId: string }[] }>("/api/buyer/saved-listings").catch(() => null) : Promise.resolve(null)
    ]);
    return { listing: l.listing, saved: saved ? saved.listings.some(s => s.listingId === id) : false };
  }, [api, id]);
  const [saved, setSaved] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  if (!valid) return <ErrorState message="This property link is not valid." />;
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorState message={error ?? "Not found."} onRetry={reload} />;
  const l = data.listing;
  const isSaved = saved ?? data.saved;

  const toggleSave = async () => {
    setBusy(true);
    setSaveError(null);
    try {
      if (isSaved) await api.del(`/api/buyer/saved-listings/${l.id}`);
      else await api.post("/api/buyer/saved-listings", { listingId: l.id });
      setSaved(!isSaved);
    } catch (e) {
      setSaveError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={s.wrap}>
      <Stack.Screen options={{ title: l.suburb ?? "Property" }} />
      <Text style={[s.price, { color: c.text }]}>{formatPrice(l.priceCents, l.transactionType)}</Text>
      <Text style={[s.title, { color: c.text }]} accessibilityRole="header">{l.title}</Text>
      <Muted>{[l.address, l.postcode].filter(Boolean).join(" ")}</Muted>
      {roomsLine(l) ? <Text style={[s.rooms, { color: c.text }]}>{roomsLine(l)}</Text> : null}
      {user.userType === "buyer" ? (
        <View style={s.actions}>
          <Button title={isSaved ? "Saved ✓  Remove" : "Save"} kind={isSaved ? "secondary" : "primary"} busy={busy} onPress={toggleSave} />
          {saveError ? <Text style={{ color: c.danger, marginTop: space.sm }}>{saveError}</Text> : null}
        </View>
      ) : null}
      {l.description ? <Card><Body>{l.description}</Body></Card> : null}
      {l.amenities?.length ? <Card><Muted>{l.amenities.join(" · ")}</Muted></Card> : null}
      <Button title="Enquire or make an offer on the website" kind="secondary" onPress={() => void Linking.openURL(`${apiUrl}/listings/${l.id}`)} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: space.lg, width: "100%", maxWidth: 720, alignSelf: "center" },
  price: { fontSize: font.heading, fontWeight: "800" },
  title: { fontSize: font.title, fontWeight: "700", marginVertical: space.xs },
  rooms: { fontSize: font.body, fontWeight: "600", marginTop: space.sm },
  actions: { marginVertical: space.lg }
});
