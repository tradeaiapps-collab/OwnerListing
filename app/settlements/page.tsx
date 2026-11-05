"use client";
import { useEffect, useState } from "react";
import { dateLabel, STAGE_LABEL, STUCK_DAYS, type Stage } from "../../src/domain/settlement";
import "../styles/offers.css";
import "../styles/settlement.css";

interface Row {
  id: string; listingTitle: string; side: "buyer" | "seller" | "agent"; currentStage: Stage; completed: boolean; fellThrough: boolean;
  doneStages: number; totalStages: number; stuck: { stuck: boolean; days: number; blocked: boolean }; nextTarget: string | null;
}
const SIDE: Record<Row["side"], string> = { buyer: "You are the buyer", seller: "You are the owner", agent: "You are the agent" };

/** The signed-in person's settlements, as buyer, owner or agent. Agents see stuck ones first. */
export default function Settlements() {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/settlements")
      .then(async r => {
        const d = await r.json().catch(() => ({}));
        if (r.ok) setRows(d.settlements);
        else setError(r.status === 401 ? "Sign in to see your settlements." : d.error ?? "Could not load your settlements.");
      })
      .catch(() => setError("Could not load your settlements."));
  }, []);
  const stuck = rows?.filter(r => r.stuck.stuck).length ?? 0;

  return (
    <main>
      <h1>Settlements</h1>
      <p>Follow each accepted offer from deposit to settlement. This is a tracker: your solicitors or conveyancer handle the legal steps.</p>
      {error ? <p role="alert">{error}</p> : null}
      {!error && rows === null ? <p className="muted" role="status">Loading…</p> : null}
      {rows && stuck > 0 ? <p role="status"><strong>{stuck} {stuck === 1 ? "sale needs" : "sales need"} attention.</strong> A stage is flagged when it is blocked or has been open more than {STUCK_DAYS} days.</p> : null}
      {rows && rows.length === 0 ? <p className="empty">No settlements yet. Once an offer is accepted, the owner or their agent can start tracking it.</p> : null}
      <ul className="settle-list">
        {rows?.map(r => (
          <li key={r.id}>
            <div><strong>{r.listingTitle}</strong>{" "}
              {r.fellThrough ? <span className="badge badge-fallen_through">Fell through</span> : r.completed ? <span className="badge badge-done">Settled</span> : r.stuck.stuck ? <span className="badge badge-stuck">{r.stuck.blocked ? "Blocked" : `Stuck ${r.stuck.days} days`}</span> : null}
            </div>
            <small className="muted">{SIDE[r.side]} · {r.fellThrough ? "Closed" : STAGE_LABEL[r.currentStage]}{r.nextTarget && !r.completed && !r.fellThrough ? ` · next date ${dateLabel(r.nextTarget)}` : ""}</small>
            <div className="settle-meter"><progress max={r.totalStages} value={r.doneStages} aria-label="Stages completed" /> <span>{r.doneStages} of {r.totalStages}</span></div>
            <div><a href={`/settlements/${r.id}`}>Open timeline</a></div>
          </li>
        ))}
      </ul>
    </main>
  );
}
