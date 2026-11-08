import type { ReactNode } from "react";
import type { PerfMetrics } from "../src/domain/agent-performance";
import { Stars } from "./marketplace/agents/ui";

export const days = (v?: number) => (v === undefined ? "–" : `${v} d`);
export const percent = (v?: number, sign = false) => (v === undefined ? "–" : `${sign && v > 0 ? "+" : ""}${v}%`);

/** One row of metric label / value pairs, shared by owner cards, the comparison table and the agent's own page. Every missing figure reads "–". */
export const METRIC_ROWS: { key: string; label: string; text: (m: PerfMetrics) => string }[] = [
  { key: "tts", label: "Avg days to sale", text: m => days(m.timeToSaleDays) },
  { key: "velocity", label: "Sales per month", text: m => String(m.dealVelocity) },
  { key: "price", label: "Price vs asking", text: m => percent(m.priceVariancePercent, true) },
  { key: "fall", label: "Fell through", text: m => percent(m.fallThroughRate) },
  { key: "sold", label: "Sales in period", text: m => String(m.sold) }
];

export function Rating({ m }: { m: PerfMetrics }): ReactNode {
  return <Stars value={m.satisfaction ?? null} count={m.ratingCount} />;
}
