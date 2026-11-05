"use client";
import { useState } from "react";
import { AMENITIES, AMENITY_LABELS, AU_BOUNDS } from "../../src/domain/listing-details";
import { MAX_RADIUS_KM } from "../../src/domain/listing-search";
import type { FilterForm } from "./url-params";

const RADII = ["2", "5", "10", "25", "50", String(MAX_RADIUS_KM)];

/** Features and distance filters. Sits inside the search form, collapsed until needed (open when one is in use). */
export function MoreFilters({ form, setForm }: { form: FilterForm; setForm: (f: (p: FilterForm) => FilterForm) => void }) {
  const [msg, setMsg] = useState("");
  const chosen = form.amenities ? form.amenities.split(",") : [];
  const toggle = (a: string) => setForm(f => {
    const cur = f.amenities ? f.amenities.split(",") : [];
    return { ...f, amenities: AMENITIES.filter(x => (x === a ? !cur.includes(a) : cur.includes(x))).join(",") };
  });
  const locate = () => {
    setMsg("");
    if (!("geolocation" in navigator)) { setMsg("Your browser can't share your location. Search a suburb instead."); return; }
    navigator.geolocation.getCurrentPosition(
      pos => {
        const { latitude: la, longitude: lo } = pos.coords;
        if (la < AU_BOUNDS.south || la > AU_BOUNDS.north || lo < AU_BOUNDS.west || lo > AU_BOUNDS.east) { setMsg("Distance search works within Australia."); return; }
        setForm(f => ({ ...f, lat: la.toFixed(5), lng: lo.toFixed(5), radiusKm: f.radiusKm || "10" }));
      },
      () => setMsg("Couldn't get your location. Allow location access, or search a suburb instead."),
      { maximumAge: 300_000, timeout: 10_000 }
    );
  };
  const located = form.lat !== "" && form.lng !== "";
  return (
    <details className="more-filters" open={chosen.length > 0 || located}>
      <summary>More filters{chosen.length + (located ? 1 : 0) > 0 ? ` (${chosen.length + (located ? 1 : 0)})` : ""}</summary>
      <fieldset className="mf-group">
        <legend>Features</legend>
        <div className="mf-checks">
          {AMENITIES.map(a => (
            <label key={a} className="check"><input type="checkbox" checked={chosen.includes(a)} onChange={() => toggle(a)} /><span>{AMENITY_LABELS[a]}</span></label>
          ))}
        </div>
      </fieldset>
      <fieldset className="mf-group">
        <legend>Distance</legend>
        <div className="mf-distance">
          <button type="button" className="secondary" onClick={locate}>{located ? "Update my location" : "Use my location"}</button>
          <select aria-label="Distance from your location" value={form.radiusKm} disabled={!located} onChange={e => setForm(f => ({ ...f, radiusKm: e.target.value }))}>
            <option value="">Distance</option>
            {RADII.map(r => <option key={r} value={r}>Within {r} km</option>)}
          </select>
          {located && <button type="button" className="secondary" onClick={() => setForm(f => ({ ...f, lat: "", lng: "", radiusKm: "" }))}>Remove</button>}
        </div>
        <small className="muted" role="status">{msg || (located ? "Searching around the point you chose. Listings without a map pin are left out." : "Your location is used for this search only and is not stored.")}</small>
      </fieldset>
    </details>
  );
}
