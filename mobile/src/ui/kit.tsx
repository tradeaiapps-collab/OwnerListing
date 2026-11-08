import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import { font, radius, space, TAP, useColors } from "./theme";

/** Shared building blocks so every screen uses the same tokens, states and tap sizes. */

export function Button(p: { title: string; onPress: () => void; kind?: "primary" | "secondary" | "danger"; disabled?: boolean; busy?: boolean }) {
  const c = useColors();
  const kind = p.kind ?? "primary";
  const bg = kind === "primary" ? c.primary : "transparent";
  const fg = kind === "primary" ? c.onPrimary : kind === "danger" ? c.danger : c.text;
  const off = p.disabled || p.busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!p.busy }}
      disabled={off}
      onPress={p.onPress}
      style={({ pressed }) => [s.button, { backgroundColor: bg, borderColor: kind === "primary" ? bg : c.border, opacity: off ? 0.5 : pressed ? 0.8 : 1 }]}
    >
      {p.busy ? <ActivityIndicator color={fg} /> : <Text style={[s.buttonText, { color: fg }]}>{p.title}</Text>}
    </Pressable>
  );
}

export function Field(p: TextInputProps & { label: string; error?: string | null }) {
  const c = useColors();
  const { label, error, style, ...rest } = p;
  return (
    <View style={s.field}>
      <Text style={[s.label, { color: c.text }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={c.muted}
        style={[s.input, { color: c.text, backgroundColor: c.surface, borderColor: error ? c.danger : c.border }, style]}
        {...rest}
      />
      {error ? <Text style={[s.small, { color: c.danger }]}>{error}</Text> : null}
    </View>
  );
}

export function Card(p: { children: ReactNode; onPress?: () => void; highlight?: boolean; label?: string }) {
  const c = useColors();
  const style = [s.card, { backgroundColor: p.highlight ? c.unread : c.surface, borderColor: c.border }];
  if (!p.onPress) return <View style={style}>{p.children}</View>;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={p.label} onPress={p.onPress} style={({ pressed }) => [...style, pressed && { opacity: 0.85 }]}>
      {p.children}
    </Pressable>
  );
}

export function Title(p: { children: ReactNode }) {
  const c = useColors();
  return <Text style={[s.title, { color: c.text }]} numberOfLines={2}>{p.children}</Text>;
}

export function Muted(p: { children: ReactNode; lines?: number }) {
  const c = useColors();
  return <Text style={[s.body, { color: c.muted }]} {...(p.lines ? { numberOfLines: p.lines } : {})}>{p.children}</Text>;
}

export function Body(p: { children: ReactNode }) {
  const c = useColors();
  return <Text style={[s.body, { color: c.text }]}>{p.children}</Text>;
}

/** Full-screen states: loading, empty and error look the same everywhere. */
export function Loading() {
  const c = useColors();
  return <View style={s.center} accessibilityLabel="Loading"><ActivityIndicator color={c.primary} /></View>;
}

export function Empty(p: { title: string; hint?: string }) {
  const c = useColors();
  return (
    <View style={s.center}>
      <Text style={[s.title, { color: c.text, textAlign: "center" }]}>{p.title}</Text>
      {p.hint ? <Text style={[s.body, { color: c.muted, textAlign: "center", marginTop: space.sm }]}>{p.hint}</Text> : null}
    </View>
  );
}

export function ErrorState(p: { message: string; onRetry?: () => void }) {
  const c = useColors();
  return (
    <View style={s.center} accessibilityRole="alert">
      <Text style={[s.body, { color: c.danger, textAlign: "center", marginBottom: space.md }]}>{p.message}</Text>
      {p.onRetry ? <Button title="Try again" kind="secondary" onPress={p.onRetry} /> : null}
    </View>
  );
}

export function Chip(p: { label: string; selected: boolean; onPress: () => void }) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: p.selected }}
      onPress={p.onPress}
      style={[s.chip, { backgroundColor: p.selected ? c.primary : c.surface, borderColor: p.selected ? c.primary : c.border }]}
    >
      <Text style={{ color: p.selected ? c.onPrimary : c.text, fontSize: font.small, fontWeight: "600" }}>{p.label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  button: { minHeight: TAP, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: space.lg, alignItems: "center", justifyContent: "center" },
  buttonText: { fontSize: font.body, fontWeight: "600" },
  field: { marginBottom: space.lg },
  label: { fontSize: font.small, fontWeight: "600", marginBottom: space.xs },
  input: { minHeight: TAP, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md, fontSize: font.body },
  card: { borderWidth: 1, borderRadius: radius.lg, padding: space.lg, marginBottom: space.md },
  title: { fontSize: font.title, fontWeight: "700" },
  body: { fontSize: font.body, lineHeight: 21 },
  small: { fontSize: font.small, marginTop: space.xs },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl },
  chip: { minHeight: 36, paddingHorizontal: space.md, borderRadius: 18, borderWidth: 1, justifyContent: "center", marginRight: space.sm }
});
