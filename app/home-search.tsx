"use client";
import { useId, useState } from "react";

type Tab = "sale" | "rent" | "sell";
const TABS: readonly [Tab, string][] = [["sale", "Buy"], ["rent", "Rent"], ["sell", "Sell your home"]];

/**
 * Hero search card. Buy and Rent submit a plain GET to /listings (works without JavaScript: the form renders with Buy selected).
 * "Sell your home" swaps the fields for the owner call to action. Suburb suggestions are suburbs with a published listing.
 */
export default function HomeSearch({ suburbs }: { suburbs: string[] }) {
  const [tab, setTab] = useState<Tab>("sale");
  const id = useId();
  const listId = `${id}-suburbs`;
  return (
    <div className="hs">
      <div className="hs-tabs" role="tablist" aria-label="What do you want to do?">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" id={`${id}-t-${k}`} aria-selected={tab === k} aria-controls={`${id}-panel`} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-t-${tab}`}>
        {tab === "sell" ? (
          <div className="hs-sell">
            <p><strong>List your home yourself.</strong> Create the listing, meet verified buyers and decide on every offer. No commission.</p>
            <div className="hs-actions">
              <a className="button" href="/listings/new">List your property</a>
              <a className="button secondary" href="/plans">See plans and fees</a>
            </div>
          </div>
        ) : (
          <form className="hs-form" action="/listings" method="get" role="search" aria-label="Search listings">
            <input type="hidden" name="type" value={tab} />
            <label className="hs-f hs-loc">Suburb or postcode
              <input name="location" list={suburbs.length > 0 ? listId : undefined} autoComplete="off" maxLength={80} placeholder="e.g. Paddington or 4064" />
            </label>
            {suburbs.length > 0 && <datalist id={listId}>{suburbs.map(s => <option key={s} value={s} />)}</datalist>}
            <label className="hs-f">Bedrooms
              <select name="beds" defaultValue="">
                <option value="">Any</option>
                {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}+</option>)}
              </select>
            </label>
            <label className="hs-f">{tab === "rent" ? "Max rent (AUD per week)" : "Max price (AUD)"}
              <input name="price" inputMode="numeric" pattern="[0-9]*" maxLength={10} placeholder="No limit" />
            </label>
            <button type="submit">Search</button>
          </form>
        )}
      </div>
    </div>
  );
}
