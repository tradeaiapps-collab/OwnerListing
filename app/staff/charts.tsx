"use client";
import { useId, useState, type PointerEvent } from "react";
import { changePercent, formatKpi, type Kpi } from "../../src/domain/admin-dashboard";
import "../styles/admin.css";

/**
 * Small chart kit for the admin screens: inline SVG, no chart library. Colours come from the --series-N tokens in admin.css (light and
 * dark steps chosen separately). Every chart has a table view, so no value is reachable only by hovering or by colour.
 */

export function KpiTile({ kpi }: { kpi: Kpi }) {
  const change = kpi.previous === undefined ? null : changePercent(kpi.value, kpi.previous);
  return (
    <div className="kpi" title={kpi.hint}>
      <span className="kpi-label">{kpi.label}</span>
      <strong className="kpi-value">{formatKpi(kpi.value, kpi.unit)}</strong>
      {kpi.previous !== undefined && (
        <span className="kpi-change">
          {change === null ? "No earlier figure" : `${change > 0 ? "▲" : change < 0 ? "▼" : "■"} ${Math.abs(change)}% vs previous period`}
        </span>
      )}
    </div>
  );
}

export interface BarDatum { key: string; label: string; value: number }

/** Horizontal bars for one measure across categories, each bar labelled with its value. */
export function BarList({ title, data, format = String }: { title: string; data: readonly BarDatum[]; format?: (n: number) => string }) {
  const max = Math.max(1, ...data.map(d => d.value));
  const [table, setTable] = useState(false);
  return (
    <figure className="chart">
      <figcaption><span>{title}</span><TableToggle on={table} set={setTable} /></figcaption>
      {data.length === 0 && <p className="empty">No data yet.</p>}
      {!table && data.length > 0 && (
        <ul className="bars">
          {data.map(d => (
            <li key={d.key} title={`${d.label}: ${format(d.value)}`}>
              <span className="bar-label">{d.label}</span>
              <span className="bar-track"><span className="bar-fill" style={{ width: `${(d.value / max) * 100}%` }} /></span>
              <span className="bar-value">{format(d.value)}</span>
            </li>
          ))}
        </ul>
      )}
      {table && <DataTable head={["Category", "Value"]} rows={data.map(d => [d.label, format(d.value)])} />}
    </figure>
  );
}

export interface Series { key: string; label: string; values: readonly number[] }

const W = 640, H = 240, PAD = { l: 64, r: 16, t: 12, b: 32 };

/** Rounds the top of the y axis up to a 1/2/5 step so gridlines land on readable numbers. */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/**
 * Lines over time on one shared y axis (at most three series; never two scales). A crosshair follows the pointer and the readout lists
 * every series at that point. Keyboard users and screen readers get the same values from the table view.
 */
export function LineChart({ title, labels, series, format = String }: {
  title: string; labels: readonly string[]; series: readonly Series[]; format?: (n: number) => string;
}) {
  const shown = series.slice(0, 3);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const id = useId();
  const top = niceMax(Math.max(0, ...shown.flatMap(s => s.values)));
  const n = labels.length;
  const x = (i: number) => PAD.l + (n <= 1 ? (W - PAD.l - PAD.r) / 2 : (i * (W - PAD.l - PAD.r)) / (n - 1));
  const y = (v: number) => PAD.t + (1 - v / top) * (H - PAD.t - PAD.b);
  const ticks = [0, 0.5, 1].map(f => f * top);
  const every = Math.max(1, Math.ceil(n / 6));

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - box.left) / box.width) * W;
    const i = n <= 1 ? 0 : Math.round(((px - PAD.l) / (W - PAD.l - PAD.r)) * (n - 1));
    setHover(Math.min(n - 1, Math.max(0, i)));
  };

  return (
    <figure className="chart">
      <figcaption><span>{title}</span><TableToggle on={table} set={setTable} /></figcaption>
      {shown.length > 1 && (
        <ul className="legend" aria-label="Series">
          {shown.map((s, i) => <li key={s.key}><span className={`swatch s${i + 1}`} aria-hidden="true" />{s.label}</li>)}
        </ul>
      )}
      {n === 0 && <p className="empty">No data for this period.</p>}
      {!table && n > 0 && (
        <div className="line-wrap">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${id}-t`} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
            <title id={`${id}-t`}>{title}</title>
            {ticks.map(t => (
              <g key={t}>
                <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} />
                <text className="axis" x={PAD.l - 6} y={y(t) + 4} textAnchor="end">{format(t)}</text>
              </g>
            ))}
            {labels.map((l, i) => ((i % every === 0 && n - 1 - i >= Math.ceil(every / 2)) || i === n - 1) && (
              <text key={l + i} className="axis" x={x(i)} y={H - 8} textAnchor={n > 1 && i === n - 1 ? "end" : i === 0 && n > 1 ? "start" : "middle"}>{l}</text>
            ))}
            {shown.map((s, si) => (
              <g key={s.key} className={`series s${si + 1}`}>
                <polyline points={s.values.map((v, i) => `${x(i)},${y(v)}`).join(" ")} />
                {n <= 31 && s.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={hover === i ? 4.5 : 0} />)}
              </g>
            ))}
            {hover !== null && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={H - PAD.b} />}
          </svg>
          {hover !== null && (
            <div className="readout" style={{ left: `${(x(hover) / W) * 100}%` }} role="status">
              <span className="readout-x">{labels[hover]}</span>
              {shown.map((s, si) => (
                <span key={s.key}><span className={`swatch s${si + 1}`} aria-hidden="true" /><strong>{format(s.values[hover] ?? 0)}</strong> {s.label}</span>
              ))}
            </div>
          )}
        </div>
      )}
      {table && <DataTable head={["Period", ...shown.map(s => s.label)]} rows={labels.map((l, i) => [l, ...shown.map(s => format(s.values[i] ?? 0))])} />}
    </figure>
  );
}

function TableToggle({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return <button type="button" className="link-button" aria-pressed={on} onClick={() => set(!on)}>{on ? "Show chart" : "Show table"}</button>;
}

export function DataTable({ head, rows }: { head: readonly string[]; rows: readonly (readonly (string | number)[])[] }) {
  return (
    <div className="table-wrap"><table>
      <thead><tr>{head.map(h => <th key={h} scope="col">{h}</th>)}</tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody>
    </table></div>
  );
}
