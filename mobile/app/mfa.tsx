import * as Linking from "expo-linking";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { apiUrl, useAuth } from "../src/auth";
import { messageOf } from "../src/use-load";
import { Body, Button, Chip, Field, Muted } from "../src/ui/kit";
import { font, space, useColors } from "../src/ui/theme";

type Method = "totp" | "sms" | "recovery";
const LABEL: Record<Method, string> = { totp: "Authenticator app", sms: "Text message", recovery: "Recovery code" };

/** The second sign-in step for this phone. Owners and agents always need it; buyers once they have set one up. */
export default function Mfa() {
  const { state, verifyMfa, signOut, api } = useAuth();
  const c = useColors();
  const [method, setMethod] = useState<Method>("totp");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const enrolled = state.status === "mfa" && state.enrolled;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await verifyMfa(method, code);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  const sendSms = async () => {
    setError(null);
    try {
      await api.post("/api/auth/mfa/sms/send", {});
      setNote("We sent a code to your mobile.");
    } catch (e) {
      setError(messageOf(e));
    }
  };

  if (!enrolled) {
    return (
      <ScrollView contentContainerStyle={s.wrap}>
        <Body>Your account needs a second sign-in step, and none is set up yet.</Body>
        <View style={{ height: space.sm }} />
        <Muted>Set one up on the website (Settings, then Two-step sign-in), then come back and sign in again.</Muted>
        <View style={{ height: space.xl }} />
        <Button title="Open the website" onPress={() => void Linking.openURL(`${apiUrl}/mfa`)} />
        <View style={{ height: space.md }} />
        <Button title="Sign out" kind="secondary" onPress={() => void signOut()} />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
      <Muted>Enter the code from your second sign-in step.</Muted>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chips}>
        {(Object.keys(LABEL) as Method[]).map(m => <Chip key={m} label={LABEL[m]} selected={m === method} onPress={() => { setMethod(m); setCode(""); }} />)}
      </ScrollView>
      {method === "sms" ? <View style={{ marginBottom: space.lg }}><Button title="Text me a code" kind="secondary" onPress={sendSms} /></View> : null}
      {note ? <Text style={[s.msg, { color: c.success }]}>{note}</Text> : null}
      <Field
        label={method === "recovery" ? "Recovery code" : "6-digit code"}
        value={code}
        onChangeText={setCode}
        autoCapitalize="none"
        keyboardType={method === "recovery" ? "default" : "number-pad"}
        textContentType="oneTimeCode"
        autoComplete="one-time-code"
        maxLength={method === "recovery" ? 32 : 6}
      />
      {error ? <Text style={[s.msg, { color: c.danger }]} accessibilityRole="alert">{error}</Text> : null}
      <Button title="Confirm" onPress={submit} busy={busy} disabled={!code.trim()} />
      <View style={{ height: space.md }} />
      <Button title="Sign out" kind="secondary" onPress={() => void signOut()} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  wrap: { padding: space.lg, width: "100%", maxWidth: 480, alignSelf: "center" },
  chips: { marginVertical: space.lg, flexGrow: 0 },
  msg: { fontSize: font.body, marginBottom: space.md }
});
