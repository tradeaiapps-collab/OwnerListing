import { Stack, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { FlatList, KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../../src/auth";
import { shortDateTime } from "../../src/lib/format";
import { messageOf, useLoad } from "../../src/use-load";
import { Button, Empty, ErrorState, Loading, Muted } from "../../src/ui/kit";
import { font, radius, space, TAP, useColors } from "../../src/ui/theme";

interface Message { id: string; body: string; sentAt: string; mine: boolean }
interface Conversation { appointmentId: string; listingTitle: string; counterpartName: string; open: boolean; messages: Message[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX = 5000;

/** Owner and agent messages for one appointment (GET/POST /api/agent-appointments/{id}/messages). Messages are permanent. */
export default function Messages() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { api } = useAuth();
  const c = useColors();
  const insets = useSafeAreaInsets();
  const valid = typeof id === "string" && UUID.test(id);
  const { data, setData, error, loading, reload, refresh, refreshing } = useLoad(async () => {
    if (!valid) throw new Error("bad id");
    return api.get<Conversation>(`/api/agent-appointments/${id}/messages`);
  }, [api, id]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const list = useRef<FlatList<Message>>(null);

  if (!valid) return <ErrorState message="This conversation link is not valid." />;
  if (loading && !data) return <Loading />;
  if (error || !data) return <ErrorState message={error ?? "Not found."} onRetry={reload} />;

  const send = async () => {
    const body = draft.trim();
    if (!body) return;
    setSending(true);
    setSendError(null);
    try {
      const r = await api.post<{ message: Message }>(`/api/agent-appointments/${id}/messages`, { body });
      setData(d => d && { ...d, messages: [...d.messages, r.message] });
      setDraft("");
      setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50);
    } catch (e) {
      setSendError(messageOf(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}>
      <Stack.Screen options={{ title: data.counterpartName }} />
      <FlatList
        ref={list}
        data={data.messages}
        keyExtractor={m => m.id}
        contentContainerStyle={s.list}
        onRefresh={refresh}
        refreshing={refreshing}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: false })}
        ListHeaderComponent={<Muted>{data.listingTitle}</Muted>}
        renderItem={({ item }) => (
          <View style={[s.bubble, item.mine ? { alignSelf: "flex-end", backgroundColor: c.primary } : { alignSelf: "flex-start", backgroundColor: c.surface, borderColor: c.border, borderWidth: 1 }]}>
            <Text style={{ color: item.mine ? c.onPrimary : c.text, fontSize: font.body }}>{item.body}</Text>
            <Text style={[s.time, { color: item.mine ? c.onPrimary : c.muted }]}>{shortDateTime(item.sentAt)}</Text>
          </View>
        )}
        ListEmptyComponent={<Empty title="No messages yet" hint={data.open ? "Say hello to get started." : undefined} />}
      />
      {data.open ? (
        <View style={[s.composer, { borderTopColor: c.border, backgroundColor: c.surface, paddingBottom: Math.max(insets.bottom, space.sm) }]}>
          {sendError ? <Text style={{ color: c.danger, marginBottom: space.xs }} accessibilityRole="alert">{sendError}</Text> : null}
          <View style={s.row}>
            <TextInput
              accessibilityLabel="Message"
              value={draft}
              onChangeText={setDraft}
              placeholder="Write a message"
              placeholderTextColor={c.muted}
              multiline
              maxLength={MAX}
              style={[s.input, { color: c.text, borderColor: c.border, backgroundColor: c.bg }]}
            />
            <Button title="Send" onPress={send} busy={sending} disabled={!draft.trim()} />
          </View>
        </View>
      ) : (
        <View style={[s.closed, { paddingBottom: Math.max(insets.bottom, space.sm) }]}><Muted>This appointment has ended. You can still read the messages.</Muted></View>
      )}
    </KeyboardAvoidingView>
  );
}

const s = StyleSheet.create({
  list: { padding: space.lg, flexGrow: 1, width: "100%", maxWidth: 720, alignSelf: "center" },
  bubble: { maxWidth: "85%", borderRadius: radius.lg, paddingHorizontal: space.md, paddingVertical: space.sm, marginTop: space.sm },
  time: { fontSize: 11, marginTop: space.xs, opacity: 0.8 },
  composer: { borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.md, paddingTop: space.sm },
  row: { flexDirection: "row", alignItems: "flex-end", gap: space.sm },
  input: { flex: 1, minHeight: TAP, maxHeight: 140, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, paddingTop: 12, paddingBottom: 12, fontSize: font.body },
  closed: { padding: space.lg, alignItems: "center" }
});
