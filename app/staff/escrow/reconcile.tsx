"use client";
import { useCallback, useEffect, useState } from "react";
import type { DepositMovement, Reconciliation, StatementLine, Suggestion } from "../../../src/domain/deposit-escrow";
import { dateLabel, money } from "../../commissions-ui";
import { postStaff } from "../staff-api";
import type { EscrowData } from "./page";

interface View { summary: Reconciliation; lines: (StatementLine & { suggestion: Suggestion | null })[]; unmatched: (DepositMovement & { reference: string })[] }
const ENTRY: Record<DepositMovement["kind"], string> = { receipt: "Receipt", release: "Release", refund: "Refund" };
const signed = (c: number) => `${c < 0 ? "−" : ""}${money(Math.abs(c))}`;

/** Bank reconciliation for one trust account: import the bank's CSV, then confirm what each line is. Nothing is matched automatically. */
export default function Reconcile({ data, onChanged, setNotice }: { data: EscrowData; onChanged: () => Promise<void>; setNotice: (s: string) => void }) {
  const [account, setAccount] = useState(data.accounts[0]?.id ?? "");
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!account) return;
    const r = await fetch(`/api/staff/escrow/accounts/${account}`).catch(() => null);
    if (!r || !r.ok) { setErr("Could not load this trust account."); return; }
    setErr(""); setView(await r.json());
  }, [account]);
  useEffect(() => { void load(); }, [load]);

  if (data.accounts.length === 0) return <p className="empty">No trust account holds a deposit yet. Open a deposit record first.</p>;

  async function run(url: string, body: unknown, done: string) {
    setBusy(true);
    const res = await postStaff(url, body);
    setBusy(false);
    setNotice(res.ok ? done : String(res.data["error"] ?? "That did not work."));
    if (res.ok) { await load(); await onChanged(); }
  }

  async function importFile(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;
    if (file.size > 1_000_000) { setNotice("The statement is too large. Export a shorter date range."); return; }
    const csv = await file.text();
    setBusy(true);
    const res = await postStaff(`/api/staff/escrow/accounts/${account}`, { csv, fileName: file.name });
    setBusy(false);
    const unreadable = Array.isArray(res.data["unreadable"]) ? (res.data["unreadable"] as string[]) : [];
    setNotice(res.ok ? `Imported ${res.data["added"]} new lines (${res.data["skipped"]} already imported).${unreadable.length ? ` Not read: ${unreadable.join(" ")}` : ""}` : String(res.data["error"] ?? "Import failed."));
    if (res.ok) { setFile(null); (e.target as HTMLFormElement).reset(); await load(); await onChanged(); }
  }

  const openHere = data.holdings.filter(h => h.trustAccountId === account && h.status === "open");
  const s = view?.summary;

  return (
    <>
      <div className="cm-row">
        <label>Trust account
          <select value={account} onChange={e => { setAccount(e.target.value); setView(null); }}>
            {data.accounts.map(a => <option key={a.id} value={a.id}>{a.label} (BSB {a.bsb.slice(0, 3)}-{a.bsb.slice(3)})</option>)}
          </select>
        </label>
      </div>
      {data.can.manage && (
        <form className="panel es-form" onSubmit={e => void importFile(e)}>
          <h2>Import a bank statement</h2>
          <p className="cm-note">Export the trust account transactions as CSV from online banking. Needs Date and Amount columns (or Debit and Credit); Description and Reference help matching. Importing an overlapping period is safe: lines already here are skipped.</p>
          <div className="cm-row">
            <label>Statement file (CSV)<input type="file" accept=".csv,text/csv" onChange={e => setFile(e.target.files?.[0] ?? null)} /></label>
          </div>
          <div className="cm-actions"><button type="submit" disabled={!file || busy}>Import statement</button></div>
        </form>
      )}
      {err && <p role="alert" className="staff-notice">{err}</p>}
      {!view && !err && <p className="muted" aria-busy="true">Loading the statement…</p>}
      {s && view && (
        <>
          <dl className="cm-tiles">
            <div className="cm-tile"><dt>Held per ledger</dt><dd>{money(s.ledgerHeldCents)}</dd></div>
            <div className={`cm-tile${s.unmatchedMovements ? " warn" : ""}`}><dt>Ledger not matched</dt><dd>{s.unmatchedMovements}</dd></div>
            <div className="cm-tile"><dt>Bank lines matched</dt><dd>{s.matchedLines}</dd></div>
            <div className="cm-tile"><dt>Other bank lines</dt><dd>{s.unmatchedLines}</dd></div>
          </dl>
          <p className={s.reconciled ? "es-ok-text" : "staff-notice"}>{s.reconciled ? "Every ledger entry for this account is backed by a bank statement line." : "Some ledger entries have no bank statement line yet. Import a newer statement or match them below."}</p>

          <h2>Ledger entries without a bank line</h2>
          {view.unmatched.length === 0 ? <p className="empty">None.</p> : (
            <div className="table-wrap">
              <table className="es-table">
                <thead><tr><th scope="col">Date</th><th scope="col">Reference</th><th scope="col">Entry</th><th scope="col" className="num">Amount</th></tr></thead>
                <tbody>{view.unmatched.map(m => (
                  <tr key={m.id}><th scope="row">{dateLabel(m.occurredOn)}</th><td><span className="es-ref">{m.reference}</span></td><td>{ENTRY[m.kind]}</td><td className="num">{m.kind === "receipt" ? "" : "−"}{money(m.amountCents)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          )}

          <h2>Bank statement lines</h2>
          {view.lines.length === 0 ? <p className="empty">No statement imported for this account yet.</p> : (
            <div className="table-wrap">
              <table className="es-table es-lines">
                <thead><tr><th scope="col">Date</th><th scope="col">Description</th><th scope="col" className="num">Amount</th><th scope="col">Match</th></tr></thead>
                <tbody>
                  {view.lines.map(l => {
                    const sug = l.suggestion;
                    const options = [
                      ...view.unmatched.filter(m => (m.kind === "receipt") === l.amountCents > 0 && m.amountCents === Math.abs(l.amountCents)).map(m => ({ v: `m:${m.id}`, label: `${ENTRY[m.kind]} ${m.reference} (${dateLabel(m.occurredOn)})` })),
                      ...(l.amountCents > 0 ? openHere.map(h => ({ v: `h:${h.id}`, label: `New receipt for ${h.reference}` })) : [])
                    ];
                    const picked = choice[l.id] ?? "";
                    return (
                      <tr key={l.id}>
                        <th scope="row">{dateLabel(l.lineDate)}</th>
                        <td className="es-desc">{l.description || <span className="muted">No description</span>}{l.reference && <><br /><small className="muted">Ref {l.reference}</small></>}</td>
                        <td className={`num ${l.amountCents < 0 ? "es-out" : ""}`}>{signed(l.amountCents)}</td>
                        <td className="es-match">
                          {l.matchedMovementId ? <span className="es-status held">Matched</span>
                            : !data.can.manage ? <span className="muted">Not matched</span>
                            : sug ? (
                              <div className="es-suggest">
                                <span>{sug.kind === "new_receipt" ? `Deposit for ${sug.reference}` : `${ENTRY[sug.movementKind]} ${sug.reference}`}</span>
                                <button type="button" className="secondary" disabled={busy}
                                  onClick={() => void run(`/api/staff/escrow/lines/${l.id}`, sug.kind === "new_receipt" ? { action: "receipt", holdingId: sug.holdingId } : { action: "match", movementId: sug.movementId }, "Matched.")}>Confirm</button>
                              </div>
                            ) : options.length === 0 ? <span className="muted">Not a deposit</span> : (
                              <div className="es-suggest">
                                <label className="sr-only" htmlFor={`m-${l.id}`}>What is this line?</label>
                                <select id={`m-${l.id}`} value={picked} onChange={e => setChoice({ ...choice, [l.id]: e.target.value })}>
                                  <option value="">Not a deposit</option>{options.map(o => <option key={o.v} value={o.v}>{o.label}</option>)}
                                </select>
                                <button type="button" className="secondary" disabled={!picked || busy}
                                  onClick={() => void run(`/api/staff/escrow/lines/${l.id}`, picked.startsWith("m:") ? { action: "match", movementId: picked.slice(2) } : { action: "receipt", holdingId: picked.slice(2) }, "Matched.")}>Match</button>
                              </div>
                            )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
