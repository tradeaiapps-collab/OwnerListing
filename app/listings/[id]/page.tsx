"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { formatPrice } from "../../../src/domain/listing-details";
import { actionHref } from "../../../src/domain/listing-actions";
import { ListingGallery } from "../gallery";
import { JSON_HEADERS } from "../ui";
import "../../styles/cards.css";
import "../../styles/detail.css";

interface Listing {
  id: string;
  title: string;
  address: string;
  jurisdiction: string;
  transactionType: string;
  useClass: string;
  propertyType: string;
  suburb?: string;
  postcode?: string;
  priceCents?: number;
  bedrooms?: number;
  bathrooms?: number;
  parking?: number;
  description?: string;
  status: string;
  disclosures: { key: string; satisfied: boolean }[];
  updatedAt: string;
}

/** Bookmarks the listing for a signed-in buyer (no search is created). Signed-out visitors sign in and return here; owners and agents see no Save button. */
function SaveButton({ listingId, userType }: { listingId: string; userType: string | null }) {
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const buyer = userType === "buyer";
  useEffect(() => {
    if (!buyer) return;
    fetch("/api/buyer/saved-listings")
      .then(async r => (r.ok ? (await r.json()).listings as { listingId: string }[] : []))
      .then(all => setSaved(all.some(l => l.listingId === listingId)))
      .catch(() => setSaved(false));
  }, [buyer, listingId]);
  if (userType === null) return <a className="button secondary" href={actionHref(listingId, "save", false)}>Save</a>;
  if (!buyer) return null;
  async function toggle() {
    setBusy(true);
    setError("");
    try {
      const res = saved
        ? await fetch(`/api/buyer/saved-listings/${listingId}`, { method: "DELETE" })
        : await fetch("/api/buyer/saved-listings", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ listingId }) });
      if (res.ok) setSaved(!saved);
      else setError("Could not update your saved homes.");
    } catch {
      setError("Could not update your saved homes.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className="button secondary" onClick={toggle} disabled={busy} aria-pressed={saved}>{saved ? "Saved" : "Save"}</button>
      {error && <span role="alert">{error}</span>}
    </>
  );
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ");

interface Compliance {
  seller: { handledBy: "owner" | "agent"; agentLicenceVerified: boolean; agentState?: string };
  deposit: { status: "verified" | "checking" | "not_set"; firmName?: string };
  disclosures: { key: string; label: string; satisfied: boolean; verifiedAt?: string; required: boolean }[];
  requirementsConfigured: boolean;
  outstanding: number;
  listedAt: string;
  reference: string;
}
interface Doc { id: string; kind: string; visibility: string; status: string }

/** Files shown in the gallery are left out of the documents list. */
const GALLERY_KINDS = new Set(["photo", "photo_360", "video", "video_360", "floorplan"]);
const DOC_LABELS: Record<string, string> = {
  title_search: "Title search", building_inspection: "Building inspection report",
  pest_report: "Pest report", contract: "Contract", other: "Document"
};
const STATE_NAMES: Record<string, string> = {
  NSW: "New South Wales", VIC: "Victoria", QLD: "Queensland", WA: "Western Australia",
  SA: "South Australia", TAS: "Tasmania", ACT: "the ACT", NT: "the Northern Territory"
};
const day = (iso: string) => new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });

