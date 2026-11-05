import * as Linking from "expo-linking";
import { Stack, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Image, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { apiUrl, useAuth, useUser } from "../../src/auth";
import { formatPrice, roomsLine } from "../../src/lib/format";
import { messageOf, useLoad } from "../../src/use-load";
import { Body, Button, Card, ErrorState, Loading, Muted } from "../../src/ui/kit";
import { font, space, useColors } from "../../src/ui/theme";

interface Listing {
  id: string; title: string; address: string; transactionType: "sale" | "rent"; propertyType: string; description?: string;
  suburb?: string; postcode?: string; priceCents?: number; bedrooms?: number; bathrooms?: number; parking?: number; amenities?: string[];
}

interface Photo { id: string; kind: string; width: number; height: number; caption?: string; alt?: string; hidden?: boolean; sizes: string[] }

/** Phone-sized copy when the server made one, else the original. */
const photoSrc = (p: Photo) => `${apiUrl}/api/photos/${p.id}${p.sizes.includes("medium") ? "?size=medium" : ""}`;

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
  const { width } = useWindowDimensions();
  const photoWidth = Math.min(width, 720) - 2 * space.lg;
  const valid = typeof id === "string" && UUID.test(id);
  const { data, error, loading, reload } = useLoad(async () => {
    if (!valid) throw new Error("bad id");
    const [l, photos, saved] = await Promise.all([
      api.get<{ listing: Listing }>(`/api/listings/${id}`),
      api.get<{ photos: Photo[] }>(`/api/listings/${id}/photos`).catch(() => ({ photos: [] as Photo[] })),
      user.userType === "buyer" ? api.get<{ listings: { listingId: string }[] }>("/api/buyer/saved-listings").catch(() => null) : Promise.resolve(null)
    ]);
    return { listing: l.listing, photos: photos.photos.filter(p => p.kind === "photo" && !p.hidden), saved: saved ? saved.listings.some(s => s.listingId === id) : false };
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
      {data.photos.length ? (
        <ScrollView horizontal pagingEnabled showsHorizontalScrollIndicator={false} style={s.gallery} accessibilityLabel={`${data.photos.length} photos`}>
          {data.photos.map((p, i) => (
            <Image key={p.id} source={{ uri: photoSrc(p) }} accessibilityLabel={p.alt || p.caption || `Photo ${i + 1}`}
              style={{ width: photoWidth, height: Math.round(photoWidth * 0.62), borderRadius: 10, marginRight: i < data.photos.length - 1 ? space.sm : 0, backgroundColor: c.border }} />
          ))}
        </ScrollView>
      ) : null}
      <Text style={[s.price, { color: c.text }]}>{formatPrice(l.priceCents, l.transactionType)}</Text>
      <Text style={[s.title, { color: c.text }]} accessibilityRole="header">{l.title}</Text>
      <Muted>{l.address}</Muted>
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
  actions: { marginVertical: space.lg },
  gallery: { marginBottom: space.lg, flexGrow: 0 }
});
