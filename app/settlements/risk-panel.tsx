import { dateLabel, STAGE_LABEL, type Stage } from "../../src/domain/settlement";

export interface RiskData {
  score: number; band: "low" | "medium" | "high"; headline: string; reason: string; recommendation: string; predictedFallthroughDate: string | null;
  previousScore: number | null; trend: "worse" | "better" | "same"; stage: Stage;
  factors: { key: string; label: string; points: number; detail: string }[];
}
export const BAND_LABEL = { low: "Low risk", medium: "Medium risk", high: "High risk" } as const;
export const TREND_LABEL = { worse: "Worse", better: "Better", same: "Steady" } as const;

/** Elena's risk read on one settlement: score, why, what to do next. Advice only; nothing is blocked or sent because of it. */
export function RiskPanel({ r, who }: { r: RiskData; who: "party" | "staff" }) {
  const adds = r.factors.filter(f => f.points > 0), offsets = r.factors.filter(f => f.points < 0);
  return (
    <section className={`risk-panel risk-${r.band}`} aria-label="Settlement risk">
      <h2>{r.headline}</h2>
      <p><span className={`risk-badge risk-${r.band}`}>{BAND_LABEL[r.band]} · {r.score}</span> <span className="risk-trend">{TREND_LABEL[r.trend]}{r.previousScore != null && r.trend !== "same" ? ` (was ${r.previousScore})` : ""} · at {STAGE_LABEL[r.stage]}</span></p>
      {adds.length ? <ul>{adds.map(f => <li key={f.key}><strong>{f.label}</strong> <span className="pts">+{f.points}</span>. {f.detail}</li>)}</ul> : <p className="muted">{r.reason}</p>}
      {offsets.length ? <p className="muted">{offsets.map(f => `${f.label} (${f.points})`).join(", ")}</p> : null}
      <p><strong>Suggested next step:</strong> {r.recommendation}</p>
      {r.predictedFallthroughDate ? <p className="muted">If nothing changes, this sale could fall through around {dateLabel(r.predictedFallthroughDate)}. This is an estimate.</p> : null}
      <p className="muted">{who === "party" ? "Elena's estimate from the dates and checklists on this timeline. It is advice, not a decision." : "Rules-based estimate. It does not block or message anyone."}</p>
    </section>
  );
}
