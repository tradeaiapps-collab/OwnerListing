/**
 * Homepage hero slideshow ("Hairline"). Each slide is a photo plus a crop; the headline lines rotate with the slides.
 * To show real listing photos later, build the slide list from listing photos instead of DEFAULT_HERO_SLIDES.
 */
export type HeroSlide = {
  src: string;
  /** CSS object-position, e.g. "50% 60%" */
  focus: string;
  /** Extra zoom for a tighter crop of the same photo (1 = none). */
  zoom: number;
};

/** The site's own skyline photo shown as four crops, until real listing photos are wired in. */
export const DEFAULT_HERO_SLIDES: readonly HeroSlide[] = [
  { src: "/hero-default.jpg", focus: "50% 55%", zoom: 1 },
  { src: "/hero-default.jpg", focus: "78% 45%", zoom: 1.35 },
  { src: "/hero-default.jpg", focus: "22% 50%", zoom: 1.3 },
  { src: "/hero-default.jpg", focus: "55% 70%", zoom: 1.5 }
];

/** Lines that follow the brand tagline. Factual claims only: each one matches a product rule. */
export const HERO_LINES: readonly string[] = [
  "Talk to the owner, not a middleman",
  "No commission on the sale",
  "You decide on every offer"
];

/** An uploaded hero photo (Site appearance) replaces the default crops; otherwise the default slides. */
export function heroSlides(uploaded: string | null): HeroSlide[] {
  return uploaded ? [{ src: uploaded, focus: "var(--hero-focus, 50%) 50%", zoom: 1 }] : [...DEFAULT_HERO_SLIDES];
}

/** The tagline leads; the rest rotate after it. */
export function heroLines(tagline: string): string[] {
  return [tagline, ...HERO_LINES.filter(l => l !== tagline)];
}
