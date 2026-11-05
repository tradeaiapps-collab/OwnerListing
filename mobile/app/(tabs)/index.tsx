import { useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { FlatList, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../src/auth";
import { searchQuery, type SearchFields } from "../../src/lib/format";
import { ListingRow, type ListingCard } from "../../src/ui/listing-row";
import { messageOf } from "../../src/use-load";
import { Button, Chip, Empty, ErrorState, Field, Loading } from "../../src/ui/kit";
import { font, space, useColors } from "../../src/ui/theme";

interface Page { listings: ListingCard[]; total: number; page: number; pageSize: number }

/** Search published listings: words, sale or rent, bedrooms and a top price. Same filters as the website's browse page. */
export default function Search() {
  const { api } = useAuth();
  const router = useRouter();
  const c = useColors();
  const [fields, setFields] = useState<SearchFields>({});
  const [maxPrice, setMaxPrice] = useState("");
  const [result, setResult] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [more, setMore] = useState(false);

  const run = useCallback(async (page = 1) => {
    const f = { ...fields, page, ...(maxPrice ? { maxPriceDollars: Number(maxPrice.replace(/[^\d]/g, "")) } : {}) };
    if (page === 1) setBusy(true); else setMore(true);
    try {
      const r = await api.get<Page>(`/api/listings${searchQuery(f)}`);
      setResult(prev => (page > 1 && prev ? { ...r, listings: [...prev.listings, ...r.listings] } : r));
      setError(null);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
      setMore(false);
    }
  }, [api, fields, maxPrice]);

  const tx = (t: "sale" | "rent") => setFields(f => (f.transactionType === t ? { ...f, transactionType: undefined } : { ...f, transactionType: t }) as SearchFields);
  const hasMore = result ? result.page * result.pageSize < result.total : false;

  const header = (
    <View style={s.form}>
      <Field label="Suburb, street or keywords" value={fields.q ?? ""} onChangeText={q => setFields(f => ({ ...f, q }))} returnKeyType="search" onSubmitEditing={() => void run(1)} placeholder="e.g. Paddington pool" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chips}>
        <Chip label="Buy" selected={fields.transactionType === "sale"} onPress={() => tx("sale")} />
        <Chip label="Rent" selected={fields.transactionType === "rent"} onPress={() => tx("rent")} />
        {[1, 2, 3, 4].map(n => (
          <Chip key={n} label={`${n}+ bed`} selected={fields.minBedrooms === n} onPress={() => setFields(f => ({ ...f, minBedrooms: f.minBedrooms === n ? 0 : n }))} />
        ))}
      </ScrollView>
      {fields.transactionType ? (
        <Field label={fields.transactionType === "rent" ? "Max rent per week ($)" : "Max price ($)"} value={maxPrice} onChangeText={setMaxPrice} keyboardType="number-pad" />
      ) : null}
      <Button title="Search" onPress={() => void run(1)} busy={busy} />
      {result ? <Text style={[s.count, { color: c.muted }]}>{result.total === 1 ? "1 property" : `${result.total} properties`}</Text> : null}
    </View>
  );

  return (
    <FlatList
      data={result?.listings ?? []}
      keyExtractor={l => l.id}
      contentContainerStyle={s.list}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={header}
      refreshControl={<RefreshControl refreshing={false} onRefresh={() => void run(1)} />}
      renderItem={({ item }) => <ListingRow l={item} onPress={() => router.push(`/listing/${item.id}`)} />}
      ListEmptyComponent={busy ? <Loading /> : error ? <ErrorState message={error} onRetry={() => void run(1)} /> : result ? <Empty title="No properties match" hint="Try fewer filters or another suburb." /> : <Empty title="Find your next home" hint="Search by suburb, street or what matters to you." />}
      ListFooterComponent={hasMore ? <Button title="Show more" kind="secondary" onPress={() => void run((result?.page ?? 1) + 1)} busy={more} /> : undefined}
    />
  );
}

const s = StyleSheet.create({
  list: { padding: space.lg, width: "100%", maxWidth: 720, alignSelf: "center", flexGrow: 1 },
  form: { marginBottom: space.lg },
  chips: { marginBottom: space.lg, flexGrow: 0 },
  count: { fontSize: font.small, marginTop: space.md }
});
