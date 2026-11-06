"use client";
import { MAX_COMPARE, MIN_COMPARE } from "../../src/domain/listing-compare";
import { useCompare } from "./compare-store";

/** "Add to compare" button on a listing card. Shows when the listing is in the comparison and how many are picked. */
export function CompareToggle({ id, title }: { id: string; title: string }) {
  const { items, toggle, full } = useCompare();
  const on = items.some(x => x.id === id);
  const blocked = full && !on;
  return (
    <button type="button" className={`cmp-toggle${on ? " on" : ""}`} aria-pressed={on} disabled={blocked}
      title={blocked ? "You can compare up to 4 properties. Remove one first." : undefined}
      onClick={() => toggle({ id, title })} aria-label={`${on ? "Remove from comparison" : "Add to compare"}: ${title}`}>
      <span aria-hidden="true">{on ? "\u2713" : "+"}</span>
      <span>{on ? `In comparison (${items.length} of ${MAX_COMPARE})` : blocked ? "Comparison full (4)" : "Add to compare"}</span>
    </button>
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
        <span className="muted" role="status">{ready ? `${items.length} of ${MAX_COMPARE} picked` : `${items.length} of ${MAX_COMPARE} picked. Add ${MIN_COMPARE - items.length} more to compare.`}</span>
        <button type="button" className="secondary" onClick={clear}>Clear</button>
        {ready
          ? <a className="button" href={`/compare?ids=${items.map(i => i.id).join(",")}`}>Compare {items.length}</a>
          : <button type="button" disabled>Compare</button>}
      </div>
    </aside>
  );
}
