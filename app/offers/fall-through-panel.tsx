"use client";
import { useCallback, useEffect, useState } from "react";
import { REASON_LABEL, RULES_CONFIRMED, STATUS_LABEL, type FallThroughReason } from "../../src/domain/sale-fall-through";
import type { FallThroughCase, FallThroughView } from "../../src/server/sale-fall-through-db";
import { money } from "../commissions-ui";
import { JSON_HEADERS } from "../listings/ui";

type Preview = { refundCents: number; releaseCents: number; penaltyCents: number; penaltyUnconfirmed: boolean; heldCents: number; basis: string; rulesConfirmed: boolean };
type Mode = "idle" | "form" | "preview" | "dispute" | "agree" | "withdraw";

/**
 * "The sale fell through" for an accepted offer, from the buyer's or the owner's side (`url` is that side's API route). The rules propose
 * what happens to the deposit held in trust; the other side agrees or disputes. Nothing moves here: staff pay out in the two-person flow.
 */
export default function FallThroughPanel({ url, viewer, offerStatus, onChange }: { url: string; viewer: "buyer" | "owner"; offerStatus: string; onChange?: () => void }) {
  const [view, setView] = useState<FallThroughView | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [mode, setMode] = useState<Mode>("idle");
  const [reason, setReason] = useState<FallThroughReason | "">("");
  const [note, setNote] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void fetch(url).then(async r => {
      if (r.ok) { setView(await r.json()); setError(""); } else if (r.status !== 404) setError("Could not load this.");
    }).catch(() => setError("Could not load this."));
  }, [url]);
  useEffect(load, [load]);

  const send = async (body: Record<string, unknown>) => {
    setBusy(true); setNotice(""); setError("");
    const r = await fetch(url, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) }).catch(() => null);
    const d = r ? await r.json().catch(() => ({})) : {};
    setBusy(false);
    return { ok: Boolean(r?.ok), status: r?.status ?? 0, data: d as Record<string, unknown> };
  };
  const done = (msg: string) => { setNotice(msg); setMode("idle"); setNote(""); setReason(""); setPreview(null); load(); onChange?.(); };
  const problem = (r: { status: number; data: Record<string, unknown> }) =>
    setError(r.data["code"] === "mfa_required" ? "Confirm it's you with your second sign-in step (Settings, then Security), then try again." : String(r.data["error"] ?? "That did not work."));

  if (!view) return error ? <p role="alert">{error}</p> : null;
  const live = view.cases.find(c => ["proposed", "disputed", "agreed"].includes(c.status));
  const last = live ?? view.cases[0];
  if (!live && !last && offerStatus !== "accepted") return null;
  const theirTurn = live?.status === "proposed" && live.raisedByParty !== viewer;
  const mine = live?.raisedByParty === viewer;
  const other = viewer === "buyer" ? "owner" : "buyer";

  return (
    <section className="panel ft-panel" aria-labelledby="ft-h">
      <h2 id="ft-h">If the sale falls through</h2>
      {notice && <p role="status" className="notice">{notice}</p>}
      {error && <p role="alert" className="staff-notice">{error}</p>}

      {last && <CaseCard c={last} viewer={viewer} />}

      {live?.status === "proposed" && theirTurn && mode === "idle" && (
        <>
          <p>The {other} says the contract will not go ahead. Do you agree with this outcome for the deposit?</p>
          <div className="actions">
            <button type="button" onClick={() => setMode("agree")}>Agree</button>
            <button type="button" className="secondary" onClick={() => setMode("dispute")}>Dispute</button>
          </div>
        </>
      )}
      {mode === "agree" && (
        <div className="confirm-box" role="alertdialog" aria-label="Agree to this outcome?">
          <strong>Agree to this outcome?</strong>
          <p>The sale is then marked as fallen through and our team arranges the payments out of the solicitor's trust account. This cannot be undone here.</p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={async () => { const r = await send({ action: "respond", decision: "agree" }); r.ok ? done("You agreed. The sale is marked as fallen through.") : problem(r); }}>{busy ? "Saving…" : "Yes, agree"}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setMode("idle")}>Cancel</button>
          </div>
        </div>
      )}
      {mode === "dispute" && (
        <form className="offer-form" onSubmit={async e => { e.preventDefault(); const r = await send({ action: "respond", decision: "dispute", note }); r.ok ? done("You disputed it. The deposit is frozen until we record an agreement or court order.") : problem(r); }}>
          <p>Disputing freezes the deposit. Nothing is paid out until we record an agreement between you or a court order.</p>
          <label>Why do you dispute it? (10+ characters)<textarea value={note} onChange={e => setNote(e.target.value)} maxLength={1000} rows={3} required minLength={10} /></label>
          <div className="actions">
            <button type="submit" disabled={busy || note.trim().length < 10}>{busy ? "Saving…" : "Dispute and freeze the deposit"}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setMode("idle")}>Cancel</button>
          </div>
        </form>
      )}
      {live?.status === "proposed" && mine && mode !== "withdraw" && (
        <div className="actions"><button type="button" className="secondary" onClick={() => setMode("withdraw")}>Withdraw this request</button></div>
      )}
      {mode === "withdraw" && (
        <div className="confirm-box" role="alertdialog" aria-label="Withdraw this request?">
          <strong>Withdraw this request?</strong>
          <p>The sale carries on and the deposit is no longer frozen.</p>
          <div className="actions">
            <button type="button" disabled={busy} onClick={async () => { const r = await send({ action: "withdraw" }); r.ok ? done("Withdrawn.") : problem(r); }}>{busy ? "Saving…" : "Yes, withdraw"}</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => setMode("idle")}>Cancel</button>
          </div>
        </div>
      )}

      {!live && offerStatus === "accepted" && (
        view.canRaise.ok ? (
          mode === "idle" ? (
            <>
              <p className="muted">If the contract will not go ahead, tell us why. We show what would happen to the deposit, and the {other} can agree or dispute it.</p>
              <div className="actions"><button type="button" className="secondary" onClick={() => setMode("form")}>The sale fell through</button></div>
            </>
          ) : (
            <form className="offer-form" onSubmit={async e => {
              e.preventDefault();
              if (mode === "form") {
                const r = await send({ action: "preview", reason });
                if (r.ok) { setPreview(r.data as unknown as Preview); setMode("preview"); } else problem(r);
              } else {
                const r = await send({ action: "raise", reason, note: note || undefined });
                r.ok ? done(`Sent to the ${other}. The deposit is frozen until they answer.`) : problem(r);
              }
            }}>
              <label>Why did it fall through?
                <select value={reason} onChange={e => { setReason(e.target.value as FallThroughReason); setMode("form"); setPreview(null); }} required>
                  <option value="" disabled>Choose a reason</option>
                  {view.reasons.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </label>
              <label>Anything to add? <span className="hint">(optional)</span><textarea value={note} onChange={e => setNote(e.target.value)} maxLength={1000} rows={2} /></label>
              {preview && mode === "preview" && <Outcome o={preview} />}
              <div className="actions">
                <button type="submit" disabled={busy || !reason}>{busy ? "Working…" : mode === "preview" ? `Send to the ${other}` : "Show what would happen"}</button>
                <button type="button" className="secondary" disabled={busy} onClick={() => { setMode("idle"); setPreview(null); }}>Cancel</button>
              </div>
            </form>
          )
        ) : <p className="muted">{view.canRaise.reason}</p>
      )}
    </section>
  );
}

