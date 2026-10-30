import type { ShowMePlace } from "../../src/domain/chat-assistant";

/** Where each place is on the page. First one that is on screen wins (the phone menu may hide the nav links). */
const SELECTORS: Record<ShowMePlace, string> = {
  my_offers: '.site-nav a[href="/offers"]',
  my_listings: '.site-nav a[href="/listings/mine"]',
  offer_link: "#el-offer-link"
};

const visible = (el: Element | null): el is HTMLElement => {
  if (!(el instanceof HTMLElement)) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
};

export const findPlace = (places: readonly ShowMePlace[]): HTMLElement | undefined => {
  for (const p of places) { const el = document.querySelector(SELECTORS[p]); if (visible(el)) return el; }
  return undefined;
};

const wait = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
const HOLD_MS = 2600;

/**
 * Elena's cut-out glides from the stage to the place, points at it while it glows, then glides back. With reduced motion it only
 * scrolls to the place and lights it. Returns false when the place is not on the page. `cancelled()` stops it early (page left).
 */
export async function showMe(opts: { from: HTMLElement; places: readonly ShowMePlace[]; src: string; flip: boolean; cancelled: () => boolean }): Promise<boolean> {
  const target = findPlace(opts.places);
  if (!target) return false;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const glow = () => target.classList.add("is-pointed");
  const unglow = () => target.classList.remove("is-pointed");
  target.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  if (still) { glow(); await wait(HOLD_MS); unglow(); return true; }
  await wait(500);
  if (opts.cancelled()) return true;

  const size = 72;
  const a = opts.from.getBoundingClientRect();
  const home = { x: a.left + a.width / 2 - size / 2, y: a.top + Math.min(a.height / 2, 120) - size / 2 };
  const t = target.getBoundingClientRect();
  // Lands just left of the target; with no room there (a full-width block on a phone) she stands on its top edge instead.
  const room = t.left - size - 8 >= 8;
  const goal = room ? { x: t.left - size - 8, y: t.top + t.height / 2 - size / 2 } : { x: Math.max(8, t.right - size - 16), y: t.top - size + 14 };
  const glider = document.createElement("div");
  glider.className = "el-glider";
  glider.setAttribute("aria-hidden", "true");
  const img = document.createElement("img");
  img.src = opts.src; img.alt = "";
  if (opts.flip) img.style.scale = "-1 1";
  glider.append(img);
  Object.assign(glider.style, { width: `${size}px`, height: `${size}px` });
  document.body.append(glider);
  const move = (from: { x: number; y: number }, to: { x: number; y: number }) =>
    glider.animate([{ transform: `translate(${from.x}px, ${from.y}px) scale(0.6)` }, { transform: `translate(${to.x}px, ${to.y}px) scale(1)` }], { duration: 900, easing: "cubic-bezier(0.22, 0.68, 0.2, 1)", fill: "forwards" }).finished;
  try {
    await move(home, goal);
    glow();
    await wait(HOLD_MS);
    unglow();
    if (!opts.cancelled()) {
      const back = opts.from.getBoundingClientRect();
      await move(goal, { x: back.left + back.width / 2 - size / 2, y: back.top + Math.min(back.height / 2, 120) - size / 2 });
    }
  } finally {
    unglow();
    glider.remove();
  }
  return true;
}
