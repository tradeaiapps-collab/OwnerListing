import { getRequestTheme } from "../src/server/request-theme";
import { brandFor } from "../src/server/site-theme";
import { formatPrice } from "../src/domain/listing-details";
import { parseSearchQuery } from "../src/domain/listing-search";
import { searchPublished, toPublicListing } from "../src/domain/listing-service";
import { getDb, getDeps } from "../src/server/context";
import { cardPhoto, type CardPhoto } from "../src/domain/listing-photos";
import { createPgPhotoStore } from "../src/server/photos-db";
import { CardMedia } from "./listings/card-media";
import "./styles/cards.css";
import "./styles/home.css";

export const dynamic = "force-dynamic";
export async function generateMetadata() {
  return { title: brandFor((await getRequestTheme()).settings).tagline, description: "List your own property, meet verified buyers and decide on every offer yourself." };
}

type Latest = { id: string; title: string; suburb?: string; postcode?: string; jurisdiction: string; transactionType: "sale" | "rent"; propertyType: string; priceCents?: number; bedrooms?: number; bathrooms?: number; parking?: number } & CardPhoto;

/** Latest published listings. Any failure (no database, slow database) gives an empty strip, never an error page. */
async function loadLatest(): Promise<Latest[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const q = parseSearchQuery(new URLSearchParams({ pageSize: "6" }));
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), 3000); });
    const search = searchPublished(getDeps(), q);
    search.catch(() => undefined);
    const page = await Promise.race([search, timeout]);
    // Cover photos are a nice-to-have: a lookup failure shows the cards without them.
    const lookup = createPgPhotoStore(getDb()).coversFor(page.items.map(l => l.id));
    lookup.catch(() => undefined);
    const covers = await Promise.race([lookup, timeout]).catch(() => new Map<string, never>());
    return page.items.map(l => ({ ...toPublicListing(l), ...cardPhoto(covers.get(l.id)) }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg className="home-icon" viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

const OWNER_STEPS = [
  ["List your property", "Add photos, details and your price. It goes live once your trust account is verified."],
  ["Meet verified buyers", "Enquiries come from buyers who have already proved who they are."],
  ["You decide on offers", "Every offer is yours to accept, counter or decline. AI can summarise, never decide."]
];
const BUYER_STEPS = [
  ["Verify once", "Confirm your identity one time and use it on every listing."],
  ["Send an enquiry", "Ask the owner directly. No middleman in the way."],
  ["Make an offer", "Submit it through the platform and hear back from the owner."]
];

export default async function Home() {
  const brand = brandFor((await getRequestTheme()).settings);
  const latest = await loadLatest();
  const preview = process.env["NODE_ENV"] !== "production";
  return (
    <main className="home">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-wrap home-hero-grid">
          <div>
            {preview && <p className="home-badge">Preview</p>}
            <h1 id="home-title">{brand.tagline}</h1>
            <p className="home-lead">{brand.name} puts owners and buyers in direct contact. List your home, house, unit or commercial space yourself, and keep the decision on every offer.</p>
            <form className="home-search" action="/listings" method="get" role="search" aria-label="Search listings">
              <fieldset className="home-seg">
                <legend>Looking to</legend>
                <label><input type="radio" name="type" value="sale" defaultChecked /><span>Buy</span></label>
                <label><input type="radio" name="type" value="rent" /><span>Rent</span></label>
              </fieldset>
              <label className="home-f home-f-loc">Suburb or postcode
                <input name="location" autoComplete="off" maxLength={80} placeholder="e.g. Paddington or 4064" />
              </label>
              <label className="home-f">Bedrooms
                <select name="beds" defaultValue="">
                  <option value="">Any</option>
                  {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}+</option>)}
                </select>
              </label>
              <label className="home-f">Max price (AUD, rent per week)
                <input name="price" inputMode="numeric" pattern="[0-9]*" maxLength={10} placeholder="No limit" />
              </label>
              <button type="submit">Search listings</button>
            </form>
            <p className="home-or"><a className="home-link" href="/listings/new">Selling or renting out? List your property</a></p>
          </div>
          <svg className="home-art" viewBox="0 0 320 300" role="img" aria-label="A house with a for sale by owner sign out the front">
            <rect className="a-sun" x="236" y="26" width="44" height="44" rx="22" />
            <path className="a-hill" d="M0 250 Q80 205 170 232 T320 218 V300 H0Z" />
            <path className="a-wall" d="M60 250 V140 H210 V250Z" />
            <path className="a-roof" d="M44 144 L135 74 L226 144Z" />
            <rect className="a-door" x="118" y="190" width="34" height="60" rx="3" />
            <rect className="a-win" x="76" y="164" width="28" height="28" rx="3" />
            <rect className="a-win" x="166" y="164" width="28" height="28" rx="3" />
            <rect className="a-post" x="252" y="150" width="6" height="100" />
            <rect className="a-board" x="226" y="130" width="76" height="46" rx="4" />
            <path className="a-text" d="M238 148 H290 M238 160 H274" />
            <path className="a-ground" d="M0 250 H320" />
          </svg>
        </div>
      </section>

      <section className="home-sec" aria-labelledby="home-latest">
        <div className="home-wrap">
          <div className="home-head">
            <h2 id="home-latest">Latest listings</h2>
            <a className="home-link" href="/listings">Browse all listings</a>
          </div>
          {latest.length === 0 ? (
            <div className="home-empty">
              <p><strong>No listings published yet.</strong> The first owners are getting set up now. List yours and be among them.</p>
              <a className="button" href="/listings/new">List your property</a>
            </div>
          ) : (
            <ul className="lcards">
              {latest.map(l => (
                <li key={l.id} className="lcard">
                  <CardMedia photo={l} transactionType={l.transactionType} />
                  <div className="lcard-body">
                    {l.priceCents !== undefined && <p className="lcard-price">{formatPrice(l.priceCents, l.transactionType)}</p>}
                    <h3 className="lcard-title"><a href={`/listings/${l.id}`}>{l.title}</a></h3>
                    <p className="lcard-addr">{l.suburb ? `${l.suburb} ${l.postcode ?? ""} ` : ""}{l.jurisdiction}</p>
                    <ul className="chips" aria-label="Features">
                      {l.bedrooms !== undefined && <li className="chip chip-bed">{l.bedrooms} bed</li>}
                      {l.bathrooms !== undefined && <li className="chip chip-bath">{l.bathrooms} bath</li>}
                      {l.parking !== undefined && <li className="chip chip-car">{l.parking} car</li>}
                    </ul>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="home-sec home-alt" aria-labelledby="home-how">
        <div className="home-wrap">
          <h2 id="home-how">How it works</h2>
          <div className="home-two">
            <div>
              <h3>For owners</h3>
              <ol className="home-steps">{OWNER_STEPS.map(([t, d]) => <li key={t}><strong>{t}</strong><span>{d}</span></li>)}</ol>
              <a className="button" href="/listings/new">List your property</a>
            </div>
            <div>
              <h3>For buyers and renters</h3>
              <ol className="home-steps">{BUYER_STEPS.map(([t, d]) => <li key={t}><strong>{t}</strong><span>{d}</span></li>)}</ol>
              <a className="button secondary" href="/listings">Browse listings</a>
            </div>
          </div>
        </div>
      </section>

      <section className="home-sec" aria-labelledby="home-trust">
        <div className="home-wrap">
          <h2 id="home-trust">Built so nobody has to trust us with their money</h2>
          <ul className="home-trust">
            <li>
              <Icon><path d="M4 12 16 4l12 8M7 12v13h18V12M12 25v-8h8v8" /></Icon>
              <strong>Deposits go to a solicitor&apos;s trust account</strong>
              <span>Buyers pay the deposit to the owner&apos;s solicitor, not to the platform.</span>
            </li>
            <li>
              <Icon><circle cx="16" cy="16" r="12" /><path d="M10 16h12M16 10v12" transform="rotate(45 16 16)" /></Icon>
              <strong>{brand.name} holds no money</strong>
              <span>No deposits, no escrow. Nothing publishes until a trust account is verified.</span>
            </li>
            <li>
              <Icon><rect x="6" y="9" width="20" height="14" rx="3" /><path d="M12 15h.01M20 15h.01M13 19h6M16 9V5" /></Icon>
              <strong>AI never accepts an offer</strong>
              <span>It drafts replies and reports. You press accept.</span>
            </li>
            <li>
              <Icon><path d="M16 4 6 8v8c0 6 4 10 10 12 6-2 10-6 10-12V8Z" /><path d="m12 16 3 3 6-6" /></Icon>
              <strong>Verified buyers</strong>
              <span>Buyers confirm their identity before they can enquire or offer.</span>
            </li>
          </ul>
        </div>
      </section>

      <section className="home-sec home-alt" aria-labelledby="home-fees">
        <div className="home-wrap home-fees">
          <div>
            <h2 id="home-fees">Know the cost before you list</h2>
            <p>Plans and fees are published. See what each plan includes and what it costs.</p>
          </div>
          <a className="button" href="/plans">See plans and fees</a>
        </div>
      </section>

      <section className="home-cta" aria-labelledby="home-cta-t">
        <div className="home-wrap">
          <h2 id="home-cta-t">Ready when you are</h2>
          <div className="home-cta-actions">
            <a className="button home-cta-main" href="/listings/new">List your property</a>
            <a className="button secondary" href="/listings">Browse listings</a>
          </div>
        </div>
      </section>
    </main>
  );
}
