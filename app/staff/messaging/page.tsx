"use client";
import { useCallback, useEffect, useState } from "react";
import "../../styles/staff.css";
import "../../styles/reports.css";
import { loadError, postStaff } from "../staff-api";

type Field = "sms.provider" | "sms.accountSid" | "sms.authToken" | "sms.apiKeySid" | "sms.sender" | "email.host" | "email.port" | "email.user" | "email.password" | "email.from";
interface FieldView { set: boolean; source: "env" | "database" | "none"; display?: string }
interface UsageRow { month: string; template: string; messages: number; segments: number; delivered: number; failed: number; estMicros: number; priceMicros: number }
interface View { keyConfigured: boolean; fields: Record<Field, FieldView>; smsConfigured: boolean; emailConfigured: boolean }

const SMS_FIELDS: [Field, string, boolean][] = [
  ["sms.provider", "Provider (twilio)", false], ["sms.accountSid", "Account SID", false], ["sms.authToken", "Auth token (or API key secret)", true],
  ["sms.apiKeySid", "API key SID (optional, if the secret above is an API key secret)", false], ["sms.sender", "Sender phone number (+61...), sender ID or messaging service SID (MG...)", false]
];
const EMAIL_FIELDS: [Field, string, boolean][] = [
  ["email.host", "SMTP host", false], ["email.port", "SMTP port (465, 587, 25 or 2525)", false], ["email.user", "SMTP user", false], ["email.password", "SMTP password", true], ["email.from", "From address", false]
];

const dollars = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

function status(v: FieldView): string {
  if (!v.set) return "not set";
  const from = v.source === "env" ? " (from server settings, overrides this form)" : "";
  return (v.display ? `set: ${v.display}` : "set") + from;
}

export default function StaffMessaging() {
  const [view, setView] = useState<View | null>(null);
  const [edits, setEdits] = useState<Partial<Record<Field, string>>>({});
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState("");
  const [usage, setUsage] = useState<UsageRow[] | null>(null);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/messaging").catch(() => null);
    if (!r) { setError("Could not load."); return; }
    if (!r.ok) { setError(loadError(r.status)); return; }
    setView(await r.json());
    const u = await fetch("/api/staff/messaging/sms-usage?months=3").catch(() => null);
    if (u?.ok) setUsage(((await u.json()) as { usage: UsageRow[] }).usage);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(""); setNote("");
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(edits)) if (v !== undefined && v !== "") body[k] = v;
    if (Object.keys(body).length === 0) { setError("Type a value to change it. Leave a box empty to keep what is saved."); return; }
    setBusy(true);
    try {
      const r = await fetch("/api/staff/messaging", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { setView(d); setEdits({}); setNote("Saved."); }
      else setError(d.fields ? `${d.error} ${Object.values(d.fields).join(" ")}` : (d.error ?? "Could not save."));
    } catch { setError("Could not save."); } finally { setBusy(false); }
  }

  async function clear(f: Field) {
    setError(""); setNote("");
    const r = await fetch("/api/staff/messaging", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ [f]: "" }) }).catch(() => null);
    const d = await r?.json().catch(() => ({}));
    if (r?.ok) { setView(d); setNote("Cleared."); } else setError(d?.error ?? "Could not clear.");
  }

  async function test(channel: "sms" | "email") {
    setError(""); setNote(""); setBusy(true);
    const r = await postStaff("/api/staff/messaging/test", channel === "sms" ? { channel, phone } : { channel });
    setBusy(false);
    if (r.ok) setNote(channel === "sms" ? "Test text sent." : "Test email sent to your account address.");
    else setError(String(r.data["error"] ?? "Could not send the test."));
  }

  const row = ([f, label, secret]: [Field, string, boolean]) => (
    <label key={f}>{label} <span className="muted">[{status(view!.fields[f])}]</span>
      <input type={secret ? "password" : "text"} autoComplete="off" value={edits[f] ?? ""} placeholder={view!.fields[f].set ? "Leave empty to keep" : ""}
        onChange={ev => setEdits({ ...edits, [f]: ev.target.value })} disabled={!view!.keyConfigured} />
      {view!.fields[f].source === "database" && <button type="button" onClick={() => void clear(f)} disabled={busy || !view!.keyConfigured}>Clear</button>}
    </label>
  );

  return (
    <main>
      <h1>Messaging settings</h1>
      <p className="muted">Email and SMS delivery. Secrets are stored encrypted and are never shown again. Until configured, nothing is sent. Server environment settings override anything saved here.</p>
      {view && !view.keyConfigured && <p role="alert">Encryption key not configured (MESSAGING_SETTINGS_KEY). Nothing can be saved until the server has it.</p>}
      {view && (
        <form className="stack" onSubmit={save}>
          <h2>SMS {view.smsConfigured ? "(configured)" : "(not configured)"}</h2>
          {SMS_FIELDS.map(row)}
          <h2>Email {view.emailConfigured ? "(configured)" : "(not configured)"}</h2>
          {EMAIL_FIELDS.map(row)}
          <button type="submit" disabled={busy || !view.keyConfigured}>{busy ? "Working..." : "Save changes"}</button>
        </form>
      )}
      {view && (
        <section>
          <h2>Send a test</h2>
          <label>Your mobile number for the test text <input inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="+61400000000" /></label>
          <button type="button" onClick={() => void test("sms")} disabled={busy || !view.smsConfigured}>Send test SMS to me</button>
          <button type="button" onClick={() => void test("email")} disabled={busy || !view.emailConfigured}>Send test email to me</button>
          <p className="muted">A few tests per hour are allowed. Spam Act consent wording for alerts still needs counsel.</p>
        </section>
      )}
      {view && usage && (
        <section>
          <h2>Text message usage (last 3 months)</h2>
          {usage.length === 0 ? <p className="muted">No notification texts sent yet.</p> : (
            <div style={{ overflowX: "auto" }}>
              <table className="report-table">
                <thead><tr><th>Month</th><th>Type</th><th className="num">Texts</th><th className="num">Segments</th><th className="num">Delivered</th><th className="num">Failed</th><th className="num">Cost</th></tr></thead>
                <tbody>
                  {usage.map(u => (
                    <tr key={`${u.month}-${u.template}`}>
                      <td>{u.month}</td><td>{u.template.replace(/^notif_/, "").replace(/_/g, " ")}</td>
                      <td className="num">{u.messages}</td><td className="num">{u.segments}</td><td className="num">{u.delivered}</td><td className="num">{u.failed}</td>
                      <td className="num">{dollars(u.priceMicros > 0 ? u.priceMicros : u.estMicros)}{u.priceMicros > 0 ? "" : " est."}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted">Cost is the provider&apos;s reported price when it sends one, otherwise segments times SMS_COST_PER_SEGMENT_CENTS. Check it against the provider invoice.</p>
        </section>
      )}
      {note && <p role="status">{note}</p>}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
