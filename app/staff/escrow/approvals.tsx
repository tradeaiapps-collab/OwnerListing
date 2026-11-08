"use client";
import { useState } from "react";
import { balanceOf } from "../../../src/domain/deposit-escrow";
import { money } from "../../commissions-ui";
import type { Act, EscrowData } from "./page";

const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

/** Releases and refunds waiting for a second person. The person who asked can see but never decide. */
export default function Approvals({ data, act }: { data: EscrowData; act: Act }) {
  const [reasons, setReasons] = useState<Record<string, string>>({});
  if (data.pending.length === 0) return <p className="empty">Nothing is waiting for approval.</p>;
  return (
    <ul className="card-list">
      {data.pending.map(r => {
        const h = data.holdings.find(x => x.id === r.holdingId);
        const held = h ? balanceOf(h.requiredCents, data.movements.filter(m => m.holdingId === h.id)).heldCents : 0;
        const mine = r.requestedBy === data.me;
        const reason = reasons[r.id] ?? "";
        return (
          <li key={r.id} className="card es-card">
            <h2>{r.kind === "release" ? "Release to seller" : "Refund to buyer"}: {money(r.amountCents)}</h2>
            <p>{h ? <><span className="es-ref">{h.reference}</span> · {h.listingTitle} · {h.trustAccountLabel}</> : "Deposit record"}</p>
            <p className="muted">Held in trust now: {money(held)}. Asked {mine ? "by you" : "by another staff member"} on {when(r.requestedAt)}.</p>
            <p>Reason: {r.reason}</p>
            {r.kind === "release" && <p className="cm-note">The requester confirmed settlement is complete. Check with the solicitor before approving.</p>}
            {!data.can.approve ? <p className="muted">Your role cannot approve payments out of trust.</p>
              : mine ? <p className="staff-notice">A second person must decide. You asked for this payment.</p> : (
                <form className="stack" onSubmit={e => e.preventDefault()}>
                  <label>Reason for your decision (10+ characters)
                    <textarea className="staff-reason" value={reason} onChange={e => setReasons({ ...reasons, [r.id]: e.target.value })} />
                  </label>
                  <div className="cm-actions">
                    <button type="button" disabled={reason.trim().length < 10} onClick={() => void act(`/api/staff/escrow/releases/${r.id}`, { outcome: "approve", reason }, "Approved. Instruct the solicitor to pay from trust, then match the bank line.")}>Approve</button>
                    <button type="button" className="secondary" disabled={reason.trim().length < 10} onClick={() => void act(`/api/staff/escrow/releases/${r.id}`, { outcome: "reject", reason }, "Rejected.")}>Reject</button>
                  </div>
                </form>
              )}
          </li>
        );
      })}
    </ul>
  );
}
