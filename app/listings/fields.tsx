import { BOND_PATHWAY_LABELS } from "./ui";

export type BondState = "idle" | "saving" | "saved" | "error";

export interface ListingDefaults {
  title?: string;
  address?: string;
  jurisdiction?: string;
  transactionType?: string;
  useClass?: string;
  propertyType?: string;
}

/** The six draft fields, shared by the create and edit pages. Read the values with FormData. */
export function ListingFields({ defaults = {} }: { defaults?: ListingDefaults }) {
  return (
    <>
      <input name="title" placeholder="Title" maxLength={200} required defaultValue={defaults.title ?? ""} />
      <input name="address" placeholder="Address" maxLength={300} required defaultValue={defaults.address ?? ""} />
      <select name="jurisdiction" defaultValue={defaults.jurisdiction ?? "QLD"} aria-label="State">
        {["NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT"].map(j => <option key={j}>{j}</option>)}
      </select>
      <select name="transactionType" defaultValue={defaults.transactionType ?? "sale"} aria-label="Sale or rent">
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
