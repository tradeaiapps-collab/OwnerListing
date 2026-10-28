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

/** Wide daytime home photos (free-licence stock, credits in public/hero/CREDITS.txt) until real listing photos are wired in. */
export const DEFAULT_HERO_SLIDES: readonly HeroSlide[] = [
  { src: "/hero/hero-1.jpg", focus: "50% 45%", zoom: 1 },
  { src: "/hero/hero-2.jpg", focus: "50% 55%", zoom: 1 },
  { src: "/hero/hero-3.jpg", focus: "35% 55%", zoom: 1 },
  { src: "/hero/hero-4.jpg", focus: "45% 50%", zoom: 1 }
];

/** Lines that follow the brand tagline. Factual claims only: each one matches a product rule. */
export const HERO_LINES: readonly string[] = [
  "Talk to the owner, not a middleman",
  "No commission on the sale",
  "You decide on every offer"
];

/** An uploaded hero photo (Site appearance) leads and the default photos follow it, so the slideshow always has photos to cycle. */
export function heroSlides(uploaded: string | null): HeroSlide[] {
  return uploaded ? [{ src: uploaded, focus: "var(--hero-focus, 50%) 50%", zoom: 1 }, ...DEFAULT_HERO_SLIDES] : [...DEFAULT_HERO_SLIDES];
}

/** Seconds each slide shows before the next crossfades in. */
export const HERO_SLIDE_SECONDS = 7;

/** The tagline leads; the rest rotate after it. */
export function heroLines(tagline: string): string[] {
  return [tagline, ...HERO_LINES.filter(l => l !== tagline)];
}
