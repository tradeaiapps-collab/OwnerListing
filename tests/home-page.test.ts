import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Home from "../app/page";
import { filtersFromParams } from "../app/listings/url-params";

// The home page reads the request theme (needs a request scope); give it the default theme.
vi.mock("../src/server/request-theme", async () => {
  const { DEFAULT_THEME } = await import("../src/domain/site-theme");
  return { getRequestTheme: async () => ({ settings: DEFAULT_THEME, source: "published", previewToken: null }) };
});

const root = path.join(__dirname, "..");
const params = (s: string) => new URLSearchParams(s);

describe("home page", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("renders without a database, with the empty state and the main sections", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain('action="/listings"');
    expect(html).toContain("No listings published yet");
    for (const t of ["How it works", "For owners", "solicitor&#x27;s trust account", "AI never accepts an offer", "/plans", "/listings/new"]) expect(html).toContain(t);
    expect(html).not.toMatch(/Internal build|not live/i);
  });

  it("uses the configured brand name and tagline", async () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_NAME", "Acme Homes");
    vi.stubEnv("NEXT_PUBLIC_SITE_TAGLINE", "Own your sale");
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain("Acme Homes holds no money");
    expect(html).toContain("Own your sale");
    expect(html).not.toContain("OwnerListing");
  });

  it("shows the preview badge outside production only", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(renderToStaticMarkup(await Home())).not.toContain("Preview");
    vi.stubEnv("NODE_ENV", "development");
    expect(renderToStaticMarkup(await Home())).toContain("Preview");
  });

  it("has the full-length sections, the default hero photo and no invented figures", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const html = renderToStaticMarkup(await Home());
    for (const t of ["/hero-default.jpg", "Sell your home", "List your home yourself", "Browse by state", "/listings?state=qld", "Questions", "How do offers work?", "Illustrative only", "Secure chat", "Compare the cost"]) expect(html, t).toContain(t);
    expect(html).not.toMatch(/testimonial|\d+% of (owners|buyers)|rated \d/i);
  });

  it("uses the uploaded hero photo with a preload when one is published", async () => {
    vi.resetModules();
    vi.doMock("../src/server/request-theme", async () => {
      const { DEFAULT_THEME } = await import("../src/domain/site-theme");
      return { getRequestTheme: async () => ({ settings: { ...DEFAULT_THEME, brand: { ...DEFAULT_THEME.brand, hero: 42 } }, source: "published", previewToken: null }) };
    });
    vi.stubEnv("DATABASE_URL", "");
    const { default: HomeWithHero } = await import("../app/page");
    const html = renderToStaticMarkup(await HomeWithHero());
    expect(html).toContain('class="hx-img" src="/api/site/asset/hero?v=42"');
    expect(html).toContain('rel="preload"');
    expect(html).not.toContain("hx-art");
    vi.doUnmock("../src/server/request-theme");
  });

  it("renders the Hairline hero: Buy, Sell and Rent bar, four default photo crops and the tagline as the heading", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain('<nav class="hl-modes" aria-label="Buy, sell or rent"><a href="/listings?type=sale">Buy</a><a href="/listings/new">Sell</a><a href="/listings?type=rent">Rent</a></nav>');
    expect(html.match(/class="hx-img" src="\/hero-default.jpg"/g)).toHaveLength(4);
    expect(html.match(/data-on=""/g)).toHaveLength(1);
    expect(html).toMatch(/<h1 id="home-title" class="hl-title"><span class="sr-only">[^<]+<\/span>/);
    expect(html).toContain('aria-label="Pause slideshow"');
    // the search card now sits in its own section below the photo
    expect(html.indexOf('id="home-find"')).toBeGreaterThan(html.indexOf("hx-hairline"));
    expect(html.indexOf('action="/listings"')).toBeGreaterThan(html.indexOf('id="home-find"'));
  });

  it("builds hero slides and lines from an uploaded photo and the tagline", async () => {
    const { heroSlides, heroLines, DEFAULT_HERO_SLIDES, HERO_LINES } = await import("../src/domain/home-hero");
    expect(heroSlides(null)).toEqual(DEFAULT_HERO_SLIDES);
    expect(heroSlides("/api/site/asset/hero?v=7")).toEqual([{ src: "/api/site/asset/hero?v=7", focus: "var(--hero-focus, 50%) 50%", zoom: 1 }]);
    expect(heroLines("Own your sale")).toEqual(["Own your sale", ...HERO_LINES]);
    expect(heroLines(HERO_LINES[0]!)).toHaveLength(HERO_LINES.length);
  });

  it("keeps its styles in home.css and the old hero rules are gone", () => {
    expect(readFileSync(path.join(root, "app/globals.css"), "utf8")).not.toMatch(/\.hero\b/);
    expect(readFileSync(path.join(root, "app/page.tsx"), "utf8")).toContain('./styles/home.css');
  });
});

describe("browse URL filters", () => {
  it("reads valid values", () => {
    expect(filtersFromParams(params("state=qld&type=rent&use=residential&suburb=Paddington&beds=3&price=900"))).toEqual({
      jurisdiction: "QLD", transactionType: "rent", useClass: "residential", location: "Paddington", minBedrooms: "3", maxPrice: "900"
    });
    expect(filtersFromParams(params("location=4064&type=sale")).location).toBe("4064");
    expect(filtersFromParams(params("postcode=4000")).location).toBe("4000");
  });

  it("drops invalid, oversized or hostile values", () => {
    expect(filtersFromParams(params("state=XX&type=lease&use=x&beds=9&price=abc"))).toEqual({});
    expect(filtersFromParams(params(`suburb=${"a".repeat(81)}`))).toEqual({});
    expect(filtersFromParams(params("type=sale&price=1e9;drop")).maxPrice).toBeUndefined();
    expect(filtersFromParams(params("type=sale&price=-5")).maxPrice).toBeUndefined();
    expect(filtersFromParams(params("price=500")).maxPrice).toBeUndefined();
    expect(filtersFromParams(params("beds=0"))).toEqual({});
  });

  it("an empty query changes nothing", () => {
    expect(filtersFromParams(params(""))).toEqual({});
  });
});