function Outcome({ o }: { o: Pick<Preview, "refundCents" | "releaseCents" | "penaltyCents" | "penaltyUnconfirmed" | "heldCents" | "basis" | "rulesConfirmed"> }) {
  return (
    <div className="ft-outcome">
      <dl className="od-terms">
        <div><dt>Held in trust</dt><dd>{money(o.heldCents)}</dd></div>
        <div><dt>Back to the buyer</dt><dd>{money(o.refundCents)}</dd></div>
        <div><dt>To the seller</dt><dd>{money(o.releaseCents)}{o.penaltyCents > 0 ? <span className="muted"> (penalty)</span> : null}</dd></div>
      </dl>
      <p>{o.basis}</p>
      {!o.rulesConfirmed && <p className="ai-note">This is an estimate from our current state rules, which a lawyer has not reviewed. Our team checks it before any money is paid, and it is not legal advice.</p>}
    </div>
  );
}

function CaseCard({ c, viewer }: { c: FallThroughCase; viewer: "buyer" | "owner" }) {
  const who = c.raisedByParty === viewer ? "You" : `The ${c.raisedByParty}`;
  return (
    <div className="ft-case">
      <p><span className={`badge badge-${c.status === "disputed" ? "countered" : c.status === "withdrawn" ? "withdrawn" : "agreed"}`}>{c.status === "proposed" && c.raisedByParty !== viewer ? "Needs your answer" : STATUS_LABEL[c.status]}</span></p>
      <p>{who} said: <strong>{REASON_LABEL[c.reason]}</strong>.</p>
      {c.note && <p className="muted">“{c.note}”</p>}
      <Outcome o={{ ...c, rulesConfirmed: RULES_CONFIRMED }} />
      {c.disputeReason && <p>Dispute: {c.disputeReason}</p>}
      {c.status === "disputed" && <p className="staff-notice">The deposit is frozen. Our team will record an agreement between you or a court order, then arrange the payments.</p>}
      {c.status === "agreed" && <p className="muted">The sale is marked as fallen through. Our team requests the payments from the solicitor's trust account; a second person approves each one.</p>}
      {c.status === "resolved" && <p className="muted">All payments for this outcome have been approved.</p>}
    </div>
  );
}
