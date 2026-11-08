"use client";
import { use, useCallback, useEffect, useState, type FormEvent } from "react";
import { DISPUTE_TYPES, TYPE_LABEL, type DisputeType } from "../../../../src/domain/dispute";
import { DisputeDetail, dollars, dollarsToCents, type Detail } from "../../../disputes/dispute-parts";

const OPEN = ["awaiting_position", "mediating", "escalated"];

/** The disputes on one sale: raise one, see Elena's suggestion, and accept, counter or ask for staff. Only the buyer and owner can answer. */
export default function SettlementDisputes({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [items, setItems] = useState<Detail[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<DisputeType>("inspection");
  const [title, setTitle] = useState(""), [description, setDescription] = useState(""), [position, setPosition] = useState(""), [amount, setAmount] = useState(""), [share, setShare] = useState("50");
  const [side, setSide] = useState<string>("");

  const load = useCallback(async () => {
    const r = await fetch(`/api/settlements/${id}/disputes`).catch(() => null);
    if (!r || !r.ok) { setError(r?.status === 401 ? "Sign in to see disputes." : r?.status === 404 ? "Settlement not found." : "Could not load disputes."); return; }
    const list = ((await r.json()) as { disputes: { id: string; side: string }[] }).disputes;
    const full = await Promise.all(list.map(async x => { const d = await fetch(`/api/settlements/${id}/disputes/${x.id}`).catch(() => null); return d?.ok ? ((await d.json()) as Detail) : null; }));
    setItems(full.filter((x): x is Detail => x !== null));
    setSide(list[0]?.side ?? "");
    setError("");
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  async function send(url: string, body: Record<string, unknown>): Promise<boolean> {
    setBusy(true); setError("");
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    const ok = !!r && r.ok;
    if (r && !r.ok) setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? "That did not work.");
    else if (!r) setError("Network error.");
    setBusy(false);
    await load();
    return ok;
  }

  const cents = amount.trim() ? dollarsToCents(amount) : null, badAmount = amount.trim() !== "" && cents === null;
  const sharePct = Number(share), badShare = cents !== null && !(Number.isInteger(sharePct) && sharePct >= 0 && sharePct <= 100);
  async function create(e: FormEvent) {
    e.preventDefault();
    const ok = await send(`/api/settlements/${id}/disputes`, { type, title, description, position, claimCents: cents, sellerSharePct: cents !== null ? sharePct : null });
    if (ok) { setTitle(""); setDescription(""); setPosition(""); setAmount(""); }
  }

  if (error && !items) return <main><p role="alert">{error}</p><p><a href="/settlements">Back to settlements</a></p></main>;
  if (!items) return <main><p className="muted" role="status">Loading…</p></main>;
  const open = items.filter(d => OPEN.includes(d.status)), closed = items.filter(d => !OPEN.includes(d.status));
  const canRaise = side !== "agent";
  return (
    <main>
      <p><a href={`/settlements/${id}`}>Back to this settlement</a> · <a href={`/messages/${id}`}>Messages for this sale</a></p>
      <h1>Disputes</h1>
      <p>If you and the other side disagree about the inspection, finance, a repair or the cooling-off period, raise it here. Elena suggests a fair middle ground, you each accept, counter or ask for staff, and it goes to staff after three rounds or five days.</p>
      {error ? <p role="alert">{error}</p> : null}
      {open.map(d => <DisputeDetail key={d.id} d={d} busy={busy} post={async b => { await send(`/api/settlements/${id}/disputes/${d.id}`, b); }} />)}
      {open.length === 0 ? <p className="empty">No open disputes on this sale.</p> : null}

      {canRaise ? (
        <form className="dsp-form" onSubmit={e => void create(e)}>
          <h2>Raise a dispute</h2>
          <div className="dsp-grid">
            <label>What is it about?
              <select value={type} onChange={e => setType(e.target.value as DisputeType)}>{DISPUTE_TYPES.map(t => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select>
            </label>
            <label>Short title<input required maxLength={120} value={title} onChange={e => setTitle(e.target.value)} /></label>
          </div>
          <label>What happened?<textarea required rows={4} maxLength={2000} value={description} onChange={e => setDescription(e.target.value)} /></label>
          <label>What do you want to happen?<textarea required rows={3} maxLength={2000} value={position} onChange={e => setPosition(e.target.value)} /></label>
          <div className="dsp-grid">
            <label>Amount in dispute, in dollars (optional)<input inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} aria-invalid={badAmount} placeholder="e.g. 4500" /></label>
            {cents !== null ? <label>Share of {dollars(cents)} the seller should cover (0 to 100)<input type="number" min={0} max={100} step={1} required value={share} onChange={e => setShare(e.target.value)} /></label> : null}
          </div>
          {badAmount ? <p role="alert">Enter the amount as a number, like 4500.</p> : null}
          <button type="submit" disabled={busy || badAmount || badShare || !title.trim() || !description.trim() || !position.trim()}>Raise dispute</button>
        </form>
      ) : <p className="muted">Only the buyer or the owner can raise a dispute. You are told about each one and can follow it here.</p>}

      {closed.length ? <><h2>Closed disputes</h2>{closed.map(d => <DisputeDetail key={d.id} d={d} busy={busy} />)}</> : null}
    </main>
  );
}
