import * as Linking from "expo-linking";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { apiUrl, useAuth } from "../src/auth";
import { messageOf } from "../src/use-load";
import { Button, Field, Muted } from "../src/ui/kit";
import { font, space, useColors } from "../src/ui/theme";

/** Email and password sign-in. New accounts, password resets and Google sign-in stay on the website for now. */
export default function SignIn() {
  const { signIn } = useAuth();
  const c = useColors();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!email.trim() || !password) return setError("Enter your email and password.");
    setBusy(true);
    setError(null);
    try {
      await signIn(email, password);
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: c.bg }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
          <View style={s.inner}>
            <Text style={[s.brand, { color: c.text }]} accessibilityRole="header">OwnerListing</Text>
            <Muted>Sign in to search homes, keep your saved properties and get alerts.</Muted>
            <View style={{ height: space.xl }} />
            <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" autoComplete="email" keyboardType="email-address" textContentType="username" />
            <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="current-password" textContentType="password" onSubmitEditing={submit} returnKeyType="go" />
            {error ? <Text style={[s.error, { color: c.danger }]} accessibilityRole="alert">{error}</Text> : null}
            <Button title="Sign in" onPress={submit} busy={busy} />
            <View style={{ height: space.md }} />
            <Button title="Create an account or reset password" kind="secondary" onPress={() => void Linking.openURL(`${apiUrl}/login`)} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  wrap: { flexGrow: 1, justifyContent: "center", padding: space.lg },
  inner: { width: "100%", maxWidth: 440, alignSelf: "center" },
  brand: { fontSize: 28, fontWeight: "800", marginBottom: space.sm },
  error: { fontSize: font.body, marginBottom: space.md }
});
