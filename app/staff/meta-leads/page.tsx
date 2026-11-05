"use client";
import { useCallback, useEffect, useState } from "react";
import "../../styles/staff.css";
import "../../styles/admin.css";
import "../../styles/meta-leads.css";
import { loadError, postStaff, sendStaff } from "../staff-api";

type Field = "appId" | "appSecret" | "verifyToken" | "pageToken";
interface FieldView { set: boolean; source: "env" | "database" | "none"; value?: string }
interface Test { at: string; ok: boolean; message: string; pageName: string | null; pageId: string | null; appChecked: boolean }
type Status = "connected" | "untested" | "test_failed" | "disconnected";
interface View { keyConfigured: boolean; unreadable: Field[]; fields: Record<Field, FieldView>; configured: boolean; status: Status; test: Test | null; webhookPath: string }

const FIELDS: { f: Field; label: string; help: string; secret: boolean }[] = [
  { f: "appId", label: "App ID (optional)", help: "From your Meta app dashboard. Lets Test connection also check the app secret.", secret: false },
  { f: "appSecret", label: "App secret", help: "Meta app dashboard, App settings, Basic. Used to check that webhook calls really come from Meta.", secret: true },
  { f: "verifyToken", label: "Webhook verify token", help: "Any 16+ character text you choose. Paste the same text into Meta when you add the webhook.", secret: true },
  { f: "pageToken", label: "Page access token", help: "A long-lived token for your Facebook Page with leads_retrieval. Used to read each lead's answers.", secret: true }
];
const PILL: Record<Status, { label: string; tone: string }> = {
  connected: { label: "Connected", tone: "good" }, untested: { label: "Saved, not tested", tone: "warn" },
  test_failed: { label: "Test failed", tone: "bad" }, disconnected: { label: "Disconnected", tone: "warn" }
};
const when = (s: string) => new Date(s).toLocaleString("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Brisbane" });
const newToken = () => { const b = new Uint8Array(24); crypto.getRandomValues(b); return Array.from(b, x => x.toString(16).padStart(2, "0")).join(""); };