/** A status mark that never relies on colour alone: the shape and the words differ too. */
function Mark({ tone }: { tone: "ok" | "wait" | "none" }) {
  return (
    <span className={`pd-mark pd-mark-${tone}`} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16">
        {tone === "ok" && <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />}
        {tone === "wait" && <><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M8 5v3.2l2 1.3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></>}
        {tone === "none" && <path d="M4 8h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />}
      </svg>
    </span>
  );
}

function Disclosures({ c, state, tx }: { c: Compliance; state: string; tx: "sale" | "rent" }) {
  const provided = c.disclosures.filter(d => d.satisfied).length;
  return (
    <section className="pd-section" aria-labelledby="pd-disclosures">
      <div className="pd-section-head">
        <h2 id="pd-disclosures">Disclosures</h2>
        {c.disclosures.length > 0 && <span className={`badge${c.outstanding === 0 ? " badge-accepted" : " sensitive"}`}>{provided} of {c.disclosures.length} provided</span>}
      </div>
      {c.disclosures.length === 0
        ? <p className="empty">No disclosures have been verified for this listing yet. Ask the seller for them before you make an offer.</p>
        : (
          <ul className="pd-list">
            {c.disclosures.map(d => (
              <li key={d.key} className="pd-row">
                <Mark tone={d.satisfied ? "ok" : "none"} />
                <span className="pd-row-text">
                  <strong>{d.label}</strong>
                  <span className="muted">
                    {d.satisfied ? (d.verifiedAt ? `Checked by our team on ${day(d.verifiedAt)}` : "Provided") : "Not provided yet"}
                    {d.required ? " · Required" : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      {!c.requirementsConfigured && (
        <p className="pd-fine">
          The required list for a {tx === "sale" ? "sale" : "rental"} in {STATE_NAMES[state] ?? state} is still being finalised by our compliance team.
          What is shown here has been checked, but it may not be everything the law requires. Your solicitor or conveyancer can confirm.
        </p>
      )}
    </section>
  );
}

function Documents({ docs }: { docs: Doc[] }) {
  const files = docs.filter(d => !GALLERY_KINDS.has(d.kind) && d.status === "active");
  return (
    <section className="pd-section" aria-labelledby="pd-docs">
      <h2 id="pd-docs">Documents</h2>
      {files.length === 0
        ? <p className="empty">No public documents yet. Some reports are shared only with buyers who have enquired.</p>
        : (
          <ul className="pd-list">
            {files.map(d => (
              <li key={d.id} className="pd-row">
                <span className="pd-doc-icon" aria-hidden="true">
                  <svg viewBox="0 0 16 16" width="16" height="16"><path d="M4 1.5h5l3 3v10H4z M9 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
                </span>
                <span className="pd-row-text"><strong>{DOC_LABELS[d.kind] ?? cap(d.kind)}</strong></span>
                <a className="pd-row-link" href={`/api/documents/${d.id}/file`}>Download</a>
              </li>
            ))}
          </ul>
        )}
    </section>
  );
}

function Safety({ c, tx }: { c: Compliance; tx: "sale" | "rent" }) {
  const s = c.seller, dep = c.deposit;
  const sellerTone = s.handledBy === "owner" || s.agentLicenceVerified ? "ok" : "wait";
  const depTone = dep.status === "verified" ? "ok" : dep.status === "checking" ? "wait" : "none";
  return (
    <section className="pd-section" aria-labelledby="pd-safety">
      <h2 id="pd-safety">Compliance and safety</h2>
      <ul className="pd-safety">
        <li className="pd-card">
          <Mark tone={sellerTone} />
          <div>
            <h3>{s.handledBy === "owner" ? "Sold by the owner" : s.agentLicenceVerified ? "Licensed agent appointed" : "Agent licence being checked"}</h3>
            <p>{s.handledBy === "owner"
              ? "You deal directly with the owner. Contact details stay private until both of you choose to share them."
              : s.agentLicenceVerified
                ? `The owner has appointed an agent whose ${s.agentState ?? ""} licence our team has verified. The owner still makes every decision.`
                : "The owner has appointed an agent. We have not yet verified their licence for this state."}</p>
          </div>
        </li>
        <li className="pd-card">
          <Mark tone={depTone} />
          <div>
            <h3>{dep.status === "verified" ? "Deposit goes to a solicitor's trust account" : dep.status === "checking" ? "Trust account being checked" : "Trust account not set up yet"}</h3>
            <p>
              {dep.status === "verified" && <>{dep.firmName ? <>Held by <strong>{dep.firmName}</strong>. </> : null}A person on our team has checked the account details. </>}
              {tx === "sale"
                ? "Any deposit is paid to the seller's solicitor, never to this platform."
                : "Any bond is lodged with the state bond authority, never with this platform."} We never hold your money.
            </p>
          </div>
        </li>
        <li className="pd-card">
          <Mark tone="ok" />
          <div>
            <h3>Only the owner can say yes</h3>
            <p>Our AI assistant can answer questions about this home, but it never accepts an {tx === "sale" ? "offer" : "application"} or agrees to anything on anyone&apos;s behalf.</p>
          </div>
        </li>
        <li className="pd-card">
          <Mark tone="ok" />
          <div>
            <h3>A permanent record</h3>
            <p>Messages and published documents can&apos;t be deleted, so there is always a record of what was said and shared.</p>
          </div>
        </li>
      </ul>
    </section>
  );
}

export default function ListingDetail() {
  const { id } = useParams<{ id: string }>();
  const [listing, setListing] = useState<Listing | null>(null);
  const [compliance, setCompliance] = useState<Compliance | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [error, setError] = useState("");
  const [userType, setUserType] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/auth/me").then(async r => setUserType(r.ok ? (await r.json()).user?.userType ?? null : null)).catch(() => setUserType(null));
  }, []);

  useEffect(() => {
    setListing(null);
    setCompliance(null);
    setDocs([]);
    setError("");
    fetch(`/api/listings/${id}`)
      .then(async r => {
        const d = await r.json();
        if (r.ok) setListing(d.listing);
        else setError(r.status === 404 ? "This listing was not found or is not published." : d.error ?? "Could not load the listing.");
      })
      .catch(() => setError("Could not load the listing."));
    // The panels below are extras: if they fail the page still shows the listing.
    fetch(`/api/listings/${id}/compliance`).then(async r => { if (r.ok) setCompliance((await r.json()).compliance); }).catch(() => undefined);
    fetch(`/api/listings/${id}/documents`).then(async r => { if (r.ok) setDocs((await r.json()).documents); }).catch(() => undefined);
  }, [id]);

  const back = <p><a href="/listings">Back to listings</a></p>;

  if (error) return <main>{back}<p role="alert">{error}</p></main>;
  if (!listing) return <main>{back}<p className="muted" role="status">Loading...</p></main>;
  if (listing.status !== "published") {
    return (
      <main>
        {back}
        <p role="status">This listing is not published yet.</p>
        <p><a href={`/listings/${listing.id}/edit`}>Edit this draft</a></p>
      </main>
    );
  }

  const tx = listing.transactionType as "sale" | "rent";
  const facts: [string, string][] = [];
  if (listing.bedrooms !== undefined) facts.push([String(listing.bedrooms), listing.bedrooms === 1 ? "Bedroom" : "Bedrooms"]);
  if (listing.bathrooms !== undefined) facts.push([String(listing.bathrooms), listing.bathrooms === 1 ? "Bathroom" : "Bathrooms"]);
  if (listing.parking !== undefined) facts.push([String(listing.parking), listing.parking === 1 ? "Car space" : "Car spaces"]);
  facts.push([cap(listing.propertyType), "Property type"]);

  return (
    <main className="detail">
      <nav className="crumbs" aria-label="Breadcrumb">
        <ol>
          <li><a href="/listings">Listings</a></li>
          {listing.suburb && <li><a href={`/listings?suburb=${encodeURIComponent(listing.suburb)}`}>{listing.suburb}</a></li>}
          <li aria-current="page">{listing.title}</li>
        </ol>
      </nav>
      <div className="detail-layout">
        <div className="detail-main">
          <ListingGallery listingId={listing.id} title={listing.title} />
          <div className="pd-head">
            <p className="pd-tags">
              <span className="lcard-tag detail-tag">{tx === "sale" ? "For sale" : "For rent"}</span>
              {compliance && compliance.disclosures.some(d => d.satisfied) && <span className="badge badge-accepted">Disclosures verified</span>}
            </p>
            <h1>{listing.title}</h1>
            <p className="detail-address">{listing.address}</p>
            {listing.priceCents !== undefined && <p className="detail-price detail-price-m">{formatPrice(listing.priceCents, tx)}</p>}
          </div>
          <ul className="pd-facts" aria-label="Key facts">
            {facts.map(([v, l]) => <li key={l}><strong>{v}</strong><span>{l}</span></li>)}
          </ul>
          {listing.description && (
            <section aria-label="Description">
              <h2>About this property</h2>
              {listing.description.split(/\n{2,}/).map((p, i) => <p key={i} className="detail-description">{p}</p>)}
            </section>
          )}

          <h2>Property details</h2>
          <dl className="details detail-facts">
            <dt>State</dt><dd>{STATE_NAMES[listing.jurisdiction] ?? listing.jurisdiction}</dd>
            <dt>Offer</dt><dd>{tx === "sale" ? "For sale" : "For rent"}</dd>
            <dt>Use</dt><dd>{cap(listing.useClass)}</dd>
            <dt>Property</dt><dd>{cap(listing.propertyType)}</dd>
            {listing.suburb && <><dt>Suburb</dt><dd>{listing.suburb}{listing.postcode ? ` ${listing.postcode}` : ""}</dd></>}
            {listing.bedrooms !== undefined && <><dt>Bedrooms</dt><dd>{listing.bedrooms}</dd></>}
            {listing.bathrooms !== undefined && <><dt>Bathrooms</dt><dd>{listing.bathrooms}</dd></>}
            {listing.parking !== undefined && <><dt>Parking</dt><dd>{listing.parking}</dd></>}
            {compliance && <><dt>Listed</dt><dd>{day(compliance.listedAt)}</dd></>}
            <dt>Updated</dt><dd>{day(listing.updatedAt)}</dd>
            {compliance && <><dt>Reference</dt><dd className="pd-ref">{compliance.reference}</dd></>}
          </dl>

          {compliance
            ? <><Disclosures c={compliance} state={listing.jurisdiction} tx={tx} /><Documents docs={docs} /><Safety c={compliance} tx={tx} /></>
            : <Documents docs={docs} />}
        </div>
        <aside className="detail-aside" aria-label="Contact the seller">
          {listing.priceCents !== undefined && <p className="detail-price">{formatPrice(listing.priceCents, tx)}</p>}
          <div className="detail-actions">
            <a className="button" href={actionHref(listing.id, "enquire", userType !== null)}>Enquire</a>
            <SaveButton listingId={listing.id} userType={userType} />
          </div>
          {compliance && (
            <ul className="pd-aside-checks" aria-label="At a glance">
              <li><Mark tone={compliance.seller.handledBy === "owner" || compliance.seller.agentLicenceVerified ? "ok" : "wait"} />
                {compliance.seller.handledBy === "owner" ? "Direct from the owner" : compliance.seller.agentLicenceVerified ? "Licensed agent, verified" : "Agent licence being checked"}</li>
              <li><Mark tone={compliance.deposit.status === "verified" ? "ok" : compliance.deposit.status === "checking" ? "wait" : "none"} />
                {compliance.deposit.status === "verified" ? "Trust account verified" : compliance.deposit.status === "checking" ? "Trust account being checked" : "Trust account not set up"}</li>
              <li><Mark tone={compliance.disclosures.some(d => d.satisfied) ? "ok" : "none"} />
                {compliance.disclosures.filter(d => d.satisfied).length} disclosure{compliance.disclosures.filter(d => d.satisfied).length === 1 ? "" : "s"} verified</li>
            </ul>
          )}
          <p className="detail-note">Any deposit is paid to the seller&apos;s solicitor, never to the platform.</p>
          {compliance && <p className="detail-note pd-ref-line">Ref {compliance.reference}</p>}
        </aside>
      </div>
    </main>
  );
}
