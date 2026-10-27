"use client";
import { useCallback, useEffect, useState } from "react";
import type { PhotoView } from "../../../src/domain/listing-photos";
import { aud, label, type Project } from "../../investments/ui";
import { STAGE_TAG } from "../../investments/project-card";
import { PhotoGallery } from "../../listings/gallery";
import { loadError, postStaff } from "../staff-api";

type Queued = Project & { ownerUserId: string; terms: { model: string } };
type Contract = { interest: { id: string; projectId: string; amountMinCents: number; amountMaxCents: number }; projectTitle: string; file?: { id: string; sizeBytes: number; uploadedAt: string } };
type Fee = { id: string; projectId: string; amountCents: number; status: string; createdAt: string };
type Tab = "projects" | "contracts" | "fees";
type Note = { kind: "ok" | "error"; text: string };

/** The server needs a recorded reason of at least this many characters for every decision. */
const REASON_MIN = 10;
const TABS: readonly Tab[] = ["projects", "contracts", "fees"];

/** Recorded reason with a live length hint. */
function Reason({ value, onChange, id }: { value: string; onChange: (v: string) => void; id: string }) {
  const short = value.trim().length < REASON_MIN;
  return (
    <label className="sr-field" htmlFor={`reason-${id}`}>Reason (recorded in the audit log)
      <textarea id={`reason-${id}`} className="staff-reason" value={value} onChange={e => onChange(e.target.value)} aria-describedby={`reason-${id}-hint`} />
      <span id={`reason-${id}-hint`} className={short ? "sr-hint" : "sr-hint is-ok"}>{short ? `At least ${REASON_MIN} characters (${value.trim().length} so far).` : "Ready."}</span>
    </label>
  );
}

/** Photos of a project in review: showing and hidden ones, read only. Loaded when the card is shown. */
function ReviewPhotos({ projectId, title }: { projectId: string; title: string }) {
  const [photos, setPhotos] = useState<PhotoView[] | null>(null);
  useEffect(() => {
    void fetch(`/api/staff/investments/${projectId}/photos`).then(async r => (r.ok ? (await r.json()).photos as PhotoView[] : [])).then(setPhotos).catch(() => setPhotos([]));
  }, [projectId]);
  if (photos === null) return <p className="muted inv-small" role="status">Loading photos…</p>;
  if (photos.length === 0) return <p className="muted inv-small">No photos.</p>;
  const hidden = photos.filter(p => p.hidden).length;
  return (
    <div>
      <p className="muted inv-small">{photos.length - hidden} showing{hidden ? `, ${hidden} hidden by the owner` : ""}. Select a photo to view it full size.</p>
      <PhotoGallery photos={photos} title={title} base="/api/staff/investments/photos" compact />
    </div>
  );
}