/** Facebook / Instagram lead ads keys: enter, test, see status, disconnect. The sign-in on Meta's side is done by the admin in Meta's own dashboard. ad_leads.manage only. */
export default function StaffMetaLeads() {
  const [view, setView] = useState<View | null>(null);
  const [edits, setEdits] = useState<Partial<Record<Field, string>>>({});
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState("");
  const [confirmOff, setConfirmOff] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/meta-lead-settings").catch(() => null);
    if (!r) { setError("Could not load."); return; }
    if (!r.ok) { setError(loadError(r.status)); return; }
    setView(await r.json());
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(""); setNote("");
    const body: Record<string, string> = {};
    for (const [k, v] of Object.entries(edits)) if (v !== undefined && v.trim() !== "") body[k] = v;
    if (Object.keys(body).length === 0) { setError("Type a value to change it. Leave a box empty to keep what is saved."); return; }
    setBusy("save");
    const r = await fetch("/api/staff/meta-lead-settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const d = await r?.json().catch(() => ({}));
    setBusy("");
    if (r?.ok) { setView(d); setEdits({}); setNote("Saved. Use Test connection to check the keys."); }
    else setError(d?.fields ? `${d.error} ${Object.values(d.fields).join(" ")}` : (d?.error ?? "Could not save."));
  }

  async function test() {
    setError(""); setNote(""); setBusy("test");
    const r = await postStaff("/api/staff/meta-lead-settings/test", {});
    if (!r.ok && r.status !== 502) setError(String(r.data["error"] ?? "Could not run the test."));
    await load();
    setBusy("");
  }

  async function disconnect() {
    setError(""); setNote(""); setBusy("off");
    const r = await sendStaff("DELETE", "/api/staff/meta-lead-settings");
    setBusy(""); setConfirmOff(false);
    if (r.ok) { setView(r.data as unknown as View); setNote("Disconnected. Saved keys were removed. Lead webhooks now answer 503 until you enter the keys again."); }
    else setError(String(r.data["error"] ?? "Could not disconnect."));
  }

  const fromEnv = view ? (Object.keys(view.fields) as Field[]).filter(f => view.fields[f].source === "env") : [];
  const hasStored = view ? (Object.keys(view.fields) as Field[]).some(f => view.fields[f].source === "database") : false;
  const hookUrl = typeof window === "undefined" || !view ? "" : `${window.location.origin}${view.webhookPath}`;

  return (
    <main>
      <h1>Facebook / Instagram lead ads</h1>
      <p className="muted">Enter the keys from your Meta developer app so leads from Facebook and Instagram ads reach <a href="/staff/ad-leads">Ad leads</a>. Signing in to Meta and creating the app is done on Meta&apos;s side. Secrets are stored encrypted and are never shown again.</p>
      {error && <p role="alert" className="leads-msg bad">{error}</p>}
      {note && <p role="status" className="leads-msg">{note}</p>}
      {!view && !error && <p className="muted">Loading...</p>}
      {view && (
        <>
          {!view.keyConfigured && <p role="alert" className="leads-msg bad">Encryption key not configured (PROVIDER_CREDENTIAL_KEY, MESSAGING_SETTINGS_KEY or MFA_SECRET_KEY). Nothing can be saved until the server has one.</p>}
          {view.keyConfigured && view.unreadable.length > 0 && <p role="alert" className="leads-msg bad">Saved keys cannot be read with the server&apos;s current encryption key ({view.unreadable.join(", ")}). The encryption key was probably changed. Lead webhooks answer 503. Enter these keys again to fix it, or put the previous key back.</p>}
          <section className="meta-status" aria-label="Connection status">
            <span className={`status-pill ${PILL[view.status].tone}`}>{PILL[view.status].label}</span>
            <p>
              {view.status === "disconnected" && "Not connected. Lead webhooks answer 503 until the app secret, verify token and Page access token are all set."}
              {view.status === "untested" && "All keys are set. Run Test connection to check them with Meta."}
              {view.test && view.status !== "untested" && view.status !== "disconnected" && <>
                {view.test.message}{view.test.pageName ? ` Page: ${view.test.pageName}${view.test.pageId ? ` (${view.test.pageId})` : ""}.` : ""} Tested {when(view.test.at)}.
              </>}
            </p>
            <div className="meta-actions">
              <button type="button" onClick={() => void test()} disabled={!!busy || !view.configured}>{busy === "test" ? "Testing..." : "Test connection"}</button>
              {!confirmOff && <button type="button" className="secondary" onClick={() => setConfirmOff(true)} disabled={!!busy || !hasStored}>Disconnect</button>}
              {confirmOff && <>
                <button type="button" className="danger" onClick={() => void disconnect()} disabled={!!busy}>{busy === "off" ? "Working..." : "Yes, remove saved keys"}</button>
                <button type="button" className="secondary" onClick={() => setConfirmOff(false)} disabled={!!busy}>Cancel</button>
              </>}
            </div>
          </section>
          {fromEnv.length > 0 && <p className="muted">Set by the server and overriding this form: {fromEnv.join(", ")}. Disconnect cannot remove these.</p>}

          <form className="meta-form" onSubmit={save}>
            <h2>Keys</h2>
            {FIELDS.map(({ f, label, help, secret }) => {
              const v = view.fields[f];
              return (
                <label key={f} className="meta-field">
                  <span>{label} <span className="muted">[{v.set ? (secret ? "set" : `set: ${v.value}`) : "not set"}{v.source === "env" ? ", from server settings" : ""}]</span></span>
                  <span className="meta-row">
                    <input type={secret ? "password" : "text"} autoComplete="off" spellCheck={false} value={edits[f] ?? ""} placeholder={v.set ? "Leave empty to keep" : ""}
                      onChange={ev => setEdits({ ...edits, [f]: ev.target.value })} disabled={!view.keyConfigured} />
                    {f === "verifyToken" && <button type="button" className="secondary" onClick={() => setEdits({ ...edits, verifyToken: newToken() })} disabled={!view.keyConfigured}>Generate</button>}
                  </span>
                  <small>{help}</small>
                </label>
              );
            })}
            {edits.verifyToken && edits.verifyToken === edits.verifyToken.trim() && /^[0-9a-f]{48}$/.test(edits.verifyToken) && <p className="muted">Copy the verify token before saving; it is not shown again: <code>{edits.verifyToken}</code></p>}
            <div><button type="submit" disabled={!!busy || !view.keyConfigured}>{busy === "save" ? "Saving..." : "Save keys"}</button></div>
          </form>

          <section className="meta-url" aria-labelledby="hook-h">
            <h2 id="hook-h">Webhook address for Meta</h2>
            <code>{hookUrl}</code>
            <p className="muted">In the Meta app, add this as the Page webhook callback URL (subscribe to the leadgen field) with the verify token above.</p>
          </section>
          <section aria-labelledby="steps-h">
            <h2 id="steps-h">Still done on Meta&apos;s side</h2>
            <ol className="meta-steps">
              <li>Create the Meta app, add Webhooks and Lead Ads, and pass app review for <code>leads_retrieval</code>.</li>
              <li>Sign in with the Facebook account that manages the Page and generate a long-lived Page access token.</li>
              <li>Add the Page id under Sources in <a href="/staff/ad-leads">Ad leads</a>, then send a test lead from Meta&apos;s Lead Ads Testing Tool.</li>
            </ol>
          </section>
        </>
      )}
    </main>
  );
}
