import { useState } from "react";
import { AMENITIES, AMENITY_LABELS } from "../../src/domain/listing-details";
import { BOND_PATHWAY_LABELS, centsToInput } from "./ui";
import { AddressField } from "./address-field";
import { WordingHint } from "./wording-hint";
import { ElenaListingAssistant, ElenaTip } from "./elena-listing-assistant";
import { fieldTips } from "../../src/domain/listing-assistant-tips";

export type BondState = "idle" | "saving" | "saved" | "error";

export interface ListingDefaults {
  title?: string;
  description?: string;
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
  amenities?: string[];
}

/** The draft fields, shared by the create and edit pages. Read the values with listingFormBody(FormData). */
export function ListingFields({ defaults = {}, photoCount }: { defaults?: ListingDefaults; photoCount?: number }) {
  const [tx, setTx] = useState(defaults.transactionType ?? "sale");
  const [title, setTitle] = useState(defaults.title ?? "");
  const [description, setDescription] = useState(defaults.description ?? "");
  const tips = fieldTips({ transactionType: tx === "rent" ? "rent" : "sale", propertyType: "house" });
  const num = (name: string, label: string, v: number | undefined, tip: string) => (
    <label className="field"><span>{label} <ElenaTip text={tip} /></span>
      <input name={name} type="number" inputMode="numeric" min={0} max={20} step={1} defaultValue={v ?? ""} />
    </label>
  );
  return (
    <>
      <ElenaListingAssistant {...(photoCount !== undefined ? { photoCount } : {})} />
      <fieldset className="form-section">
        <legend>The basics</legend>
        <label className="field"><span>Title <ElenaTip text={tips.title} /></span>
          <input name="title" placeholder="e.g. Renovated home with pool" maxLength={200} required value={title} onChange={e => setTitle(e.target.value)} />
        </label>
        <WordingHint text={title} field="title" />
        <label className="field"><span>Street address</span>
          <AddressField defaultValue={defaults.address ?? ""} />
        </label>
      </fieldset>
      <fieldset className="form-section">
        <legend>What you are listing</legend>
        <div className="form-grid">
          <label className="field">Sale or rent
            <select name="transactionType" value={tx} onChange={e => setTx(e.target.value)}>
              <option value="sale">Sale</option>
              <option value="rent">Rental</option>
            </select>
          </label>
          <label className="field">Use
            <select name="useClass" defaultValue={defaults.useClass ?? "residential"}>
              <option value="residential">Residential</option>
              <option value="commercial">Commercial</option>
            </select>
          </label>
          <label className="field">Property type
            <select name="propertyType" defaultValue={defaults.propertyType ?? "house"}>
              {["house", "unit", "townhouse", "land", "office", "retail", "industrial", "warehouse", "hospitality", "other"].map(t => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
            </select>
          </label>
          <label className="field">State
            <select name="jurisdiction" defaultValue={defaults.jurisdiction ?? "QLD"}>
              {["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].map(j => <option key={j}>{j}</option>)}
            </select>
          </label>
        </div>
      </fieldset>
      <fieldset className="form-section">
        <legend>Location and price</legend>
        <div className="form-grid">
          <label className="field"><span>Suburb <ElenaTip text={tips.suburb} /></span>
            <input name="suburb" maxLength={80} defaultValue={defaults.suburb ?? ""} autoComplete="address-level2" />
          </label>
          <label className="field">Postcode
            <input name="postcode" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} defaultValue={defaults.postcode ?? ""} autoComplete="postal-code" />
          </label>
          <label className="field span-all"><span>{tx === "rent" ? "Rent per week (AUD)" : "Asking price (AUD)"} <ElenaTip text={tips.price} /></span>
            <input name="price" inputMode="decimal" placeholder={tx === "rent" ? "650" : "850000"} defaultValue={defaults.priceCents !== undefined ? centsToInput(defaults.priceCents) : ""} />
          </label>
        </div>
      </fieldset>
      <fieldset className="form-section">
        <legend>Description</legend>
        <label className="field"><span>Describe the property <ElenaTip text={tips.description} /></span>
          <textarea name="description" rows={8} maxLength={5000} value={description} onChange={e => setDescription(e.target.value)}
            placeholder="Rooms, condition, outdoor space, what is nearby. Describe the property, not who should live there." />
        </label>
        <small className="muted">Listings can&apos;t say who may or may not buy or rent (for example by age, family, race, religion, sex or disability). We check the wording as you type.</small>
        <WordingHint text={description} field="description" />
      </fieldset>
      <fieldset className="form-section">
        <legend>Features</legend>
        <div className="form-grid cols-3">
          {num("bedrooms", "Bedrooms", defaults.bedrooms, tips.bedrooms)}
          {num("bathrooms", "Bathrooms", defaults.bathrooms, tips.bathrooms)}
          {num("parking", "Parking spaces", defaults.parking, tips.parking)}
        </div>
        <fieldset className="mf-group">
          <legend>Extras buyers can filter by <ElenaTip text={tips.amenities} /></legend>
          <div className="amenity-checks">
            {AMENITIES.map(a => (
              <label key={a} className="check"><input type="checkbox" name="amenities" value={a} defaultChecked={defaults.amenities?.includes(a) ?? false} /><span>{AMENITY_LABELS[a]}</span></label>
            ))}
          </div>
        </fieldset>
      </fieldset>
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