/** Moderation (investment.review): projects, signed contracts, and fees (investment.manage), one tab each. 404 from the API = module off. */
export default function StaffInvestments() {
  const [items, setItems] = useState<Queued[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [fees, setFees] = useState<Fee[] | null>(null);
  const [off, setOff] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState("");
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<Tab>("projects");

  useEffect(() => {
    const h = window.location.hash.slice(1) as Tab;
    if (TABS.includes(h)) setTab(h);
  }, []);
  const pick = (t: Tab) => { setTab(t); window.history.replaceState(null, "", `#${t}`); };

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

  async function act(key: string, url: string, body: Record<string, unknown>, done: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setNote(null); setBusy(key);
    const r = await postStaff(url, body);
    setBusy("");
    if (r.ok) { setNote({ kind: "ok", text: done }); setReasons(x => ({ ...x, [key]: "" })); await load(); }
    else setNote({ kind: "error", text: String(r.data["error"] ?? "That did not work.") });
  }
  const reasonOf = (k: string) => reasons[k] ?? "";
  const ready = (k: string) => reasonOf(k).trim().length >= REASON_MIN && busy === "";
  const reason = (k: string) => <Reason id={k} value={reasonOf(k)} onChange={v => setReasons(x => ({ ...x, [k]: v }))} />;

  const dueFees = fees?.filter(f => f.status === "due") ?? [];
  const tabCount: Record<Tab, number> = { projects: items?.length ?? 0, contracts: contracts.length, fees: dueFees.length };
  const tabName: Record<Tab, string> = { projects: "Projects to review", contracts: "Signed contracts", fees: "Platform fees" };
  const shownTabs = TABS.filter(t => t !== "fees" || fees !== null);
  const stats: [string, number | undefined, Tab | null][] = [
    ["Waiting for review", counts["pending_review"], "projects"], ["Contracts to check", counts["contractsSubmitted"], "contracts"], ["Fees due", counts["feesDue"], fees ? "fees" : null],
    ["Approved projects", counts["approved"], null], ["Changes requested", counts["changes_requested"], null], ["Interests", counts["interests"], null], ["Declared investors", counts["declarations"], null]
  ];

  return (
    <main className="sr-page">
      <header className="inv-page-head">
        <div>
          <h1>Investor projects</h1>
          <p className="muted">Review new and edited projects, check returned contracts and record platform fees.</p>
        </div>
        <nav className="inv-page-links" aria-label="Investor admin"><a className="button secondary" href="/staff/investments/settings">Module switch and posting model</a></nav>
      </header>
      {off && <p className="staff-notice">The investor module is off. Nothing to review. Turn it on in <a href="/staff/investments/settings">Module switch and posting model</a>.</p>}
      {error && <p role="alert" className="sr-banner is-error">{error}</p>}
      <div aria-live="polite">{note && <p className={`sr-banner is-${note.kind}`} role={note.kind === "error" ? "alert" : "status"}>{note.text} <button type="button" className="sr-dismiss" onClick={() => setNote(null)} aria-label="Dismiss message">×</button></p>}</div>
      {items === null && !off && !error && <p className="muted" role="status">Loading…</p>}

      {items && (
        <>
          <ul className="sr-stats" aria-label="Summary">
            {stats.map(([name, n, to]) => (
              <li key={name} className={to && (n ?? 0) > 0 ? "is-attention" : undefined}>
                {to ? <button type="button" className="sr-stat" onClick={() => pick(to)}><span className="sr-stat-n">{n ?? 0}</span><span>{name}</span></button>
                  : <div className="sr-stat"><span className="sr-stat-n">{n ?? 0}</span><span>{name}</span></div>}
              </li>
            ))}
          </ul>

          <div className="sr-tabs" role="tablist" aria-label="Work queues">
            {shownTabs.map(t => (
              <button key={t} type="button" role="tab" id={`tab-${t}`} aria-controls={`panel-${t}`} aria-selected={tab === t} tabIndex={tab === t ? 0 : -1}
                className="sr-tab" onClick={() => pick(t)}
                onKeyDown={e => {
                  const i = shownTabs.indexOf(t);
                  const next = e.key === "ArrowRight" ? shownTabs[(i + 1) % shownTabs.length] : e.key === "ArrowLeft" ? shownTabs[(i - 1 + shownTabs.length) % shownTabs.length] : undefined;
                  if (next) { e.preventDefault(); pick(next); document.getElementById(`tab-${next}`)?.focus(); }
                }}>
                {tabName[t]} <span className={tabCount[t] ? "sr-count is-on" : "sr-count"}>{tabCount[t]}</span>
              </button>
            ))}
          </div>

          {tab === "projects" && (
            <section role="tabpanel" id="panel-projects" aria-labelledby="tab-projects" className="sr-panel">
              {items.length === 0 && <p className="empty">No projects waiting for review.</p>}
              <ul className="sr-cards">
                {items.map(p => (
                  <li key={p.id} className="sr-card">
                    <div className="sr-card-head">
                      <div>
                        <h2>{p.title}</h2>
                        <p className="muted inv-small">{p.location}, {p.jurisdiction} · version {p.version} · updated {new Date(p.updatedAt).toLocaleString("en-AU")}</p>
                      </div>
                      <span className="inv-status pending_review">{p.version > 1 ? "Edited, re-review" : "New"}</span>
                    </div>
                    <ul className="inv-meta"><li>{label(p.projectType)}</li><li>{STAGE_TAG[p.stage] ?? label(p.stage)}</li><li>{p.visibleTo === "wholesale_only" ? "Wholesale only" : "All verified"}</li><li>{p.terms.model === "commission_on_contract" ? "Model 1" : "Model 2"}</li></ul>
                    <dl className="sr-figs">
                      <div><dt>Target</dt><dd>{aud(p.fundingTargetCents)}</dd></div>
                      <div><dt>Minimum</dt><dd>{aud(p.minimumTicketCents)}</dd></div>
                      <div><dt>Issuer</dt><dd>{p.issuerName}</dd></div>
                    </dl>
                    <p className="inv-section">{p.summary}</p>
                    <ReviewPhotos projectId={p.id} title={p.title} />
                    <details className="sr-more"><summary>Timeline, risks, structure and issuer declaration</summary>
                      <p className="inv-section"><strong>Timeline:</strong> {p.timeline}</p>
                      <p className="inv-section"><strong>Risks:</strong> {p.risks}</p>
                      <p className="inv-section"><strong>Structure:</strong> {p.structureDescription}</p>
                      <p className="inv-section"><strong>Licence or exemption:</strong> {p.issuerLicenceBasis}</p>
                      {p.issuerStatement && <p className="inv-section"><strong>Issuer statement:</strong> {p.issuerStatement}</p>}
                    </details>
                    <div className="sr-decide">
                      {reason(p.id)}
                      <div className="sr-actions">
                        <button type="button" disabled={!ready(p.id)} onClick={() => void act(p.id, `/api/staff/investments/${p.id}`, { outcome: "approve", reason: reasonOf(p.id), version: p.version }, `Approved "${p.title}". Investors can see it now.`)}>Approve</button>
                        <button type="button" className="secondary" disabled={!ready(p.id)} onClick={() => void act(p.id, `/api/staff/investments/${p.id}`, { outcome: "request_changes", reason: reasonOf(p.id), version: p.version }, `Sent "${p.title}" back to the owner for changes.`)}>Request changes</button>
                        <button type="button" className="secondary danger" disabled={!ready(p.id)} onClick={() => void act(p.id, `/api/staff/investments/${p.id}`, { outcome: "reject", reason: reasonOf(p.id), version: p.version }, `Rejected "${p.title}".`, `Reject "${p.title}"? The owner cannot edit a rejected project.`)}>Reject</button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {tab === "contracts" && (
            <section role="tabpanel" id="panel-contracts" aria-labelledby="tab-contracts" className="sr-panel">
              {contracts.length === 0 && <p className="empty">No signed contracts waiting.</p>}
              <ul className="sr-cards">
                {contracts.map(c => {
                  const k = c.interest.id;
                  return (
                    <li key={k} className="sr-card">
                      <div className="sr-card-head">
                        <div>
                          <h2>{c.projectTitle}</h2>
                          <p className="muted inv-small">Indicative {aud(c.interest.amountMinCents)} to {aud(c.interest.amountMaxCents)}{c.file ? ` · uploaded ${new Date(c.file.uploadedAt).toLocaleDateString("en-AU")}` : ""}</p>
                        </div>
                        {c.file && <a className="button secondary" href={`/api/staff/investments/contracts/${k}/file`}>Download PDF ({Math.ceil(c.file.sizeBytes / 1024)} KB)</a>}
                      </div>
                      <div className="sr-decide">
                        <label className="sr-field">Amount in the signed contract (AUD, for a percentage commission)
                          <input inputMode="decimal" value={amounts[k] ?? ""} onChange={e => setAmounts({ ...amounts, [k]: e.target.value })} placeholder="e.g. 150000" />
                        </label>
                        {reason(k)}
                        <div className="sr-actions">
                          <button type="button" disabled={!ready(k)} onClick={() => void act(k, `/api/staff/investments/contracts/${k}`, { action: "confirm", reason: reasonOf(k), ...(amounts[k] ? { contractAmountCents: Math.round(Number(amounts[k]) * 100) } : {}) }, "Contract confirmed as returned.")}>Confirm contract returned</button>
                          <button type="button" className="secondary" disabled={!ready(k)} onClick={() => void act(k, `/api/staff/investments/contracts/${k}`, { action: "reject", reason: reasonOf(k) }, "Contract sent back.")}>Send back</button>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {tab === "fees" && fees && (
            <section role="tabpanel" id="panel-fees" aria-labelledby="tab-fees" className="sr-panel">
              <p className="muted">Model 1 fees are invoiced to the poster, never taken from investment money. Mark a fee paid only when the poster's payment has reached our account.</p>
              {fees.length === 0 && <p className="empty">No fees yet.</p>}
              {fees.length > 0 && (
                <div className="inv-table-wrap">
                  <table className="inv-history sr-fees">
                    <thead><tr><th scope="col">Raised</th><th scope="col" className="num">Amount</th><th scope="col">Status</th><th scope="col">Record payment</th></tr></thead>
                    <tbody>
                      {fees.map(f => (
                        <tr key={f.id}>
                          <td>{new Date(f.createdAt).toLocaleDateString("en-AU")}</td>
                          <td className="num">{aud(f.amountCents)}</td>
                          <td><span className={`inv-status ${f.status === "due" ? "pending_review" : "approved"}`}>{f.status}</span></td>
                          <td>
                            {f.status === "due" ? (
                              <div className="sr-decide sr-inline">
                                {reason(f.id)}
                                <div className="sr-actions">
                                  <button type="button" disabled={!ready(f.id)} onClick={() => void act(f.id, `/api/staff/investments/fees/${f.id}`, { status: "paid", reason: reasonOf(f.id) }, "Fee marked paid.")}>Mark paid</button>
                                  <button type="button" className="secondary" disabled={!ready(f.id)} onClick={() => void act(f.id, `/api/staff/investments/fees/${f.id}`, { status: "waived", reason: reasonOf(f.id) }, "Fee waived.", "Waive this fee? This is recorded and cannot be undone here.")}>Waive</button>
                                </div>
                              </div>
                            ) : <span className="muted">Done</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
