"use client";
import { useEffect, useState } from "react";
import { AU_BOUNDS } from "../../src/domain/listing-details";
import { LocationMap } from "./location-map";

/**
 * A small map for an address that has not been saved yet (the new-listing wizard). Geocodes the text with the same
 * lookup the draft uses; nothing is saved. Shows nothing when the address cannot be found.
 */
export function AddressPreviewMap({ address }: { address: string }) {
  const [pt, setPt] = useState<{ lat: number; lng: number } | null>(null);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");
  useEffect(() => {
    const q = address.trim();
    if (q.length < 6) { setPt(null); setState("idle"); return; }
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setState("loading");
      fetch(`/api/address/geocode?${new URLSearchParams({ q })}`, { signal: ctrl.signal, headers: { accept: "application/json" } })
        .then(async r => ({ ok: r.ok, d: await r.json().catch(() => ({})) }))
        .then(({ ok, d }) => {
          const good = ok && typeof d.lat === "number" && typeof d.lng === "number" && d.lat >= AU_BOUNDS.south && d.lat <= AU_BOUNDS.north && d.lng >= AU_BOUNDS.west && d.lng <= AU_BOUNDS.east;
          setPt(good ? { lat: d.lat, lng: d.lng } : null); setState(good ? "idle" : "failed");
        })
        .catch(() => { if (!ctrl.signal.aborted) { setPt(null); setState("failed"); } });
    }, 500);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [address]);
  if (pt) return <div className="loc-preview"><LocationMap key={`${pt.lat},${pt.lng}`} latitude={pt.lat} longitude={pt.lng} title="your property" address={address} transactionType="sale" /></div>;
  if (state === "loading") return <p className="muted" role="status">Finding the address on the map...</p>;
  if (state === "failed") return <p className="muted" role="status">The map could not find this address. You can place the pin after you save the draft.</p>;
  return null;
}
