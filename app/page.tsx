import { getRequestTheme } from "../src/server/request-theme";
import { brandFor } from "../src/server/site-theme";
import { formatPrice } from "../src/domain/listing-details";
import { personaById, personaIntro, personaLabel } from "../src/domain/assistant-persona";
import { HOME_FAQ_INTENTS } from "../src/domain/guide-assistant";
import { assetUrl } from "../src/domain/site-theme";
import { getLivePersona } from "../src/server/assistant-persona-db";
import { getLiveGuide } from "../src/server/guide-assistant-db";
import { loadLatest, loadSuburbs, type HomeCard } from "../src/server/home-data";
import { heroLines, heroSlides } from "../src/domain/home-hero";
import HomeCarousel from "./home-carousel";
import { HairlineBar, HeroSlides } from "./home-hero";
import AskAssistant from "./ask-assistant";
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

/** Default hero photo until another is uploaded at /staff/site (Hero slot). */
const DEFAULT_HERO = "/hero-default.jpg";

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
  const [latest, suburbs, guide, personaId] = await Promise.all([loadLatest(), loadSuburbs(), getLiveGuide(), getLivePersona()]);
  const persona = personaById(personaId);
  const preview = process.env["NODE_ENV"] !== "production";
  const heroId = theme.settings.brand.hero;
  const heroSrc = heroId ? assetUrl("hero", heroId, theme.previewToken ?? undefined) : DEFAULT_HERO;
  const slides = heroSlides(heroId ? heroSrc : null);
  return (
    <>
    <HairlineBar />
    <main className="home">
      {/* React hoists this into <head>: the first hero photo is the largest paint, so fetch it first. */}
      <link rel="preload" as="image" href={slides[0]!.src} fetchPriority="high" />
      <section className="hx hx-photo hx-hairline" aria-labelledby="home-title">
        <HeroSlides slides={slides} lines={heroLines(brand.tagline)} headingId="home-title" />
        <div className="home-wrap hx-inner">
          {preview && <p className="home-badge">Preview</p>}
          <p className="hx-lead">Owners and buyers in direct contact. List your home yourself and keep the decision on every offer.</p>
          <ul className="hx-points" aria-label="Why owners choose us">
            <li>No sale commission</li>
            <li>Verified buyers</li>
            <li>You decide every offer</li>
          </ul>
        </div>
        <a className="hl-cue" href="#home-find">Search homes</a>
      </section>

      <section className="home-find" id="home-find" aria-labelledby="home-find-t">
        <div className="home-wrap home-find-in">
          <p className="eyebrow">Owner-direct property, Australia</p>
          <h2 id="home-find-t">Find a home from its owner</h2>
          <HomeSearch suburbs={suburbs} />
        </div>
      </section>

      <section className="home-owner" aria-labelledby="home-owner-t">
        <div className="home-wrap home-owner-in">
          <div>
            <p className="eyebrow">For owners</p>
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
            <div>
              <p className="eyebrow">New to market</p>
              <h2 id="home-latest">Latest listings</h2>
            </div>
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
          <p className="eyebrow">The process</p>
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
          <p className="eyebrow">Peace of mind</p>
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
            <p className="eyebrow">Costs</p>
            <h2 id="home-fees">Compare the cost</h2>
            <p>Put in your own numbers to compare an agent&apos;s commission with listing it yourself. Plans and fees are published, with GST shown.</p>
            <a className="button secondary" href="/plans">See plans and fees</a>
          </div>
          <SavingsCalc />
        </div>
      </section>

      <section className="home-sec" aria-labelledby="home-states">
        <div className="home-wrap">
          <p className="eyebrow">Explore</p>
          <h2 id="home-states">Browse by state</h2>
          <ul className="home-tiles">
            {STATES.map(([code, name, sub]) => (
              <li key={code}><a href={`/listings?state=${code}`}><strong>{name}</strong><span>{sub}</span></a></li>
            ))}
          </ul>
        </div>
      </section>

      {guide.enabled && (
        <section className="home-sec home-greeter" aria-labelledby="home-greeter-t">
          <div className="home-wrap home-greeter-in">
            <figure className={`home-greeter-photo${persona.greeter ? " is-full" : ""}`}>
              <img src={persona.greeter ?? persona.portrait} alt={`${persona.name}, the website's AI assistant`} loading="lazy" decoding="async" />
            </figure>
            <div className="home-greeter-copy">
              <p className="eyebrow">Your guide</p>
              <h2 id="home-greeter-t">Meet {persona.name}</h2>
              <p className="home-greeter-label">{personaLabel(persona)}</p>
              <p>{personaIntro(persona, brand.name)}</p>
              <AskAssistant name={persona.name} />
            </div>
          </div>
        </section>
      )}

      <section className="home-sec home-alt" id="home-faq" aria-labelledby="home-faq-t">
        <div className="home-wrap home-faq">
          <div>
            <p className="eyebrow">Good to know</p>
            <h2 id="home-faq-t">Questions</h2>
          </div>
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
        <img className="home-cta-img" src={heroSrc} alt="" loading="lazy" decoding="async" />
        <div className="home-wrap home-cta-in">
          <div>
            <p className="eyebrow">Begin</p>
            <h2 id="home-cta-t">Ready when you are</h2>
          </div>
          <div className="home-cta-actions">
            <a className="button home-cta-main" href="/listings/new">List your property</a>
            <a className="button secondary" href="/listings">Browse listings</a>
          </div>
        </div>
      </section>
    </main>
    </>
  );
}
