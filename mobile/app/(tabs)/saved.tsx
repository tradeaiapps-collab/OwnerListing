import { useFocusEffect, useRouter } from "expo-router";
import { useCallback } from "react";
import { FlatList, RefreshControl, StyleSheet } from "react-native";
import { useAuth } from "../../src/auth";
import { useLoad } from "../../src/use-load";
import { Empty, ErrorState, Loading } from "../../src/ui/kit";
import { ListingRow } from "../../src/ui/listing-row";
import { space } from "../../src/ui/theme";

interface Saved { listingId: string; title: string; suburb?: string; priceCents?: number; bedrooms?: number; transactionType: "sale" | "rent"; savedAt: string }

/** The buyer's saved properties (GET /api/buyer/saved-listings). Only published listings are shown. */
export default function SavedScreen() {
  const { api } = useAuth();
  const router = useRouter();
  const { data, error, loading, refreshing, reload, refresh } = useLoad(() => api.get<{ listings: Saved[] }>("/api/buyer/saved-listings"), [api]);
  // Saving or removing on a property screen shows here when the tab comes back into view.
  useFocusEffect(useCallback(() => { void refresh(); }, []));  // eslint-disable-line react-hooks/exhaustive-deps

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;
  return (
    <FlatList
      data={data?.listings ?? []}
      keyExtractor={l => l.listingId}
      contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      renderItem={({ item }) => <ListingRow l={{ ...item, id: item.listingId }} onPress={() => router.push(`/listing/${item.listingId}`)} />}
      ListEmptyComponent={<Empty title="No saved properties yet" hint="Tap Save on a property to keep it here." />}
    />
  );
}

const s = StyleSheet.create({ list: { padding: space.lg, width: "100%", maxWidth: 720, alignSelf: "center", flexGrow: 1 } });
