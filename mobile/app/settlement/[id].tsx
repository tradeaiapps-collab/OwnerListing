import { useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useAuth } from "../../src/auth";
import { SyncBanner, useCachedLoad, useOffline } from "../../src/offline";
import { messageOf } from "../../src/use-load";
import { Button, Card, ErrorState, Loading, Muted, Title } from "../../src/ui/kit";
import { font, space, TAP, useColors } from "../../src/ui/theme";

interface Milestone { stage: string; status: "pending" | "completed" | "blocked"; targetDate: string | null; actualDate: string | null; note: string | null }
interface Item { id: string; label: string; done: boolean; canTick: boolean }
interface Checklist { stage: string; role: string; items: Item[] }
interface View_ { id: string; listingTitle: string; currentStage: string; completed: boolean; fellThrough: boolean; canUpdate: boolean; milestones: Milestone[]; checklists: Checklist[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const today = () => new Date().toISOString().slice(0, 10);

/** One settlement: the stage timeline and checklists. Ticking an item or finishing a stage works offline and sends when back online. */
export default function SettlementDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const valid = typeof id === "string" && UUID.test(id);
  const { api } = useAuth();
  const { act } = useOffline();
  const c = useColors();
  const { data, stale, savedAt, error, loading, reload } = useCachedLoad<View_>(`settlement.${id}`, async () => {
    if (!valid) throw new Error("bad id");
    return api.get<View_>(`/api/settlements/${id}`);
  }, [id]);
  const [local, setLocal] = useState<{ ticks: Record<string, boolean>; done: Record<string, boolean> }>({ ticks: {}, done: {} });
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!valid) return <ErrorState message="This settlement link is not valid." />;
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorState message={error ?? "Not found."} onRetry={reload} />;

  const run = async (a: { label: string; body: unknown }, apply: () => void) => {
    setBusy(true); setProblem(null);
    try { await act({ kind: "settlement", path: `/api/settlements/${id}`, body: a.body, label: a.label }); apply(); }
    catch (e) { setProblem(messageOf(e)); }
    finally { setBusy(false); }
  };
  const tick = (cl: Checklist, it: Item) => {
    const done = !(local.ticks[`${cl.stage}.${cl.role}.${it.id}`] ?? it.done);
    return run({ label: `Tick ${it.label}`, body: { action: "tick", stage: cl.stage, role: cl.role, itemId: it.id, done } }, () => setLocal(l => ({ ...l, ticks: { ...l.ticks, [`${cl.stage}.${cl.role}.${it.id}`]: done } })));
  };
  const finish = (stage: string) => run({ label: `Finish ${stage}`, body: { action: "milestone", stage, status: "completed", actualDate: today() } }, () => setLocal(l => ({ ...l, done: { ...l.done, [stage]: true } })));

  return (
    <View style={{ flex: 1 }}>
      <SyncBanner stale={stale} savedAt={savedAt} />
      <ScrollView contentContainerStyle={s.page}>
        <Title>{data.listingTitle}</Title>
        {data.fellThrough ? <Text style={{ color: c.danger, fontWeight: "700" }}>This sale fell through.</Text> : null}
        {problem ? <Text style={{ color: c.danger }} accessibilityRole="alert">{problem}</Text> : null}
        <Text style={[s.h, { color: c.text }]}>Timeline</Text>
        {data.milestones.map(m => {
          const done = m.status === "completed" || local.done[m.stage];
          const current = m.stage === data.currentStage && !data.completed;
          return (
            <Card key={m.stage} highlight={current}>
              <View style={s.row}>
                <Text style={[s.stage, { color: c.text }]}>{m.stage}</Text>
                <Text style={{ color: done ? c.success : m.status === "blocked" ? c.danger : c.muted, fontWeight: "600", fontSize: font.small }}>{done ? "Done" : m.status === "blocked" ? "Blocked" : current ? "In progress" : "Pending"}</Text>
              </View>
              <Muted>{m.actualDate ? `Completed ${m.actualDate}` : m.targetDate ? `Target ${m.targetDate}` : "No target date"}{m.note ? ` · ${m.note}` : ""}</Muted>
              {current && data.canUpdate && !done ? <View style={{ marginTop: space.sm }}><Button title="Mark stage complete" kind="secondary" busy={busy} onPress={() => void finish(m.stage)} /></View> : null}
            </Card>
          );
        })}
        <Text style={[s.h, { color: c.text }]}>Checklists</Text>
        {data.checklists.map(cl => (
          <Card key={`${cl.stage}.${cl.role}`}>
            <Text style={[s.stage, { color: c.text }]}>{cl.stage} · {cl.role}</Text>
            {cl.items.map(it => {
              const done = local.ticks[`${cl.stage}.${cl.role}.${it.id}`] ?? it.done;
              return (
                <Pressable key={it.id} accessibilityRole="checkbox" accessibilityState={{ checked: done, disabled: !it.canTick || busy }} disabled={!it.canTick || busy} onPress={() => void tick(cl, it)} style={s.item}>
                  <Text style={{ color: done ? c.success : c.muted, fontSize: font.title }}>{done ? "☑" : "☐"}</Text>
                  <Text style={{ color: c.text, fontSize: font.body, flex: 1, opacity: it.canTick ? 1 : 0.6 }}>{it.label}</Text>
                </Pressable>
              );
            })}
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  page: { padding: space.lg, width: "100%", maxWidth: 720, alignSelf: "center", gap: space.sm },
  h: { fontSize: font.title, fontWeight: "700", marginTop: space.lg },
  row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: space.sm },
  stage: { fontSize: font.body, fontWeight: "700", textTransform: "capitalize", flexShrink: 1 },
  item: { minHeight: TAP, flexDirection: "row", alignItems: "center", gap: space.sm }
});
