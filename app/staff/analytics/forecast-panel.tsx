"use client";
import { useEffect, useId, useRef, useState, type PointerEvent, type RefObject } from "react";
import { formatKpi } from "../../../src/domain/admin-dashboard";
import type { ForecastPoint, ForecastView } from "../../../src/domain/area-forecast";
import { DataTable } from "../charts";
import "../../styles/analytics-suite.css";

const aud = (c: number) => formatKpi(c, "cents");
const short = (c: number) => (c >= 100_000_000 ? `$${(c / 100_000_000).toFixed(c >= 1_000_000_000 ? 1 : 2)}m` : `$${Math.round(c / 100_000)}k`);

/** Axis bounds and ticks on a 1/2/5 step covering lo..hi with about four intervals. */
function niceScale(lo: number, hi: number): { min: number; max: number; ticks: number[] } {
  const raw = Math.max(1, hi - lo) / 4, p = 10 ** Math.floor(Math.log10(raw)), f = raw / p;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  const min = Math.max(0, Math.floor(lo / step) * step), max = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = min; v <= max + step / 2; v += step) ticks.push(v);
  return { min, max, ticks };
}

/** Width of the element in CSS pixels, so the chart draws at 1:1 and its text stays readable from phone to desktop. */
function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.round(e!.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  });
  return [ref, w];
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(2, 4)}`;
const TYPE_LABEL = (t: string) => (t === "all" ? "All types" : t[0]!.toUpperCase() + t.slice(1));
const signed = (n: number) => `${n > 0 ? "+" : ""}${n}%`;

/** Market forecast picker and chart. `endpoint` is the staff or agent route; both return the same view. */
export function ForecastPanel({ endpoint }: { endpoint: string }) {
  const [seg, setSeg] = useState({ area: "all", type: "all" });
  const [view, setView] = useState<ForecastView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(s: typeof seg) {
    setBusy(true); setError("");
    const r = await fetch(`${endpoint}?${new URLSearchParams(s)}`).catch(() => null);
    setBusy(false);
    if (!r || !r.ok) { setError(r?.status === 401 ? "Sign in to see forecasts." : r?.status === 403 ? "Your account cannot see forecasts." : "Could not load the forecast."); return; }
    setView((await r.json()).forecast as ForecastView);
  }
  useEffect(() => { void load(seg); }, []);

  const f = view?.forecast;
  const pairsFor = (area: string) => view?.options.pairs.filter(p => p.area.toLowerCase() === area.toLowerCase()).map(p => p.propertyType) ?? [];
  const typeChoices = seg.area === "all" ? view?.options.types.map(t => t.propertyType) ?? [] : pairsFor(seg.area);

  return (
    <section aria-label="Market forecast">
      <p className="an-lead">Where median sale prices are heading over the next 12 months, by suburb and property type, with the range the trend could reasonably fall in.</p>
      <form className="filters" onSubmit={e => { e.preventDefault(); void load(seg); }}>
        <label>Area
          <select value={seg.area} onChange={e => setSeg({ area: e.target.value, type: "all" })}>
            <option value="all">All areas</option>
            {view?.options.areas.map(a => <option key={a.area} value={a.area}>{a.area} ({a.sales} sales)</option>)}
          </select>
        </label>
        <label>Property type
          <select value={seg.type} onChange={e => setSeg({ ...seg, type: e.target.value })}>
            <option value="all">All types</option>
            {typeChoices.map(t => <option key={t} value={t}>{TYPE_LABEL(t)}</option>)}
          </select>
        </label>
        <button type="submit" disabled={busy}>{busy ? "Loading…" : "Show forecast"}</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {!view && !error && <p className="an-state" role="status">Loading the forecast…</p>}
      {f && f.state === "unavailable" && <p className="an-state">{f.message}</p>}
      {f && f.state === "ready" && (
        <>
          <div className="kpis">
            <Tile label="Trend price now" value={short(f.history[f.history.length - 1]!.fittedCents)} hint={`${aud(f.history[f.history.length - 1]!.fittedCents)} on the trend line, ${monthLabel(f.history[f.history.length - 1]!.month)}`} />
            <Tile label={`Forecast ${monthLabel(f.forecast[11]!.month)}`} value={short(f.forecast[11]!.midCents)} hint={`80% range ${short(f.forecast[11]!.low80Cents)} to ${short(f.forecast[11]!.high80Cents)}`} />
            <Tile label="12-month change" value={signed(f.annualChangePct)} hint={`80% range ${signed(f.lowAnnualChangePct)} to ${signed(f.highAnnualChangePct)}`} />
            <Tile label="Based on" value={`${f.sales} sales`} hint={`${f.months} months with sales`} />
          </div>
          <p className="fc-summary">
            <span className={`status-pill ${f.confidence === "good" ? "good" : f.confidence === "fair" ? "warn" : "bad"}`}>Confidence: {f.confidence}</span>
            {f.capped && <span className="status-pill warn">Trend capped at about 27% a year</span>}
          </p>
          <ForecastChart view={view!} />
        </>
      )}
      {view && <ul className="an-notes"><li>{view.method}</li></ul>}
    </section>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="kpi"><span className="kpi-label">{label}</span><strong className="kpi-value">{value}</strong><span className="kpi-change">{hint}</span></div>;
}

const H = 280, PAD = { l: 60, r: 12, t: 12, b: 32 };

function ForecastChart({ view }: { view: ForecastView }) {
  const f = view.forecast;
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const id = useId();
  const [wrap, W] = useWidth<HTMLDivElement>();
  if (f.state !== "ready") return null;
  const months = [...f.history.map(h => h.month), ...f.forecast.map(p => p.month)];
  const first = months[0]!;
  const idx = (m: string) => (Number(m.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(m.slice(5, 7)) - Number(first.slice(5, 7));
  const n = idx(months[months.length - 1]!) + 1;
  const all = [...f.history.map(h => h.medianCents), ...f.forecast.map(p => p.high95Cents)];
  const scale = niceScale(Math.min(...f.history.map(h => h.medianCents), ...f.forecast.map(p => p.low95Cents)), Math.max(...all));
  const top = scale.max, bottom = scale.min;
  const x = (i: number) => PAD.l + (i * (W - PAD.l - PAD.r)) / Math.max(1, n - 1);
  const y = (v: number) => PAD.t + (1 - (v - bottom) / (top - bottom)) * (H - PAD.t - PAD.b);
  const band = (lo: (p: ForecastPoint) => number, hi: (p: ForecastPoint) => number) => {
    const last = f.history[f.history.length - 1]!;
    const start = `${x(idx(last.month))},${y(last.fittedCents)}`;
    return [start, ...f.forecast.map(p => `${x(idx(p.month))},${y(hi(p))}`), ...[...f.forecast].reverse().map(p => `${x(idx(p.month))},${y(lo(p))}`)].join(" ");
  };
  const lastHist = f.history[f.history.length - 1]!;
  const ticks = scale.ticks;
  const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(W / 110))));
  const labelMonths = Array.from({ length: n }, (_, i) => i).filter(i => i % every === 0);
  const monthAt = (i: number) => { const d = new Date(Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1 + i, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };

  const hovered = hover === null ? null : monthAt(hover);
  const hHist = hovered ? f.history.find(h => h.month === hovered) : undefined;
  const hFc = hovered ? f.forecast.find(p => p.month === hovered) : undefined;
  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const i = Math.round(((((e.clientX - box.left) / box.width) * W - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  };
  const title = `${view.segment.area === "all" ? "All areas" : view.segment.area}, ${TYPE_LABEL(view.segment.propertyType).toLowerCase()}: median sale price and 12-month forecast`;

  return (
    <figure className="chart">
      <figcaption><span>{title}</span>
        <button type="button" className="link-button" aria-pressed={table} onClick={() => setTable(!table)}>{table ? "Show chart" : "Show table"}</button>
      </figcaption>
      <ul className="legend" aria-label="Series">
        <li><span className="swatch" aria-hidden="true" />Median sale price</li>
        <li><span className="swatch dash" aria-hidden="true" />Forecast</li>
        <li><span className="swatch band" aria-hidden="true" />80% and 95% ranges</li>
      </ul>
      {!table && (
        <div className="line-wrap" ref={wrap}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            <title id={`${id}-t`}>{title}</title>
            {ticks.map(t => (
              <g key={t}>
                <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
                <text className="axis" x={PAD.l - 6} y={y(t) + 4} textAnchor="end">{short(t)}</text>
              </g>
            ))}
            {labelMonths.map(i => <text key={i} className="axis" x={x(i)} y={H - 8} textAnchor={i === 0 ? "start" : i >= n - every / 2 - 1 ? "end" : "middle"}>{monthLabel(monthAt(i))}</text>)}
            <polygon className="fc-band95" points={band(p => p.low95Cents, p => p.high95Cents)} />
            <polygon className="fc-band80" points={band(p => p.low80Cents, p => p.high80Cents)} />
            <line className="fc-now" x1={x(idx(lastHist.month))} x2={x(idx(lastHist.month))} y1={PAD.t} y2={H - PAD.b} />
            <polyline className="fc-mid" points={[`${x(idx(lastHist.month))},${y(lastHist.fittedCents)}`, ...f.forecast.map(p => `${x(idx(p.month))},${y(p.midCents)}`)].join(" ")} />
            <polyline className="fc-hist" points={f.history.map(h => `${x(idx(h.month))},${y(h.medianCents)}`).join(" ")} />
            {f.history.map(h => <circle key={h.month} className="fc-dot" cx={x(idx(h.month))} cy={y(h.medianCents)} r={hovered === h.month ? 4.5 : 2.5} />)}
            {hover !== null && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} />}
          </svg>
          {hover !== null && (hHist || hFc) && (
            <div className="readout" style={{ left: `${Math.min(80, Math.max(20, (x(hover) / W) * 100))}%` }} role="status">
              <span className="readout-x">{monthLabel(hovered!)}</span>
              {hHist && <span><strong>{aud(hHist.medianCents)}</strong> median of {hHist.sales} sale{hHist.sales === 1 ? "" : "s"}</span>}
              {hFc && <span><strong>{aud(hFc.midCents)}</strong> forecast</span>}
              {hFc && <span>80%: {aud(hFc.low80Cents)} to {aud(hFc.high80Cents)}</span>}
            </div>
          )}
        </div>
      )}
      {table && (
        <DataTable head={["Month", "Median sale", "Sales", "Forecast", "80% range", "95% range"]} rows={[
          ...f.history.map(h => [monthLabel(h.month), aud(h.medianCents), h.sales, "–", "–", "–"]),
          ...f.forecast.map(p => [monthLabel(p.month), "–", "–", aud(p.midCents), `${aud(p.low80Cents)} to ${aud(p.high80Cents)}`, `${aud(p.low95Cents)} to ${aud(p.high95Cents)}`])
        ]} />
      )}
    </figure>
  );
}
