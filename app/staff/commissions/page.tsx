"use client";
import { useCallback, useEffect, useState } from "react";
import { computeCommission, evenSchedule, parseTerms, type AdminAnalytics, type CommissionDeal, type CommissionPayout, type DealStatus } from "../../../src/domain/commission";
import { dateLabel, money, monthLabel, STATUS_LABEL, termsLabel, toCents } from "../../commissions-ui";
import { loadError, postStaff } from "../staff-api";
import "../../styles/reports.css";
import "../../styles/commissions.css";

interface Data { deals: CommissionDeal[]; payouts: CommissionPayout[]; analytics: AdminAnalytics; agents: { id: string; name: string }[] }
type Kind = "percentage" | "fixed" | "tiered";
interface TierRow { upTo: string; pct: string }

const todayStr = () => new Date().toISOString().slice(0, 10);

export default function StaffCommissions() {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState<"" | DealStatus>("");
  const [agentId, setAgentId] = useState("");
  const [selected, setSelected] = useState<string | null>(null);

  const load = useCallback(async () => {
    const p = new URLSearchParams();
    if (status) p.set("status", status);
    if (agentId) p.set("agentId", agentId);
    const r = await fetch(`/api/staff/commissions?${p}`).catch(() => null);
    if (!r) { setError("Could not load commissions."); return; }
    if (!r.ok) { setError(loadError(r.status)); return; }
    setError("");
    setData(await r.json());
  }, [status, agentId]);

  useEffect(() => { void load(); }, [load]);

  async function act(url: string, body: unknown, ok: string) {
    setNotice("");
    const r = await postStaff(url, body);
    if (r.ok) { setNotice(ok); await load(); } else setNotice(String(r.data["error"] ?? "That did not work."));
    return r.ok;
  }

  const a = data?.analytics;
  const deal = data?.deals.find(d => d.id === selected) ?? null;

  return (
    <main>
      <h1>Agent commissions</h1>
      <p className="muted">A record of commission owed to agents. The platform holds no money: payments are made outside the platform and confirmed here. Every change is logged.</p>
      {error && <p role="alert">{error}</p>}
      {!error && !data && <p className="muted" role="status">Loading…</p>}
      {notice && <p role="status">{notice}</p>}
      {data && a && (
        <>
          <dl className="cm-tiles" aria-label="Commission figures">
            {a.byStatus.map(s => <div className="cm-tile" key={s.status}><dt>{STATUS_LABEL[s.status]} ({s.deals})</dt><dd>{money(s.commissionCents)}</dd></div>)}
            <div className="cm-tile"><dt>Paid out</dt><dd>{money(a.paidCents)}</dd></div>
            <div className="cm-tile"><dt>Scheduled</dt><dd>{money(a.dueCents)}</dd></div>
            <div className={`cm-tile${a.overduePayouts > 0 ? " warn" : ""}`}><dt>Overdue ({a.overduePayouts})</dt><dd>{money(a.overdueCents)}</dd></div>
            <div className="cm-tile"><dt>No payment date</dt><dd>{money(a.unscheduledCents)}</dd></div>
            <div className="cm-tile"><dt>Overrides</dt><dd>{a.overrides}</dd></div>
          </dl>

          <div className="report-grid">
            <section className="report-card">
              <h2>By commission type</h2>
              <table className="report-table"><thead><tr><th>Type</th><th className="num">Deals</th><th className="num">Commission</th></tr></thead>
                <tbody>{a.byKind.map(k => <tr key={k.kind}><td>{k.kind}</td><td className="num">{k.deals}</td><td className="num">{money(k.commissionCents)}</td></tr>)}</tbody></table>
            </section>
            <section className="report-card">
              <h2>Top agents (earned)</h2>
              {a.topAgents.length === 0 ? <p className="empty">No earned deals yet.</p> : (
                <table className="report-table"><thead><tr><th>Agent</th><th className="num">Deals</th><th className="num">Earned</th></tr></thead>
                  <tbody>{a.topAgents.map(t => <tr key={t.agentUserId}><td>{t.agentName}</td><td className="num">{t.deals}</td><td className="num">{money(t.earnedCents)}</td></tr>)}</tbody></table>
              )}
            </section>
          </div>
          <h2>Last 12 months</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th scope="col">Month</th><th scope="col" className="num">Earned</th><th scope="col" className="num">Paid out</th></tr></thead>
              <tbody>{a.byMonth.map(m => <tr key={m.month}><th scope="row">{monthLabel(m.month)}</th><td className="num">{money(m.earnedCents)}</td><td className="num">{money(m.paidCents)}</td></tr>)}</tbody>
            </table>
          </div>

          <NewDeal agents={data.agents} onSave={async body => { const ok = await act("/api/staff/commissions", body, "Deal recorded."); return ok; }} />

          <h2>Deals</h2>
          <div className="cm-row">
            <label>Status
              <select value={status} onChange={e => { setStatus(e.target.value as "" | DealStatus); setSelected(null); }}>
                <option value="">All</option><option value="expected">Expected</option><option value="earned">Earned</option><option value="cancelled">Cancelled</option>
              </select>
            </label>
            <label>Agent
              <select value={agentId} onChange={e => { setAgentId(e.target.value); setSelected(null); }}>
                <option value="">All agents</option>{data.agents.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </label>
          </div>
          {data.deals.length === 0 ? <p className="empty">No deals match.</p> : (
            <div className="table-wrap">
              <table>
                <thead><tr><th scope="col">Deal</th><th scope="col">Agent</th><th scope="col">Terms</th><th scope="col" className="num">Sale price</th><th scope="col" className="num">Commission</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {data.deals.map(d => (
                    <tr key={d.id}>
                      <th scope="row">{d.title}<br /><small className="muted">{dateLabel(d.dealDate)}</small></th>
                      <td>{d.agentName}</td><td>{termsLabel(d.terms)}</td><td className="num">{money(d.salePriceCents)}</td>
                      <td className="num">{money(d.overrideCents ?? d.calculatedCents)}{d.overrideCents !== null && <small className="muted"> override</small>}</td>
                      <td><span className={`cm-status ${d.status}`}>{STATUS_LABEL[d.status]}</span></td>
                      <td><button type="button" className="secondary" aria-expanded={selected === d.id} onClick={() => setSelected(selected === d.id ? null : d.id)}>{selected === d.id ? "Close" : "Manage"}</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {deal && <Manage key={deal.id} deal={deal} payouts={data.payouts.filter(p => p.dealId === deal.id)} act={act} />}
        </>
      )}
      <p><a href="/staff">Back to staff</a></p>
    </main>
  );
}

function NewDeal({ agents, onSave }: { agents: { id: string; name: string }[]; onSave: (body: unknown) => Promise<boolean> }) {
  const [f, setF] = useState({ agentUserId: "", title: "", listingId: "", price: "", dealDate: todayStr(), settlementDate: "", pct: "2", fixed: "", count: "1", every: "30", first: "" });
  const [kind, setKind] = useState<Kind>("percentage");
  const [tiers, setTiers] = useState<TierRow[]>([{ upTo: "500000", pct: "2.5" }, { upTo: "", pct: "2" }]);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f, v: string) => setF(p => ({ ...p, [k]: v }));

  function terms(): unknown {
    if (kind === "percentage") return { kind, bps: Math.round(Number(f.pct) * 100) };
    if (kind === "fixed") return { kind, fixedCents: toCents(f.fixed) };
    return { kind, tiers: tiers.map((t, i) => ({ upToCents: i === tiers.length - 1 ? null : toCents(t.upTo), bps: Math.round(Number(t.pct) * 100) })) };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");
    const price = toCents(f.price);
    if (!f.agentUserId || !f.title.trim() || Number.isNaN(price) || price <= 0) { setErr("Choose an agent and enter a title and a sale price."); return; }
    // The server recalculates the commission and checks the payments add up to it.
    const body: Record<string, unknown> = {
      agentUserId: f.agentUserId, title: f.title.trim(), listingId: f.listingId.trim() || null, salePriceCents: price, terms: terms(),
      dealDate: f.dealDate, settlementDate: f.settlementDate || null, schedule: []
    };
    if (f.first) {
      const t = parseTerms(terms());
      if (!t.ok) { setErr(t.error); return; }
      body["schedule"] = evenSchedule(computeCommission(t.value, price), f.first, Number(f.count) || 1, Number(f.every) || 30);
    }
    if (await onSave(body)) setF(p => ({ ...p, title: "", listingId: "", price: "", settlementDate: "", first: "" }));
  }

  return (
    <details className="panel cm-detail">
      <summary><strong>Record a new deal</strong></summary>
      <form className="stack" onSubmit={e => void submit(e)}>
        <div className="cm-row">
          <label>Agent<select value={f.agentUserId} onChange={e => set("agentUserId", e.target.value)} required><option value="">Choose an agent</option>{agents.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}</select></label>
          <label>Deal title<input value={f.title} maxLength={200} onChange={e => set("title", e.target.value)} required /></label>
          <label>Listing id (optional)<input value={f.listingId} onChange={e => set("listingId", e.target.value)} placeholder="UUID" /></label>
        </div>
        <div className="cm-row">
          <label>Sale price (AUD)<input inputMode="decimal" value={f.price} onChange={e => set("price", e.target.value)} placeholder="850000" required /></label>
          <label>Deal date<input type="date" value={f.dealDate} onChange={e => set("dealDate", e.target.value)} required /></label>
          <label>Settlement date<input type="date" value={f.settlementDate} onChange={e => set("settlementDate", e.target.value)} /></label>
        </div>
        <div className="cm-row">
          <label>Commission type<select value={kind} onChange={e => setKind(e.target.value as Kind)}><option value="percentage">Percentage</option><option value="fixed">Fixed amount</option><option value="tiered">Tiered</option></select></label>
          {kind === "percentage" && <label>Rate (%)<input inputMode="decimal" value={f.pct} onChange={e => set("pct", e.target.value)} /></label>}
          {kind === "fixed" && <label>Amount (AUD)<input inputMode="decimal" value={f.fixed} onChange={e => set("fixed", e.target.value)} /></label>}
        </div>
        {kind === "tiered" && (
          <fieldset>
            <legend>Bands (each rate applies only to the part of the price inside the band)</legend>
            {tiers.map((t, i) => {
              const last = i === tiers.length - 1;
              return (
                <div className="cm-tier" key={i}>
                  <label>{last ? "Above the last limit" : "Up to (AUD)"}<input inputMode="decimal" value={last ? "" : t.upTo} disabled={last} placeholder={last ? "no limit" : ""} onChange={e => setTiers(ts => ts.map((x, j) => (j === i ? { ...x, upTo: e.target.value } : x)))} /></label>
                  <label>Rate (%)<input inputMode="decimal" value={t.pct} onChange={e => setTiers(ts => ts.map((x, j) => (j === i ? { ...x, pct: e.target.value } : x)))} /></label>
                  <button type="button" className="secondary" disabled={tiers.length < 2} onClick={() => setTiers(ts => ts.filter((_, j) => j !== i))}>Remove</button>
                </div>
              );
            })}
            <div className="actions"><button type="button" className="secondary" onClick={() => setTiers(ts => [...ts.slice(0, -1), { upTo: "", pct: "2" }, ts[ts.length - 1]!])}>Add band</button></div>
          </fieldset>
        )}
        <div className="cm-row">
          <label>First payment due (optional)<input type="date" value={f.first} onChange={e => set("first", e.target.value)} /></label>
          <label>Number of payments<input type="number" min={1} max={24} value={f.count} onChange={e => set("count", e.target.value)} /></label>
          <label>Days between payments<input type="number" min={1} max={365} value={f.every} onChange={e => set("every", e.target.value)} /></label>
        </div>
        {err && <p role="alert">{err}</p>}
        <div className="actions"><button type="submit">Record deal</button></div>
      </form>
    </details>
  );
}

function Manage({ deal, payouts, act }: { deal: CommissionDeal; payouts: CommissionPayout[]; act: (url: string, body: unknown, ok: string) => Promise<boolean> }) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [n, setN] = useState("1");
  const [first, setFirst] = useState(todayStr());
  const [every, setEvery] = useState("30");
  const [ref, setRef] = useState("");
  const url = `/api/staff/commissions/${deal.id}`;
  const effective = deal.overrideCents ?? deal.calculatedCents;
  const paid = payouts.filter(p => p.status === "paid").reduce((s, p) => s + p.amountCents, 0);
  const today = todayStr();
  const closed = deal.status === "cancelled";

  return (
    <section className="panel cm-detail" aria-label={`Manage ${deal.title}`}>
      <h3>{deal.title}</h3>
      <p>Calculated {money(deal.calculatedCents)} from {termsLabel(deal.terms)} on {money(deal.salePriceCents)}.
        {deal.overrideCents !== null && <> Overridden to {money(deal.overrideCents)}: {deal.overrideReason}.</>}
        {deal.closedReason && <> Closed: {deal.closedReason}.</>}</p>
      {!closed && (
        <>
          <div className="cm-actions">
            {deal.status === "expected" && <button type="button" onClick={() => void act(url, { action: "earned" }, "Marked earned.")}>Mark earned (sale settled)</button>}
          </div>
          <h4>Override or cancel</h4>
          <div className="cm-row">
            <label>New commission (AUD)<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder={(effective / 100).toFixed(2)} /></label>
            <label>Reason (10+ characters)<input value={reason} onChange={e => setReason(e.target.value)} /></label>
          </div>
          <div className="cm-actions">
            <button type="button" className="secondary" disabled={Number.isNaN(toCents(amount))} onClick={() => void act(url, { action: "override", overrideCents: toCents(amount), reason }, "Override saved.")}>Set override</button>
            {deal.overrideCents !== null && <button type="button" className="secondary" onClick={() => void act(url, { action: "override", overrideCents: null, reason }, "Override cleared.")}>Clear override</button>}
            <button type="button" className="danger" onClick={() => void act(url, { action: "cancel", reason }, "Deal cancelled.")}>Cancel deal</button>
          </div>
          <h4>Replace the unpaid payments</h4>
          <p className="cm-note">Still to schedule: {money(Math.max(0, effective - paid))} (commission {money(effective)} less {money(paid)} paid).</p>
          <div className="cm-row">
            <label>First due<input type="date" value={first} onChange={e => setFirst(e.target.value)} /></label>
            <label>Payments<input type="number" min={1} max={24} value={n} onChange={e => setN(e.target.value)} /></label>
            <label>Days apart<input type="number" min={1} max={365} value={every} onChange={e => setEvery(e.target.value)} /></label>
            <button type="button" disabled={effective - paid <= 0} onClick={() => void act(url, { action: "schedule", payments: evenSchedule(effective - paid, first, Number(n) || 1, Number(every) || 30) }, "Payments scheduled.")}>Schedule</button>
          </div>
        </>
      )}
      <h4>Payments</h4>
      {deal.status === "earned" && payouts.some(p => p.status === "scheduled") && (
        <div className="cm-row"><label>Payment reference for the next &quot;Mark paid&quot; (optional)<input value={ref} maxLength={100} onChange={e => setRef(e.target.value)} /></label></div>
      )}
      {payouts.length === 0 ? <p className="empty">No payments scheduled.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th scope="col">Due</th><th scope="col" className="num">Amount</th><th scope="col">Status</th><th scope="col"><span className="sr-only">Action</span></th></tr></thead>
            <tbody>
              {payouts.map(p => (
                <tr key={p.id}>
                  <th scope="row">{dateLabel(p.dueDate)}</th><td className="num">{money(p.amountCents)}</td>
                  <td><span className={`cm-status ${p.status === "scheduled" && p.dueDate < today ? "overdue" : p.status}`}>{p.status === "scheduled" && p.dueDate < today ? "Overdue" : p.status}</span>{p.paymentReference && <small className="muted"> {p.paymentReference}</small>}</td>
                  <td>{p.status === "scheduled" && deal.status === "earned" && <button type="button" className="secondary" onClick={() => void act(`/api/staff/commissions/payouts/${p.id}`, { reference: ref }, "Payment recorded.")}>Mark paid</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {deal.status === "expected" && payouts.some(p => p.status === "scheduled") && <p className="cm-note">Mark the deal earned before recording a payment.</p>}
    </section>
  );
}
