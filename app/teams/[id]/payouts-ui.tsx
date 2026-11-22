"use client";
import { useEffect, useRef, useState } from "react";
import { JSON_HEADERS } from "../../listings/ui";

export type PayCommission = { id: string; memberUserId: string; description: string; memberCents: number; status: "recorded" | "approved" | "paid"; paidAt?: string | null; createdAt: string };
export const money = (c: number) => new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(c / 100);

type Kyc = "none" | "pending" | "verified" | "restricted";
const KYC_TEXT: Record<Kyc, { label: string; tone: "bad" | "warn" | "ok"; help: string }> = {
  none: { label: "Not set up", tone: "bad", help: "Set up payouts so your agency can pay your commission straight to your bank account." },
  pending: { label: "Pending verification", tone: "warn", help: "Your provider is still checking your details. Continue setup if it asked for more." },
  restricted: { label: "Needs action", tone: "bad", help: "Your provider needs more information before you can be paid. Continue setup to fix it." },
  verified: { label: "Verified", tone: "ok", help: "You are ready to be paid. Bank details are held by Stripe, never by us." }
};

/** The member's own payout status and the hosted Stripe onboarding link. Stripe holds the identity and bank details. */
export function PayoutAccountCard({ teamId }: { teamId: string }) {
  const [state, setState] = useState<{ kyc: Kyc; enabled: boolean } | null>(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/me/payout-account").then(r => r.json()).then(d => { if (live) setState({ kyc: d.kycStatus ?? "none", enabled: d.enabled === true }); }).catch(() => { if (live) setErr("Could not load your payout status."); });
    return () => { live = false; };
  }, []);
  async function start() {
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/me/payout-account", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ teamId }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && typeof d.url === "string") window.location.assign(d.url); else setErr(d.error ?? "Could not start payout setup.");
    } catch { setErr("Network problem. Try again."); }
    setBusy(false);
  }
  if (err && !state) return <p role="alert">{err}</p>;
  if (!state) return <p className="muted" role="status">Loading payout status…</p>;
  const k = KYC_TEXT[state.kyc];
  return (
    <section className="payout-card" aria-label="Payout setup">
      <div className="payout-card-head">
        <h2>Get paid</h2>
        <span className="payout-pill" data-tone={k.tone}>{k.label}</span>
      </div>
      <p>{k.help}</p>
      {!state.enabled && <p className="muted">Payouts are not switched on yet. Your manager can still mark commission paid by hand.</p>}
      {state.enabled && state.kyc !== "verified" && <button type="button" onClick={start} disabled={busy}>{state.kyc === "none" ? "Set up payouts" : "Continue setup"}</button>}
      {state.enabled && state.kyc === "verified" && <button type="button" className="secondary" onClick={start} disabled={busy}>Update or re-verify details</button>}
      {err && <p role="alert">{err}</p>}
      <p className="muted">Stripe checks your identity and collects your bank details on its own page. You come back here when you finish.</p>
    </section>
  );
}

/** Earned (paid), pending approval and approved-awaiting-payment totals from the member's own commission records. */
export function EarningsSummary({ commissions, me }: { commissions: PayCommission[]; me: string }) {
  const mine = commissions.filter(c => c.memberUserId === me);
  const sum = (s: string) => mine.filter(c => c.status === s).reduce((a, c) => a + c.memberCents, 0);
  return (
    <dl className="team-kpis" aria-label="Your earnings">
      <div className="team-kpi"><dt>Paid to you</dt><dd>{money(sum("paid"))}</dd></div>
      <div className="team-kpi"><dt>Waiting for approval</dt><dd>{money(sum("recorded"))}</dd></div>
      <div className="team-kpi"><dt>Approved, ready to pay</dt><dd>{money(sum("approved"))}</dd></div>
    </dl>
  );
}

/** Confirm dialog before real money moves. The server re-checks everything; this only shows the figures. */
export function PayDialog({ commission, agentName, teamId, onClose, onDone }: { commission: PayCommission; agentName: string; teamId: string; onClose: () => void; onDone: (msg: string) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  useEffect(() => { ref.current?.showModal(); }, []);
  async function pay() {
    setBusy(true); setErr("");
    try {
      const r = await fetch(`/api/teams/${teamId}/payouts`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ commissionId: commission.id }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok) { onDone(`Payment of ${money(commission.memberCents)} sent to ${agentName}.`); return; }
      setErr(d.error ?? "The payment did not go through. Nothing was paid.");
    } catch { setErr("Network problem. Check the payout list before trying again."); }
    setBusy(false);
  }
  return (
    <dialog ref={ref} className="payout-dialog" aria-labelledby="pay-title" onClose={onClose}>
      <h2 id="pay-title">Pay {agentName}</h2>
      <dl className="payout-figures">
        <div><dt>Commission amount</dt><dd>{money(commission.memberCents)}</dd></div>
        <div><dt>Deducted by us</dt><dd>{money(0)}</dd></div>
        <div className="total"><dt>Agent receives</dt><dd>{money(commission.memberCents)}</dd></div>
      </dl>
      <p className="muted">{commission.description || "Commission"}. Any Stripe transfer fee is charged to the agency&apos;s Stripe account, not taken from the agent. A payment cannot be paid twice, and you cannot pay your own commission.</p>
      {err && <p role="alert">{err}</p>}
      <div className="payout-dialog-actions">
        <button type="button" className="secondary" onClick={() => ref.current?.close()} disabled={busy}>Cancel</button>
        <button type="button" onClick={pay} disabled={busy}>{busy ? "Paying…" : `Pay ${money(commission.memberCents)}`}</button>
      </div>
    </dialog>
  );
}
