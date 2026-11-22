import { useRef, useState } from "react";
import { AMENITIES, AMENITY_LABELS, centsToDollarField, priceInputToCents } from "../../src/domain/listing-details";
import { BOND_PATHWAY_LABELS, centsToInput } from "./ui";
import { AddressField } from "./address-field";
import { WordingHint } from "./wording-hint";
import { ElenaListingAssistant, ElenaTip } from "./elena-listing-assistant";
import { extractFeatures, featureMismatches } from "../../src/domain/listing-features-extract";
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
export type FieldStep = "basics" | "details" | "description" | "location" | "none";

/** With `step` set, only that step's fields are shown; every field stays mounted so the form still submits them all. */
export function ListingFields({ defaults = {}, photoCount, step }: { defaults?: ListingDefaults; photoCount?: number; step?: FieldStep }) {
  const show = (s: FieldStep) => step === undefined || step === s;
  const [tx, setTx] = useState(defaults.transactionType ?? "sale");
  const [title, setTitle] = useState(defaults.title ?? "");
  const [description, setDescription] = useState(defaults.description ?? "");
  const [counts, setCounts] = useState<Record<"bedrooms" | "bathrooms" | "parking", string>>({
    bedrooms: String(defaults.bedrooms ?? ""), bathrooms: String(defaults.bathrooms ?? ""), parking: String(defaults.parking ?? "")
  });
  const [amenities, setAmenities] = useState<string[]>(defaults.amenities ?? []);
  const touched = useRef(new Set<string>());
  const [filled, setFilled] = useState("");
  /** Elena reads the description and fills the Features section; anything the owner set by hand is left alone. */
  const onDescription = (text: string) => {
    setDescription(text);
    const f = extractFeatures(text);
    const nextCounts = { ...counts };
    let changed = false;
    for (const k of ["bedrooms", "bathrooms", "parking"] as const) {
      const v = f[k];
      if (v !== undefined && !touched.current.has(k) && nextCounts[k] !== String(v)) { nextCounts[k] = String(v); changed = true; }
    }
    const add = f.amenities.filter(a => !amenities.includes(a) && !touched.current.has(`a:${a}`));
    if (changed) setCounts(nextCounts);
    if (add.length) setAmenities([...amenities, ...add]);
    const notes = changed || add.length > 0;
    setFilled(notes ? "Elena filled the Features below from your description. You can change any of them." : filled);
  };
  const mismatches = featureMismatches(description, { ...counts, amenities });
  const applyFix = (m: (typeof mismatches)[number]) => {
    if (m.field === "amenity" && m.amenity) { touched.current.delete(`a:${m.amenity}`); setAmenities(cur => [...cur, m.amenity as string]); }
    else if (m.value !== undefined && m.field !== "amenity") { touched.current.delete(m.field); setCounts(c => ({ ...c, [m.field]: String(m.value) })); }
  };
  const tips = fieldTips({ transactionType: tx === "rent" ? "rent" : "sale", propertyType: "house" });
  const num = (name: "bedrooms" | "bathrooms" | "parking", label: string, tip: string) => (
    <label className="field"><span>{label} <ElenaTip text={tip} /></span>
      <input name={name} type="number" inputMode="numeric" min={0} max={20} step={1} value={counts[name]}
        onChange={e => { touched.current.add(name); setCounts(c => ({ ...c, [name]: e.target.value })); }} />
    </label>
  );
  return (
    <>
      {show("basics") && <ElenaListingAssistant {...(photoCount !== undefined ? { photoCount } : {})} />}
      <div hidden={!show("basics")} className="wiz-step">
        <fieldset className="form-section">
          <legend>The basics</legend>
          <label className="field"><span>Title <ElenaTip text={tips.title} /></span>
            <input name="title" placeholder="e.g. Renovated home with pool" maxLength={200} required value={title} onChange={e => setTitle(e.target.value)} />
          </label>
          <WordingHint text={title} field="title" />
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
            <label className="field"><span>{tx === "rent" ? "Rent per week (AUD)" : "Asking price (AUD)"} <ElenaTip text={tips.price} /></span>
              <input name="price" inputMode="decimal" autoComplete="off" onBlur={e => { const c = priceInputToCents(e.currentTarget.value); if (c !== undefined) e.currentTarget.value = centsToDollarField(c); }} placeholder={tx === "rent" ? "650" : "850000"} defaultValue={defaults.priceCents !== undefined ? centsToInput(defaults.priceCents) : ""} />
            </label>
          </div>
        </fieldset>
      </div>
      <div hidden={!show("details")} className="wiz-step">
        <fieldset className="form-section">
          <legend>Features</legend>
          <div className="form-grid cols-3">
            {num("bedrooms", "Bedrooms", tips.bedrooms)}
            {num("bathrooms", "Bathrooms", tips.bathrooms)}
            {num("parking", "Parking spaces", tips.parking)}
          </div>
          {mismatches.length > 0 && (
            <div className="form-warning" role="alert">
              <strong>Elena spotted a mismatch. Please check before you save.</strong>
              <ul>
                {mismatches.map((m, i) => (
                  <li key={i}>{m.message}{(m.value !== undefined || m.amenity) && <> <button type="button" className="link-button" onClick={() => applyFix(m)}>Use the description</button></>}</li>
                ))}
              </ul>
            </div>
          )}
          {filled && <small className="muted" role="status">{filled}</small>}
          <fieldset className="mf-group">
            <legend>Extras buyers can filter by <ElenaTip text={tips.amenities} /></legend>
            <div className="amenity-checks form-checks">
              {AMENITIES.map(a => (
                <label key={a} className="check"><input type="checkbox" name="amenities" value={a} checked={amenities.includes(a)}
                  onChange={e => { touched.current.add(`a:${a}`); setAmenities(cur => e.target.checked ? [...cur, a] : cur.filter(x => x !== a)); }} /><span>{AMENITY_LABELS[a]}</span></label>
              ))}
            </div>
          </fieldset>
        </fieldset>
      </div>
      <div hidden={!show("description")} className="wiz-step">
        <fieldset className="form-section">
          <legend>Description</legend>
          <label className="field"><span>Describe the property <ElenaTip text={tips.description} /></span>
            <textarea name="description" rows={8} maxLength={5000} value={description} onChange={e => onDescription(e.target.value)}
              placeholder="Rooms, condition, outdoor space, what is nearby. Describe the property, not who should live there." />
          </label>
          <small className="muted">Listings can&apos;t say who may or may not buy or rent (for example by age, family, race, religion, sex or disability). We check the wording as you type.</small>
          <WordingHint text={description} field="description" />
        </fieldset>
      </div>
      <div hidden={!show("location")} className="wiz-step">
        <fieldset className="form-section">
          <legend>Location</legend>
          <label className="field"><span>Street address</span>
            <AddressField defaultValue={defaults.address ?? ""} />
          </label>
          <div className="form-grid">
            <label className="field"><span>Suburb <ElenaTip text={tips.suburb} /></span>
              <input name="suburb" maxLength={80} defaultValue={defaults.suburb ?? ""} autoComplete="address-level2" />
            </label>
            <label className="field">Postcode
              <input name="postcode" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} defaultValue={defaults.postcode ?? ""} autoComplete="postal-code" />
            </label>
            <label className="field">State
              <select name="jurisdiction" defaultValue={defaults.jurisdiction ?? "QLD"}>
                {["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].map(j => <option key={j}>{j}</option>)}
              </select>
            </label>
          </div>
        </fieldset>
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
