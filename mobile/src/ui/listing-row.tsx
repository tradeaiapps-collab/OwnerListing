import { Image, StyleSheet, Text } from "react-native";
import { apiUrl } from "../auth";
import { formatPrice, roomsLine } from "../lib/format";
import { Card, Muted, Title } from "./kit";
import { font, radius, space, useColors } from "./theme";

export interface ListingCard {
  id: string; title: string; transactionType: "sale" | "rent"; suburb?: string; priceCents?: number;
  bedrooms?: number; bathrooms?: number; parking?: number; photoCount?: number;
  cover?: { id: string; srcSet: string; alt?: string };
}

/** The smallest photo size in a srcSet ("url 400w, url 800w"), as an absolute URL. */
export function coverUrl(srcSet: string | undefined): string | null {
  const first = srcSet?.split(",")[0]?.trim().split(/\s+/)[0];
  return first && first.startsWith("/api/") ? `${apiUrl}${first}` : null;
}

export function ListingRow({ l, onPress }: { l: ListingCard; onPress: () => void }) {
  const c = useColors();
  const img = coverUrl(l.cover?.srcSet);
  return (
    <Card onPress={onPress} label={`${l.title}, ${formatPrice(l.priceCents, l.transactionType)}`}>
      {img ? <Image source={{ uri: img }} style={[s.photo, { backgroundColor: c.border }]} accessibilityLabel={l.cover?.alt ?? l.title} /> : null}
      <Text style={[s.price, { color: c.text }]}>{formatPrice(l.priceCents, l.transactionType)}</Text>
      <Title>{l.title}</Title>
      <Muted lines={1}>{[l.suburb, roomsLine(l)].filter(Boolean).join(" · ") || (l.transactionType === "rent" ? "For rent" : "For sale")}</Muted>
    </Card>
  );
}

const s = StyleSheet.create({
  photo: { width: "100%", aspectRatio: 16 / 10, borderRadius: radius.md, marginBottom: space.md },
  price: { fontSize: font.title, fontWeight: "800", marginBottom: space.xs }
});
