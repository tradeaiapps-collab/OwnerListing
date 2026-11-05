"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import "../../styles/billing.css";
import { JSON_HEADERS } from "../../listings/ui";
import { KIND_LABEL, METHOD_LABEL, dateAu, invoiceState, money } from "../view";

interface Detail {
  invoice: { id: string; invoiceNumber?: string; kind?: string; description?: string; amountExGstCents: number; gstCents: number; totalCents: number; status: "pending" | "paid" | "failed" | "void" | "refunded"; dueAt?: string; createdAt?: string; paidAt?: string; paymentMethod?: string };
  gstPercent: number; seller: { name: string; abn: string | null }; bank: { accountName: string; bsb: string; accountNumber: string } | null; cardAvailable: boolean;
}

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [issue, setIssue] = useState("");
  const [showIssue, setShowIssue] = useState(false);

  useEffect(() => {
    fetch(`/api/billing/invoices/${id}`)
      .then(async r => {
        if (r.status === 401) { setError("Sign in to see this invoice."); return; }
        if (r.status === 404) { setError("Invoice not found."); return; }
        if (!r.ok) throw new Error();
        setD(await r.json());
      })
      .catch(() => setError("Could not load the invoice."));
  }, [id]);

  async function payByCard() {
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await fetch(`/api/billing/invoices/${id}/pay`, { method: "POST", headers: JSON_HEADERS, body: "{}" });
      const body = await r.json().catch(() => ({}));
      if (r.ok && typeof body.redirectUrl === "string" && body.redirectUrl.startsWith("https://")) window.location.assign(body.redirectUrl);
      else if (r.ok && body.alreadyPaid) setNotice("This invoice is already paid. Refresh to see it.");
      else setError(body.error ?? "Could not start card payment.");
    } catch { setError("Could not start card payment."); } finally { setBusy(false); }
  }

  async function sendIssue(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setError(""); setNotice("");
    try {
      const r = await fetch(`/api/billing/invoices/${id}/dispute`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ reason: issue }) });
      const body = await r.json().catch(() => ({}));
      if (r.ok) { setNotice("Thanks. Staff will look into it and reply in writing. Nothing is changed until they do."); setShowIssue(false); setIssue(""); }
      else setError(body.error ?? "Could not send your message.");
    } catch { setError("Could not send your message."); } finally { setBusy(false); }
  }

  if (!d) return <main><h1>Invoice</h1><p><a href="/billing">Back to billing</a></p>{error ? <p className="notice error" role="alert">{error}</p> : <p className="muted" role="status">Loading...</p>}</main>;
  const i = d.invoice;
  const s = invoiceState(i);
  return (
    <main>
      <p className="no-print"><a href="/billing">Back to billing</a></p>
      <h1>{i.status === "paid" ? "Tax invoice and receipt" : "Tax invoice"}</h1>
      {error && <p className="notice error" role="alert">{error}</p>}
      {notice && <p className="notice ok" role="status">{notice}</p>}
      <article className="inv-sheet" aria-label={`Invoice ${i.invoiceNumber ?? ""}`}>
        <div className="inv-head">
          <div><h2>{d.seller.name}</h2>{d.seller.abn && <p className="muted">ABN {d.seller.abn}</p>}</div>
          <div>
            <p style={{ margin: 0 }}><strong>{i.invoiceNumber}</strong> <span className={`status-pill ${s.tone}`}>{s.label}</span></p>
            {i.createdAt && <p className="muted" style={{ margin: 0 }}>Issued {dateAu(i.createdAt)}</p>}
            {i.status === "pending" && i.dueAt && <p className="muted" style={{ margin: 0 }}>Due {dateAu(i.dueAt)}</p>}
            {i.paidAt && <p className="muted" style={{ margin: 0 }}>Paid {dateAu(i.paidAt)}{i.paymentMethod ? ` by ${METHOD_LABEL[i.paymentMethod]?.toLowerCase()}` : ""}</p>}
          </div>
        </div>
        <table className="inv-lines">
          <thead><tr><th scope="col">Description</th><th scope="col" className="num">Amount</th></tr></thead>
          <tbody>
            <tr><td>{i.description ?? KIND_LABEL[i.kind ?? "other"]}</td><td className="num">{money(i.amountExGstCents)}</td></tr>
            <tr><td>GST ({d.gstPercent}%)</td><td className="num">{money(i.gstCents)}</td></tr>
          </tbody>
          <tfoot><tr><th scope="row">Total (AUD)</th><td className="num">{money(i.totalCents)}</td></tr></tfoot>
        </table>
        {i.status === "pending" && d.bank && (
          <div className="bank-box no-print">
            <strong>Pay by bank transfer</strong>
            <dl>
              <dt>Account name</dt><dd>{d.bank.accountName}</dd>
              <dt>BSB</dt><dd>{d.bank.bsb}</dd>
              <dt>Account</dt><dd>{d.bank.accountNumber}</dd>
              <dt>Reference</dt><dd>{i.invoiceNumber}</dd>
              <dt>Amount</dt><dd>{money(i.totalCents)}</dd>
            </dl>
            <small className="muted">Use the invoice number as the reference. This invoice shows as paid once staff confirm the money arrived.</small>
          </div>
        )}
      </article>
      <div className="row-actions no-print">
        {i.status === "pending" && <button type="button" disabled={busy || !d.cardAvailable} onClick={() => void payByCard()}>{d.cardAvailable ? "Pay by card" : "Card payment not available yet"}</button>}
        <button type="button" className="secondary" onClick={() => window.print()}>Print or save as PDF</button>
        {i.status !== "void" && <button type="button" className="secondary" onClick={() => setShowIssue(v => !v)} aria-expanded={showIssue}>Raise a payment issue</button>}
      </div>
      {showIssue && (
        <form className="stack no-print panel" onSubmit={sendIssue} style={{ maxWidth: "46rem" }}>
          <label>What is wrong with this invoice or payment?
            <textarea value={issue} onChange={e => setIssue(e.target.value)} minLength={10} maxLength={1000} required rows={4} />
          </label>
          <small className="muted">Please don't include card or bank account numbers. Staff will reply in writing; nothing changes until they do.</small>
          <div className="row-actions"><button type="submit" disabled={busy}>{busy ? "Sending..." : "Send to staff"}</button></div>
        </form>
      )}
    </main>
  );
}
