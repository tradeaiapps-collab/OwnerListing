"use client";
import { useCallback, useEffect, useState } from "react";
import { JSON_HEADERS } from "../../listings/ui";

interface Verification { businessName: string; abn: string; licenceNumber: string | null; licenceAuthority: string | null; licenceExpiry: string | null; insurer: string; policyNumber: string; insuranceExpiry: string; status: string; reviewNote: string | null }
interface State { status: string; badge: boolean; warnings: string[] }
interface Review { id: string; rating: number; comment: string | null; createdAt: string; reply: string | null; reviewerFirstName: string }
const EMPTY = { businessName: "", abn: "", licenceNumber: "", licenceAuthority: "", licenceExpiry: "", insurer: "", policyNumber: "", insuranceExpiry: "" };
const STATUS_TEXT: Record<string, string> = { none: "Not submitted", pending: "Waiting for staff to check", verified: "Verified", rejected: "Needs changes" };

/** A contractor's licence, insurance and ABN details, the verified badge, and the reviews they can reply to once. */
export default function ContractorTrust() {
  const [form, setForm] = useState(EMPTY);
  const [state, setState] = useState<State | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [suspended, setSuspended] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [replies, setReplies] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/contractor/trust");
      if (r.status === 401) { setError("Sign in to manage your verification."); return; }
      if (r.status === 403) { setError("Only contractor accounts have a verification."); return; }
      const d = await r.json();
      const v: Verification | null = d.verification;
      if (v) setForm({ businessName: v.businessName, abn: v.abn, licenceNumber: v.licenceNumber ?? "", licenceAuthority: v.licenceAuthority ?? "", licenceExpiry: v.licenceExpiry ?? "", insurer: v.insurer, policyNumber: v.policyNumber, insuranceExpiry: v.insuranceExpiry });
      setState(d.state); setNote(v?.reviewNote ?? null); setReviews(d.reviews); setSuspended(d.standing.suspended ? d.standing.reason ?? "Suspended." : null);
    } catch { setError("Could not load your verification."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(""); setMsg("");
    const r = await fetch("/api/contractor/trust", { method: "PUT", headers: JSON_HEADERS, body: JSON.stringify(form) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) { setMsg("Sent. Staff will check your details. Your badge shows once they verify them."); await load(); } else setError(d.error ?? "Could not send your details.");
    setBusy(false);
  }
  async function reply(id: string) {
    setBusy(true); setError("");
    const r = await fetch(`/api/reviews/${id}/reply`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ reply: replies[id] ?? "" }) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    if (r?.ok) await load(); else setError(d.error ?? "Could not post your reply.");
    setBusy(false);
  }

  return (
    <main>
      <h1>Verification and reviews</h1>
      <p className="muted">Owners are trusting you with access to their home. Verified contractors get a badge on their profile. Staff check the details you give; nothing is looked up automatically.</p>
      {error && <p role="alert">{error}</p>}
      {suspended && <p role="alert">Your account is suspended from new jobs: {suspended} Contact support.</p>}
      {state && (
        <section aria-live="polite">
          <p><span className="badge">{STATUS_TEXT[state.status] ?? state.status}</span>{state.badge && <span className="badge"> Verified badge showing</span>}</p>
          {note && state.status === "rejected" && <p role="alert">Staff note: {note}</p>}
          {state.warnings.map(w => <p key={w} role="alert">{w}</p>)}
        </section>
      )}
      <form className="stack" onSubmit={submit}>
        <label>Business or trading name<input value={form.businessName} onChange={set("businessName")} required maxLength={120} /></label>
        <label>ABN (11 digits)<input value={form.abn} onChange={set("abn")} required inputMode="numeric" maxLength={14} autoComplete="off" /></label>
        <fieldset><legend>Insurance (public liability)</legend>
          <label>Insurer<input value={form.insurer} onChange={set("insurer")} required maxLength={120} /></label>
          <label>Policy number<input value={form.policyNumber} onChange={set("policyNumber")} required maxLength={60} /></label>
          <label>Expires<input type="date" value={form.insuranceExpiry} onChange={set("insuranceExpiry")} required /></label>
        </fieldset>
        <fieldset><legend>Licence (if your trade needs one)</legend>
          <label>Licence number<input value={form.licenceNumber} onChange={set("licenceNumber")} maxLength={60} /></label>
          <label>Issued by (for example the state licensing authority)<input value={form.licenceAuthority} onChange={set("licenceAuthority")} maxLength={120} /></label>
          <label>Expires<input type="date" value={form.licenceExpiry} onChange={set("licenceExpiry")} /></label>
        </fieldset>
        <p className="muted">Changing any detail sends it back for checking and switches the badge off until staff verify it again.</p>
        <button type="submit" disabled={busy}>{busy ? "Sending…" : "Send for verification"}</button>
        {msg && <p role="status">{msg}</p>}
      </form>

      <h2>Your reviews</h2>
      {reviews.length === 0 && <p className="empty">No reviews yet. Owners can rate you after a job they mark completed.</p>}
      <ul className="card-list">
        {reviews.map(r => (
          <li key={r.id} className="card">
            <p><strong>{"★".repeat(r.rating)}{"☆".repeat(5 - r.rating)}</strong> <span className="muted">from {r.reviewerFirstName || "an owner"}, {new Date(r.createdAt).toLocaleDateString("en-AU")}</span></p>
            {r.comment && <p style={{ overflowWrap: "anywhere" }}>{r.comment}</p>}
            {r.reply ? <p className="muted" style={{ overflowWrap: "anywhere" }}>Your reply: {r.reply}</p> : (
              <div className="stack">
                <label>Public reply (one only; it cannot be edited)
                  <textarea maxLength={1000} value={replies[r.id] ?? ""} onChange={e => setReplies({ ...replies, [r.id]: e.target.value })} />
                </label>
                <button type="button" disabled={busy || !(replies[r.id] ?? "").trim()} onClick={() => void reply(r.id)}>Post reply</button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </main>
  );
}
