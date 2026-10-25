import { getRequestTheme } from "../src/server/request-theme";
import { brandFor } from "../src/server/site-theme";
import { formatPrice } from "../src/domain/listing-details";
import { HOME_FAQ_INTENTS } from "../src/domain/guide-assistant";
import { assetUrl } from "../src/domain/site-theme";
import { getLiveGuide } from "../src/server/guide-assistant-db";
import { loadLatest, loadSuburbs, type HomeCard } from "../src/server/home-data";
import HomeCarousel from "./home-carousel";
import { CardMedia } from "./listings/card-media";
import HomeSearch from "./home-search";
import SavingsCalc from "./savings-calc";
import "./styles/cards.css";
import "./styles/home.css";

export const dynamic = "force-dynamic";
export async function generateMetadata() {
  return { title: brandFor((await getRequestTheme()).settings).tagline, description: "List your own property, meet verified buyers and decide on every offer yourself." };
}

const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg className="home-icon" viewBox="0 0 32 32" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
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
const STATES: readonly [string, string, string][] = [
  ["nsw", "New South Wales", "Sydney and regional NSW"], ["vic", "Victoria", "Melbourne and regional VIC"],
  ["qld", "Queensland", "Brisbane, Gold Coast and regional QLD"], ["wa", "Western Australia", "Perth and regional WA"],
  ["sa", "South Australia", "Adelaide and regional SA"], ["tas", "Tasmania", "Hobart and Launceston"],
  ["act", "Australian Capital Territory", "Canberra"], ["nt", "Northern Territory", "Darwin and Alice Springs"]
];

/** Built-in hero background until a licensed photo is uploaded at /staff/site: an illustrated street of houses, no external image. */
const HeroArt = () => (
  <svg className="hx-art" viewBox="0 0 1440 600" preserveAspectRatio="xMidYMax slice" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="hx-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" className="hx-sky1" /><stop offset="1" className="hx-sky2" /></linearGradient>
    </defs>
    <rect width="1440" height="600" fill="url(#hx-sky)" />
    <circle className="hx-sun" cx="1120" cy="170" r="70" />
    <path className="hx-far" d="M0 420 Q240 360 480 400 T960 390 T1440 380 V600 H0Z" />
    <g className="hx-house">
      <path d="M140 470 V360 L250 290 L360 360 V470Z" /><path d="M520 470 V330 L650 250 L780 330 V470Z" />
      <path d="M900 470 V370 L990 310 L1080 370 V470Z" /><path d="M1180 470 V350 L1290 280 L1400 350 V470Z" />
    </g>
    <g className="hx-win">
      <rect x="180" y="390" width="40" height="34" rx="3" /><rect x="282" y="390" width="40" height="34" rx="3" />
      <rect x="560" y="360" width="46" height="40" rx="3" /><rect x="694" y="360" width="46" height="40" rx="3" />
      <rect x="935" y="395" width="36" height="30" rx="3" /><rect x="1220" y="380" width="40" height="34" rx="3" /><rect x="1320" y="380" width="40" height="34" rx="3" />
    </g>
    <g className="hx-tree"><circle cx="440" cy="420" r="46" /><circle cx="840" cy="430" r="38" /><circle cx="1130" cy="425" r="42" /><circle cx="60" cy="430" r="44" /></g>
    <path className="hx-ground" d="M0 466 H1440 V600 H0Z" />
  </svg>
);

function Card({ l }: { l: HomeCard }) {
  return (
    <li className="lcard hc-item">
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
  );
}

