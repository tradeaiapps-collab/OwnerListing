import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Alert, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth, useUser } from "../../src/auth";
import { formatPrice } from "../../src/lib/format";
import { ApiError } from "../../src/lib/api-client";
import { SyncBanner, useCachedLoad } from "../../src/offline";
import { messageOf } from "../../src/use-load";
import { Body, Button, Card, Empty, ErrorState, Field, Loading, Muted, Title } from "../../src/ui/kit";
import { font, space, useColors } from "../../src/ui/theme";

interface Offer { id: string; priceCents: number; conditions: string[]; settlementDays: number; depositCents: number; status: string; submittedAt: string; round: number }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECIDABLE = new Set(["submitted", "under_review", "countered", "buyer_countered"]);

const confirm = (title: string, ok: string) => new Promise<boolean>(resolve => {
  if (Platform.OS === "web") return resolve(globalThis.confirm?.(title) ?? false);
  Alert.alert(title, undefined, [{ text: "Cancel", style: "cancel", onPress: () => resolve(false) }, { text: ok, onPress: () => resolve(true) }]);
});

/**
 * Offers on one listing. Only the owner decides (accept needs a second-step code from the last 15 minutes); an appointed agent sees them read-only.
 * Decisions need a connection: they are never saved for later.
 */
export default function ListingOffers() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const valid = typeof id === "string" && UUID.test(id);
  const { api, verifyMfa } = useAuth();
  const user = useUser();
  const c = useColors();
  const { data, stale, savedAt, error, loading, reload } = useCachedLoad<Offer[]>(`offers.${id}`, async () => {
    if (!valid) throw new Error("bad id");
    return (await api.get<{ offers: Offer[] }>(`/api/listings/${id}/offers`)).offers;
  }, [id]);
  const [status, setStatus] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [stepUp, setStepUp] = useState<{ offerId: string } | null>(null);
  const [code, setCode] = useState("");

  if (!valid) return <ErrorState message="This listing link is not valid." />;
  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState message={error} onRetry={reload} />;

  const decide = async (offerId: string, decision: "accept" | "reject") => {
    if (!(await confirm(decision === "accept" ? "Accept this offer?" : "Decline this offer?", decision === "accept" ? "Accept" : "Decline"))) return;
    setBusy(offerId); setProblem(null);
    try {
      const r = await api.post<{ offer: { status: string } }>(`/api/listings/${id}/offers/${offerId}/decision`, { decision });
      setStatus(s => ({ ...s, [offerId]: r.offer.status }));
      setStepUp(null);
    } catch (e) {
      if (e instanceof ApiError && e.code === "mfa_required" && decision === "accept") { setStepUp({ offerId }); setProblem("Confirm it's you with your authenticator code, then accept again."); }
      else setProblem(messageOf(e));
    } finally { setBusy(null); }
  };
  const confirmCode = async () => {
    setBusy("mfa"); setProblem(null);
    try { await verifyMfa("totp", code); setCode(""); setStepUp(null); setProblem("Confirmed. Tap Accept again."); }
    catch (e) { setProblem(messageOf(e)); } finally { setBusy(null); }
  };

  const canDecide = user.userType === "owner";
  return (
    <View style={{ flex: 1 }}>
      <SyncBanner stale={stale} savedAt={savedAt} />
      <ScrollView contentContainerStyle={s.page}>
        {!canDecide ? <Muted>Only the owner can accept or decline an offer. You can see the offers here.</Muted> : null}
        {problem ? <Text style={{ color: c.danger }} accessibilityRole="alert">{problem}</Text> : null}
        {stepUp ? (
          <Card>
            <Field label="Authenticator code" value={code} onChangeText={setCode} keyboardType="number-pad" autoComplete="one-time-code" maxLength={8} />
            <Button title="Confirm" busy={busy === "mfa"} disabled={code.length < 6} onPress={() => void confirmCode()} />
          </Card>
        ) : null}
        {(data ?? []).length === 0 ? <Empty title="No offers yet" /> : null}
        {(data ?? []).map(o => {
          const st = status[o.id] ?? o.status;
          return (
            <Card key={o.id} highlight={DECIDABLE.has(st)}>
              <Text style={[s.badge, { color: DECIDABLE.has(st) ? c.accent : st === "accepted" ? c.success : c.muted }]}>{st.replace(/_/g, " ")}</Text>
              <Title>{formatPrice(o.priceCents, "sale")}</Title>
              <Muted>Deposit {formatPrice(o.depositCents, "sale")} · settlement in {o.settlementDays} days{o.round ? ` · round ${o.round}` : ""}</Muted>
              {o.conditions.length ? <Body>Conditions: {o.conditions.join("; ")}</Body> : null}
              {canDecide && DECIDABLE.has(st) ? (
                <View style={s.actions}>
                  <Button title="Accept" busy={busy === o.id} onPress={() => void decide(o.id, "accept")} />
                  <Button title="Decline" kind="danger" busy={busy === o.id} onPress={() => void decide(o.id, "reject")} />
                </View>
              ) : null}
            </Card>
          );
        })}
      </ScrollView>
    </View>
  );
}
const s = StyleSheet.create({
  page: { padding: space.lg, width: "100%", maxWidth: 720, alignSelf: "center", gap: space.sm },
  badge: { fontSize: font.small, fontWeight: "700", textTransform: "uppercase", marginBottom: space.xs },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: space.sm, marginTop: space.md }
});
