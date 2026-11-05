"use client";
import { MIN_COMPARE } from "../../src/domain/listing-compare";
import { useCompare } from "./compare-store";

/** "Compare" tick on a listing card. Disabled (with the reason) once four are picked. */
export function CompareToggle({ id, title }: { id: string; title: string }) {
  const { items, toggle, full } = useCompare();
  const on = items.some(x => x.id === id);
  const blocked = full && !on;
  return (
    <label className={`cmp-toggle${on ? " on" : ""}`} title={blocked ? "You can compare up to 4 properties. Remove one first." : undefined}>
      <input type="checkbox" checked={on} disabled={blocked} onChange={() => toggle({ id, title })} aria-label={`Compare ${title}`} />
      <span>Compare</span>
    </label>
  );
}

/** Bar at the bottom of the page while listings are picked. */
export function CompareTray() {
  const { items, remove, clear } = useCompare();
  if (items.length === 0) return null;
  const ready = items.length >= MIN_COMPARE;
  return (
    <aside className="cmp-tray" aria-label="Properties to compare">
      <ul className="cmp-picked">
        {items.map(i => (
          <li key={i.id}>
            <span className="cmp-name">{i.title}</span>
            <button type="button" className="secondary cmp-x" onClick={() => remove(i.id)} aria-label={`Remove ${i.title} from comparison`}>&times;</button>
          </li>
        ))}
      </ul>
      <div className="cmp-actions">
        <span className="muted" role="status">{ready ? `${items.length} of 4 picked` : "Pick one more to compare"}</span>
        <button type="button" className="secondary" onClick={clear}>Clear</button>
        {ready
          ? <a className="button" href={`/compare?ids=${items.map(i => i.id).join(",")}`}>Compare {items.length}</a>
          : <button type="button" disabled>Compare</button>}
      </div>
    </aside>
  );
}