export default async function Home() {
  const theme = await getRequestTheme();
  const brand = brandFor(theme.settings);
  const [latest, suburbs, guide] = await Promise.all([loadLatest(), loadSuburbs(), getLiveGuide()]);
  const preview = process.env["NODE_ENV"] !== "production";
  const heroId = theme.settings.brand.hero;
  const heroSrc = heroId ? assetUrl("hero", heroId, theme.previewToken ?? undefined) : null;
  return (
    <main className="home">
      {/* React hoists this into <head>: the hero photo is the largest paint, so fetch it first. */}
      {heroSrc && <link rel="preload" as="image" href={heroSrc} fetchPriority="high" />}
      <section className={`hx${heroSrc ? " hx-photo" : ""}`} aria-labelledby="home-title">
        {heroSrc ? <img className="hx-img" src={heroSrc} alt="" fetchPriority="high" decoding="async" /> : <HeroArt />}
        <div className="hx-shade" aria-hidden="true" />
        <div className="home-wrap hx-inner">
          {preview && <p className="home-badge">Preview</p>}
          <h1 id="home-title">{brand.tagline}</h1>
          <p className="hx-lead">Owners and buyers in direct contact. List your home yourself and keep the decision on every offer.</p>
          <HomeSearch suburbs={suburbs} />
        </div>
      </section>

      <section className="home-owner" aria-labelledby="home-owner-t">
        <div className="home-wrap home-owner-in">
          <div>
            <h2 id="home-owner-t">List your home yourself</h2>
            <p>No commission. You set the price, talk to verified buyers and choose the offer.</p>
          </div>
          <div className="home-owner-actions">
            <a className="button" href="/listings/new">List your property</a>
            <a className="button secondary" href="#home-how">How it works</a>
          </div>
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
            <HomeCarousel label="Latest listings">{latest.map(l => <Card key={l.id} l={l} />)}</HomeCarousel>
          )}
        </div>
      </section>

      <section className="home-sec home-alt" id="home-how" aria-labelledby="home-how-t">
        <div className="home-wrap">
          <h2 id="home-how-t">How it works</h2>
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
              <Icon><path d="M16 4 6 8v8c0 6 4 10 10 12 6-2 10-6 10-12V8Z" /><path d="m12 16 3 3 6-6" /></Icon>
              <strong>Verified people</strong>
              <span>Buyers confirm their identity before they can offer. Trust accounts are checked by staff.</span>
            </li>
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
              <Icon><path d="M6 8h20v13H13l-5 4v-4H6Z" /><path d="M11 13h10M11 17h6" /></Icon>
              <strong>Secure chat</strong>
              <span>Enquiries and offers stay on the platform and are kept as a record that cannot be deleted.</span>
            </li>
            <li>
              <Icon><rect x="6" y="9" width="20" height="14" rx="3" /><path d="M12 15h.01M20 15h.01M13 19h6M16 9V5" /></Icon>
              <strong>AI never accepts an offer</strong>
              <span>It drafts replies and summaries. You press accept.</span>
            </li>
          </ul>
        </div>
      </section>

      <section className="home-sec home-alt" aria-labelledby="home-fees">
        <div className="home-wrap home-calc">
          <div>
            <h2 id="home-fees">Compare the cost</h2>
            <p>Put in your own numbers to compare an agent&apos;s commission with listing it yourself. Plans and fees are published, with GST shown.</p>
            <a className="button secondary" href="/plans">See plans and fees</a>
          </div>
          <SavingsCalc />
        </div>
      </section>

      <section className="home-sec" aria-labelledby="home-states">
        <div className="home-wrap">
          <h2 id="home-states">Browse by state</h2>
          <ul className="home-tiles">
            {STATES.map(([code, name, sub]) => (
              <li key={code}><a href={`/listings?state=${code}`}><strong>{name}</strong><span>{sub}</span></a></li>
            ))}
          </ul>
        </div>
      </section>

      <section className="home-sec home-alt" id="home-faq" aria-labelledby="home-faq-t">
        <div className="home-wrap home-faq">
          <h2 id="home-faq-t">Questions</h2>
          <div className="home-faq-list">
            {HOME_FAQ_INTENTS.map(i => (
              <details key={i}>
                <summary>{guide.faq[i].question}</summary>
                <p>{guide.faq[i].answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      <section className="home-cta" aria-labelledby="home-cta-t">
        <div className="home-wrap home-cta-in">
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
