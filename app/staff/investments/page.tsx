"use client";
import { useCallback, useEffect, useState } from "react";
import { aud, label, type Project } from "../../investments/ui";
import { loadError, postStaff } from "../staff-api";

type Queued = Project & { ownerUserId: string; terms: { model: string } };
type Contract = { interest: { id: string; projectId: string; amountMinCents: number; amountMaxCents: number }; projectTitle: string; file?: { id: string; sizeBytes: number; uploadedAt: string } };
type Fee = { id: string; projectId: string; amountCents: number; status: string; createdAt: string };

/** Moderation queue (investment.review): projects, signed contracts, and fees (investment.manage). 404 from the API = module off. */
export default function StaffInvestments() {
  const [items, setItems] = useState<Queued[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [fees, setFees] = useState<Fee[] | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const r = await fetch("/api/staff/investments").catch(() => null);
    if (!r) { setError("Could not load."); return; }
    if (r.status === 404) { setOff(true); return; }
    if (!r.ok) { setError(loadError(r.status)); return; }
    const d = await r.json();
    setItems(d.items); setCounts(d.counts);
    const c = await fetch("/api/staff/investments/contracts").catch(() => null);
    if (c?.ok) setContracts((await c.json()).items);
    const f = await fetch("/api/staff/investments/fees").catch(() => null);
    if (f?.ok) setFees((await f.json()).items);
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function act(url: string, body: Record<string, unknown>, done: string) {
    setError(""); setNote("");
    const r = await postStaff(url, body);
    if (r.ok) { setNote(done); await load(); } else setError(String(r.data["error"] ?? "That did not work."));
  }
  const reason = (k: string) => (
    <label>Reason (recorded)<textarea className="staff-reason" value={reasons[k] ?? ""} onChange={e => setReasons({ ...reasons, [k]: e.target.value })} /></label>
  );

  return (
    <main>
      <h1>Investor projects review</h1>
      <p className="muted"><a href="/staff/investments/settings">Module switch and posting model</a></p>
      {off && <p className="staff-notice">The investor module is off. Nothing to review.</p>}
      {error && <p role="alert">{error}</p>}
      {note && <p role="status">{note}</p>}
      {items && (
        <p className="muted">Waiting {counts["pending_review"] ?? 0} · approved {counts["approved"] ?? 0} · changes requested {counts["changes_requested"] ?? 0} · rejected {counts["rejected"] ?? 0} · interests {counts["interests"] ?? 0} · declared investors {counts["declarations"] ?? 0} · contracts to check {counts["contractsSubmitted"] ?? 0} · fees due {counts["feesDue"] ?? 0}</p>
      )}
      {items?.length === 0 && <p className="empty">No projects waiting for review.</p>}
      <ul className="card-list">
        {items?.map(p => (
          <li key={p.id}>
            <h2>{p.title} <small className="muted">v{p.version}</small></h2>
            <ul className="inv-meta"><li>{p.location}, {p.jurisdiction}</li><li>{label(p.projectType)}</li><li>{label(p.stage)}</li><li>{label(p.visibleTo)}</li><li>{p.terms.model === "commission_on_contract" ? "Model 1" : "Model 2"}</li></ul>
            <p className="inv-section">{p.summary}</p>
            <p>Target {aud(p.fundingTargetCents)} · minimum {aud(p.minimumTicketCents)}</p>
            <details><summary>Timeline, risks, structure, issuer</summary>
              <p className="inv-section"><strong>Timeline:</strong> {p.timeline}</p>
              <p className="inv-section"><strong>Risks:</strong> {p.risks}</p>
              <p className="inv-section"><strong>Structure:</strong> {p.structureDescription}</p>
              <p className="inv-section"><strong>Issuer:</strong> {p.issuerName}. <strong>Licence/exemption:</strong> {p.issuerLicenceBasis}. {p.issuerStatement}</p>
            </details>
            {reason(p.id)}
            <div className="actions">
              {(["approve", "request_changes", "reject"] as const).map(o => (
                <button key={o} type="button" className={o === "approve" ? "" : "secondary"} onClick={() => void act(`/api/staff/investments/${p.id}`, { outcome: o, reason: reasons[p.id] ?? "", version: p.version }, "Decision recorded.")}>{label(o)}</button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {items && (
        <section>
          <h2>Signed contracts to check</h2>
          {contracts.length === 0 && <p className="empty">None waiting.</p>}
          <ul className="card-list">
            {contracts.map(c => (
              <li key={c.interest.id}>
                <h3>{c.projectTitle}</h3>
                <p className="muted">Indicative {aud(c.interest.amountMinCents)} to {aud(c.interest.amountMaxCents)}{c.file ? ` · PDF ${Math.ceil(c.file.sizeBytes / 1024)} KB` : ""}</p>
                {c.file && <a href={`/api/staff/investments/contracts/${c.interest.id}/file`}>Download signed copy</a>}
                <label>Amount in the signed contract (AUD, for a percentage commission)<input inputMode="decimal" value={amounts[c.interest.id] ?? ""} onChange={e => setAmounts({ ...amounts, [c.interest.id]: e.target.value })} /></label>
                {reason(c.interest.id)}
                <div className="actions">
                  <button type="button" onClick={() => void act(`/api/staff/investments/contracts/${c.interest.id}`, { action: "confirm", reason: reasons[c.interest.id] ?? "", ...(amounts[c.interest.id] ? { contractAmountCents: Math.round(Number(amounts[c.interest.id]) * 100) } : {}) }, "Contract returned.")}>Confirm (contract returned)</button>
                  <button type="button" className="secondary" onClick={() => void act(`/api/staff/investments/contracts/${c.interest.id}`, { action: "reject", reason: reasons[c.interest.id] ?? "" }, "Sent back.")}>Send back</button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      {fees && (
        <section>
          <h2>Platform fees (Model 1)</h2>
          <p className="muted">Invoiced to the poster. Never taken from investment money. Mark paid only when the poster's payment has reached our account.</p>
          {fees.length === 0 && <p className="empty">No fees yet.</p>}
          <ul className="card-list">
            {fees.map(f => (
              <li key={f.id}>
                {aud(f.amountCents)} <span className="inv-status">{f.status}</span> <small className="muted">{new Date(f.createdAt).toLocaleDateString("en-AU")}</small>
                {f.status === "due" && (
                  <>
                    {reason(f.id)}
                    <div className="actions">
                      <button type="button" onClick={() => void act(`/api/staff/investments/fees/${f.id}`, { status: "paid", reason: reasons[f.id] ?? "" }, "Marked paid.")}>Mark paid</button>
                      <button type="button" className="secondary" onClick={() => void act(`/api/staff/investments/fees/${f.id}`, { status: "waived", reason: reasons[f.id] ?? "" }, "Waived.")}>Waive</button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
