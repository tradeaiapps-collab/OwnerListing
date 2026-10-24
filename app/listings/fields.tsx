import { useState } from "react";
import "../styles/search.css";
import { BOND_PATHWAY_LABELS, centsToInput } from "./ui";

export type BondState = "idle" | "saving" | "saved" | "error";

export interface ListingDefaults {
  title?: string;
  address?: string;
  jurisdiction?: string;
  transactionType?: string;
  useClass?: string;
  propertyType?: string;
  suburb?: string;
  postcode?: string;
  priceCents?: number;
  bedrooms?: number;
  bathrooms?: number;
  parking?: number;
}

/** The draft fields, shared by the create and edit pages. Read the values with listingFormBody(FormData). */
export function ListingFields({ defaults = {} }: { defaults?: ListingDefaults }) {
  const [tx, setTx] = useState(defaults.transactionType ?? "sale");
  const num = (name: string, label: string, v: number | undefined) => (
    <label className="field">{label}
      <input name={name} type="number" inputMode="numeric" min={0} max={20} step={1} defaultValue={v ?? ""} />
    </label>
  );
  return (
    <>
      <input name="title" placeholder="Title" maxLength={200} required defaultValue={defaults.title ?? ""} />
      <input name="address" placeholder="Address" maxLength={300} required defaultValue={defaults.address ?? ""} />
      <select name="jurisdiction" defaultValue={defaults.jurisdiction ?? "QLD"} aria-label="State">
        {["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].map(j => <option key={j}>{j}</option>)}
      </select>
      <select name="transactionType" value={tx} onChange={e => setTx(e.target.value)} aria-label="Sale or rent">
        <option value="sale">Sale</option>
        <option value="rent">Rental</option>
      </select>
      <select name="useClass" defaultValue={defaults.useClass ?? "residential"} aria-label="Use">
        <option value="residential">Residential</option>
        <option value="commercial">Commercial</option>
      </select>
      <select name="propertyType" defaultValue={defaults.propertyType ?? "house"} aria-label="Property type">
        {["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"].map(t => <option key={t}>{t}</option>)}
      </select>
      <div className="listing-details">
        <input name="suburb" placeholder="Suburb" maxLength={80} defaultValue={defaults.suburb ?? ""} aria-label="Suburb" autoComplete="address-level2" />
        <input name="postcode" placeholder="Postcode" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} defaultValue={defaults.postcode ?? ""} aria-label="Postcode" autoComplete="postal-code" />
        <label className="field price-field">{tx === "rent" ? "Rent per week (AUD)" : "Asking price (AUD)"}
          <input name="price" inputMode="decimal" placeholder={tx === "rent" ? "650" : "850000"} defaultValue={defaults.priceCents !== undefined ? centsToInput(defaults.priceCents) : ""} />
        </label>
        {num("bedrooms", "Bedrooms", defaults.bedrooms)}
        {num("bathrooms", "Bathrooms", defaults.bathrooms)}
        {num("parking", "Parking", defaults.parking)}
      </div>
    </>
  );
}

/** Rental bond pathway select with its saving, saved and error messages. */
export function BondPathwayField({ value, state, onChange }: { value: string; state: BondState; onChange: (e: React.ChangeEvent<HTMLSelectElement>) => void }) {
  return (
    <div className="stack field-group">
      <label htmlFor="bond-pathway">Where will the rental bond be held? The platform never holds it.</label>
      <select id="bond-pathway" value={value} onChange={onChange} disabled={state === "saving"}>
        <option value="" disabled>Choose an option</option>
        {Object.entries(BOND_PATHWAY_LABELS).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
      {state === "saving" && <small className="muted" role="status">Saving...</small>}
      {state === "saved" && <small className="muted" role="status">Bond arrangement saved.</small>}
      {state === "error" && <small role="alert">Could not save the bond arrangement. Try again.</small>}
    </div>
  );
}
