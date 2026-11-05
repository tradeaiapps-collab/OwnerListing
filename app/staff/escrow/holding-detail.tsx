"use client";
import { useEffect, useState } from "react";
import { balanceOf, displayStatus, STATUS_LABEL, type DepositHolding, type DepositMovement, type DepositRelease } from "../../../src/domain/deposit-escrow";
import { dateLabel, money, toCents } from "../../commissions-ui";
import type { Act } from "./page";

interface Detail { holding: DepositHolding; movements: DepositMovement[]; releases: DepositRelease[]; audit: { at: string; event: string; actor: string; payload: Record<string, unknown> }[] }

const ENTRY: Record<DepositMovement["kind"], string> = { receipt: "Received into trust", release: "Released to seller", refund: "Refunded to buyer" };
const EVENT: Record<string, string> = {
  "escrow.holding_opened": "Record opened", "escrow.receipt_recorded": "Deposit received recorded", "escrow.release_requested": "Release to seller requested",
  "escrow.refund_requested": "Refund to buyer requested", "escrow.release_approved": "Release approved", "escrow.release_rejected": "Release rejected",
  "escrow.refund_approved": "Refund approved", "escrow.refund_rejected": "Refund rejected", "escrow.holding_cancelled": "Record cancelled", "escrow.reconciled": "Matched to bank statement"
};
const todayStr = () => new Date().toISOString().slice(0, 10);
const when = (iso: string) => new Date(iso).toLocaleString("en-AU", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" });

export default function HoldingDetail({ holding, canManage, act }: { holding: DepositHolding; canManage: boolean; act: Act }) {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState("");
  const [amount, setAmount] = useState("");
  const [on, setOn] = useState(todayStr());
  const [ref, setRef] = useState("");
  const [kind, setKind] = useState<"release" | "refund">("release");
  const [payout, setPayout] = useState("");
  const [reason, setReason] = useState("");
  const [settled, setSettled] = useState(false);
  const url = `/api/staff/escrow/${holding.id}`;

  useEffect(() => {
    let live = true;
    void fetch(url).then(async r => {
      if (!live) return;
      if (!r.ok) { setErr("Could not load this record."); return; }
      const body: Detail = await r.json();
      setD(body);
      const b = balanceOf(body.holding.requiredCents, body.movements);
      setAmount(b.outstandingCents > 0 ? (b.outstandingCents / 100).toFixed(2) : "");
      setPayout(b.heldCents > 0 ? (b.heldCents / 100).toFixed(2) : "");
    }).catch(() => live && setErr("Could not load this record."));
    return () => { live = false; };
  }, [url]);

  if (err) return <p role="alert" className="staff-notice">{err}</p>;
  if (!d) return <p className="muted" aria-busy="true">Loading the record…</p>;
  const h = d.holding, b = balanceOf(h.requiredCents, d.movements), status = displayStatus(h, d.movements, d.releases);
  const open = h.status === "open", pending = d.releases.some(r => r.status === "pending");

  return (
    <section className="panel es-detail" aria-labelledby="es-detail-h">
      <h2 id="es-detail-h"><span className="es-ref">{h.reference}</span> · {h.listingTitle}</h2>
      <dl className="es-facts">
        <div><dt>Status</dt><dd><span className={`es-status ${status}`}>{STATUS_LABEL[status]}</span></dd></div>
        <div><dt>Trust account</dt><dd>{h.trustAccountLabel}</dd></div>
        <div><dt>Deposit required</dt><dd>{money(h.requiredCents)}</dd></div>
        <div><dt>Received</dt><dd>{money(b.receivedCents)}</dd></div>
        <div><dt>Held now</dt><dd>{money(b.heldCents)}</dd></div>
        <div><dt>Still owed</dt><dd>{money(b.outstandingCents)}</dd></div>
        <div><dt>Due by</dt><dd>{h.dueDate ? dateLabel(h.dueDate) : "Not set"}</dd></div>
        <div><dt>Offer price</dt><dd>{money(h.offerPriceCents)}</dd></div>
      </dl>
      {h.closedReason && <p className="cm-note">Closed: {h.closedReason}</p>}

      {canManage && open && (
        <div className="es-actions-grid">
          {b.outstandingCents > 0 && b.paidOutCents === 0 && (
            <form className="es-form" onSubmit={async e => { e.preventDefault(); await act(url, { action: "receipt", amountCents: toCents(amount), receivedOn: on, bankReference: ref || null }, "Receipt recorded."); }}>
              <h3>Record deposit received</h3>
              <p className="cm-note">Only once the trust account statement shows the money. Matching a bank line in Bank reconciliation does this for you.</p>
              <div className="cm-row">
                <label>Amount (AUD)<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} required /></label>
                <label>Date received<input type="date" max={todayStr()} value={on} onChange={e => setOn(e.target.value)} required /></label>
                <label>Bank reference<input value={ref} maxLength={100} onChange={e => setRef(e.target.value)} /></label>
              </div>
              <div className="cm-actions"><button type="submit" disabled={Number.isNaN(toCents(amount)) || toCents(amount) <= 0}>Record receipt</button></div>
            </form>
          )}
          {b.heldCents > 0 && !pending && (
            <form className="es-form" onSubmit={async e => {
              e.preventDefault();
              if (await act(url, { action: "request", kind, amountCents: toCents(payout), reason, settlementConfirmed: kind === "release" ? settled : false }, "Request sent. A second person must approve it.")) { setReason(""); setSettled(false); }
            }}>
              <h3>Pay the deposit out of trust</h3>
              <div className="cm-row">
                <label>To<select value={kind} onChange={e => setKind(e.target.value as "release" | "refund")}><option value="release">Seller (settlement complete)</option><option value="refund">Buyer (refund)</option></select></label>
                <label>Amount (AUD)<input inputMode="decimal" value={payout} onChange={e => setPayout(e.target.value)} required /></label>
              </div>
              <label className="es-wide">Reason (10+ characters)<textarea className="staff-reason" value={reason} onChange={e => setReason(e.target.value)} required minLength={10} /></label>
              {kind === "release" && (
                <label className="es-check"><input type="checkbox" checked={settled} onChange={e => setSettled(e.target.checked)} /> I have confirmed with the solicitor that settlement is complete.</label>
              )}
              <div className="cm-actions"><button type="submit" disabled={reason.trim().length < 10 || Number.isNaN(toCents(payout)) || (kind === "release" && !settled)}>Ask for approval</button></div>
            </form>
          )}
          {d.movements.length === 0 && !pending && (
            <form className="es-form" onSubmit={async e => { e.preventDefault(); await act(url, { action: "cancel", reason }, "Record cancelled."); }}>
              <h3>Cancel this record</h3>
              <p className="cm-note">Only before any money arrives, for example when the contract fell through.</p>
              <label className="es-wide">Reason (10+ characters)<textarea className="staff-reason" value={reason} onChange={e => setReason(e.target.value)} /></label>
              <div className="cm-actions"><button type="submit" className="danger" disabled={reason.trim().length < 10}>Cancel record</button></div>
            </form>
          )}
        </div>
      )}
      {pending && <p className="staff-notice">A payment out of trust is waiting for a second person in Approvals.</p>}

      <h3>Ledger</h3>
      {d.movements.length === 0 ? <p className="empty">Nothing received yet. The buyer quotes {h.reference} on the transfer.</p> : (
        <div className="table-wrap">
          <table className="es-table">
            <thead><tr><th scope="col">Date</th><th scope="col">Entry</th><th scope="col" className="num">Amount</th><th scope="col">Bank reference</th><th scope="col">Bank statement</th></tr></thead>
            <tbody>
              {d.movements.map(m => (
                <tr key={m.id}>
                  <th scope="row">{dateLabel(m.occurredOn)}</th><td>{ENTRY[m.kind]}</td>
                  <td className="num">{m.kind === "receipt" ? "" : "−"}{money(m.amountCents)}</td>
                  <td>{m.bankReference ?? <span className="muted">None</span>}</td>
                  <td><span className={`es-status ${m.reconciled ? "held" : "overdue"}`}>{m.reconciled ? "Matched" : "Not matched"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {d.releases.length > 0 && (
        <>
          <h3>Payout requests</h3>
          <ul className="es-list">
            {d.releases.map(r => (
              <li key={r.id}>
                <strong>{r.kind === "release" ? "Release to seller" : "Refund to buyer"} {money(r.amountCents)}</strong> · <span className={`es-status ${r.status === "approved" ? "held" : r.status === "rejected" ? "cancelled" : "release_pending"}`}>{r.status === "pending" ? "Waiting approval" : r.status === "approved" ? "Approved" : "Rejected"}</span>
                <br /><span className="muted">{when(r.requestedAt)}: {r.reason}</span>
                {r.decisionReason && <><br /><span className="muted">Decision: {r.decisionReason}</span></>}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Audit trail</h3>
      <ol className="es-list es-audit">
        {d.audit.map((a, i) => <li key={i}><time dateTime={a.at}>{when(a.at)}</time> · {EVENT[a.event] ?? a.event} · <span className="muted">{a.actor}</span></li>)}
      </ol>
    </section>
  );
}
