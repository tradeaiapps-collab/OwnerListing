"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  balanceOf, displayStatus, isOverdue, STATUS_LABEL,
  type DepositHolding, type DepositMovement, type DepositRelease
} from "../../../src/domain/deposit-escrow";
import { dateLabel, money, toCents } from "../../commissions-ui";
import { loadError, postStaff } from "../staff-api";
import Approvals from "./approvals";
import HoldingDetail from "./holding-detail";
import Reconcile from "./reconcile";
import "../../styles/reports.css";
import "../../styles/commissions.css";
import "../../styles/escrow.css";

interface AcceptedOffer { offerId: string; listingId: string; listingTitle: string; priceCents: number; depositCents: number; buyerName: string; accountLabel: string | null }
export interface EscrowData {
  holdings: DepositHolding[]; movements: DepositMovement[]; releases: DepositRelease[]; acceptedWithout: AcceptedOffer[];
  accounts: { id: string; label: string; bsb: string }[]; pending: DepositRelease[]; me: string; can: { manage: boolean; approve: boolean };
}
export type Act = (url: string, body: unknown, done: string) => Promise<boolean>;
type Tab = "deposits" | "approvals" | "reconcile";

const todayStr = () => new Date().toISOString().slice(0, 10);

export default function StaffEscrow() {
  const [data, setData] = useState<EscrowData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<Tab>("deposits");
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/escrow").catch(() => null);
    if (!r || !r.ok) { setError(loadError(r?.status ?? 0)); return; }
    setError("");
    setData(await r.json());
    setVersion(v => v + 1);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const act: Act = useCallback(async (url, body, done) => {
    setNotice("");
    const res = await postStaff(url, body);
    setNotice(res.ok ? done : String(res.data["error"] ?? "That did not work."));
    await load();
    return res.ok;
  }, [load]);

  const today = todayStr();
  const rows = useMemo(() => (data?.holdings ?? []).map(h => {
    const m = data!.movements.filter(x => x.holdingId === h.id), r = data!.releases.filter(x => x.holdingId === h.id);
    return { h, balance: balanceOf(h.requiredCents, m), status: displayStatus(h, m, r), overdue: isOverdue(h, balanceOf(h.requiredCents, m), today) };
  }), [data, today]);

  const tiles = useMemo(() => ({
    awaiting: rows.filter(x => x.status === "awaiting" || x.status === "part_received").length,
    overdue: rows.filter(x => x.overdue).length,
    held: rows.filter(x => x.h.status === "open").reduce((s, x) => s + x.balance.heldCents, 0),
    unreconciled: (data?.movements ?? []).filter(m => !m.reconciled).length,
    pending: data?.pending.length ?? 0
  }), [rows, data]);

  const holding = data && selected ? data.holdings.find(h => h.id === selected) ?? null : null;

  return (
    <main className="es">
      <h1>Deposits in trust</h1>
      <p className="muted es-lede">Buyer deposits are paid into the solicitor&apos;s verified trust account. The platform never holds the money: this screen is the record, the bank reconciliation and the two-person approval to release or refund.</p>
      {error && <p role="alert" className="staff-notice">{error}</p>}
      {notice && <p role="status" className="staff-notice">{notice}</p>}
      {!data && !error && <p className="muted" aria-busy="true">Loading deposits…</p>}
      {data && (
        <>
          <dl className="cm-tiles">
            <div className="cm-tile"><dt>Held in trust</dt><dd>{money(tiles.held)}</dd></div>
            <div className="cm-tile"><dt>Awaiting deposit</dt><dd>{tiles.awaiting}</dd></div>
            <div className={`cm-tile${tiles.overdue ? " warn" : ""}`}><dt>Overdue</dt><dd>{tiles.overdue}</dd></div>
            <div className={`cm-tile${tiles.pending ? " warn" : ""}`}><dt>Waiting approval</dt><dd>{tiles.pending}</dd></div>
            <div className={`cm-tile${tiles.unreconciled ? " warn" : ""}`}><dt>Not reconciled</dt><dd>{tiles.unreconciled}</dd></div>
          </dl>

          <div className="es-tabs" role="tablist" aria-label="Deposit work">
            {([["deposits", "Deposits"], ["approvals", `Approvals${tiles.pending ? ` (${tiles.pending})` : ""}`], ["reconcile", "Bank reconciliation"]] as [Tab, string][]).map(([k, label]) => (
              <button key={k} type="button" role="tab" id={`es-tab-${k}`} aria-controls={`es-panel-${k}`} aria-selected={tab === k} className="es-tab" onClick={() => setTab(k)}>{label}</button>
            ))}
          </div>

          {tab === "deposits" && (
            <section role="tabpanel" id="es-panel-deposits" aria-labelledby="es-tab-deposits">
              {data.can.manage && <OpenRecord offers={data.acceptedWithout} act={act} />}
              <h2>Deposit records</h2>
              {rows.length === 0 ? <p className="empty">No deposit records yet. Open one when an offer is accepted.</p> : (
                <div className="table-wrap">
                  <table className="es-table">
                    <thead><tr>
                      <th scope="col">Reference</th><th scope="col">Property</th><th scope="col" className="num">Deposit</th><th scope="col" className="num">Received</th>
                      <th scope="col">Status</th><th scope="col">Due</th><th scope="col"><span className="sr-only">Actions</span></th>
                    </tr></thead>
                    <tbody>
                      {rows.map(({ h, balance, status, overdue }) => (
                        <tr key={h.id} aria-selected={selected === h.id}>
                          <th scope="row"><span className="es-ref">{h.reference}</span></th>
                          <td>{h.listingTitle}<br /><small className="muted">Buyer {h.buyerName}</small></td>
                          <td className="num">{money(h.requiredCents)}</td>
                          <td className="num">{money(balance.receivedCents)}</td>
                          <td><span className={`es-status ${overdue ? "overdue" : status}`}>{overdue ? "Overdue" : STATUS_LABEL[status]}</span></td>
                          <td className="es-nowrap">{h.dueDate ? dateLabel(h.dueDate) : <span className="muted">Not set</span>}</td>
                          <td><button type="button" className="secondary" aria-expanded={selected === h.id} onClick={() => setSelected(selected === h.id ? null : h.id)}>{selected === h.id ? "Close" : "Open"}</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {holding && <HoldingDetail key={`${holding.id}-${version}`} holding={holding} canManage={data.can.manage} act={act} />}
            </section>
          )}

          {tab === "approvals" && (
            <section role="tabpanel" id="es-panel-approvals" aria-labelledby="es-tab-approvals">
              <Approvals data={data} act={act} />
            </section>
          )}

          {tab === "reconcile" && (
            <section role="tabpanel" id="es-panel-reconcile" aria-labelledby="es-tab-reconcile">
              <Reconcile key={version} data={data} onChanged={load} setNotice={setNotice} />
            </section>
          )}
        </>
      )}
      <p><a href="/staff">Back to staff</a></p>
    </main>
  );
}

function OpenRecord({ offers, act }: { offers: AcceptedOffer[]; act: Act }) {
  const [offerId, setOfferId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [due, setDue] = useState("");
  const offer = offers.find(o => o.offerId === offerId) ?? null;

  if (offers.length === 0) return <p className="cm-note">Every accepted offer has a deposit record.</p>;
  return (
    <section className="panel" aria-labelledby="es-open-h">
      <h2 id="es-open-h">Accepted offers without a deposit record</h2>
      <div className="table-wrap">
        <table className="es-table">
          <thead><tr><th scope="col">Property</th><th scope="col" className="num">Price</th><th scope="col" className="num">Deposit</th><th scope="col">Trust account</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
          <tbody>
            {offers.map(o => (
              <tr key={o.offerId} aria-selected={offerId === o.offerId}>
                <th scope="row" className="es-wrap">{o.listingTitle}<br /><small className="muted">Buyer {o.buyerName}</small></th>
                <td className="num">{money(o.priceCents)}</td>
                <td className="num">{money(o.depositCents)}</td>
                <td>{o.accountLabel ?? <span className="es-warn-text">No approved account</span>}</td>
                <td>
                  <button type="button" className="secondary" disabled={!o.accountLabel}
                    onClick={() => { setOfferId(o.offerId); setAmount((o.depositCents / 100).toFixed(2)); setDue(""); }}>Open record</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {offer && (
        <form className="es-form" onSubmit={async e => {
          e.preventDefault();
          const cents = toCents(amount);
          if (await act("/api/staff/escrow", { offerId: offer.offerId, requiredCents: Number.isNaN(cents) ? null : cents, dueDate: due || null }, "Deposit record opened. Give the buyer its reference to quote on the transfer.")) setOfferId(null);
        }}>
          <h3>Open the record for {offer.listingTitle}</h3>
          <div className="cm-row">
            <label>Deposit required (AUD)<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} required /></label>
            <label>Due by<input type="date" value={due} onChange={e => setDue(e.target.value)} /></label>
          </div>
          <p className="cm-note">Paid into {offer.accountLabel}. A reference such as DEP-7K3QX9 is created for the buyer to quote.</p>
          <div className="cm-actions">
            <button type="submit" disabled={Number.isNaN(toCents(amount)) || toCents(amount) <= 0}>Open record</button>
            <button type="button" className="secondary" onClick={() => setOfferId(null)}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}
