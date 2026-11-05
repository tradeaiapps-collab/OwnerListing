/**
 * Virtual tour links (pure). The owner pastes one https link; we recognise a few hosted tour platforms and rebuild
 * the embed address from the tour id alone, so a pasted link can never put an arbitrary address in a frame.
 * Any other link is still shown, but only as a link that opens in a new tab.
 */
export type TourKind = "3d" | "360" | "video" | "link";
export type TourProvider = "matterport" | "kuula" | "youtube" | "vimeo" | "other";

export interface TourInfo {
  provider: TourProvider;
  kind: TourKind;
  /** Short name for buttons and Elena, such as "3D tour". */
  label: string;
  /** Frame address on a known host. Absent for unknown providers. */
  embedUrl?: string;
  /** The link the owner gave (always https). */
  url: string;
}

export const TOUR_LABEL: Record<TourKind, string> = { "3d": "3D tour", "360": "360 tour", video: "Video tour", link: "Virtual tour" };

const ID = /^[A-Za-z0-9_-]{4,40}$/;
const host = (h: string) => h.replace(/^www\./, "").toLowerCase();

/** Classifies a tour link. Returns undefined when it is not a usable https link. */
export function classifyTour(raw: string | null | undefined): TourInfo | undefined {
  if (!raw) return undefined;
  let u: URL;
  try { u = new URL(raw); } catch { return undefined; }
  if (u.protocol !== "https:" || u.username || u.password) return undefined;
  const h = host(u.hostname), parts = u.pathname.split("/").filter(Boolean);
  const make = (provider: TourProvider, kind: TourKind, embedUrl?: string): TourInfo =>
    ({ provider, kind, label: TOUR_LABEL[kind], ...(embedUrl ? { embedUrl } : {}), url: u.toString() });

  if (h === "my.matterport.com" && parts[0] === "show") {
    const m = u.searchParams.get("m");
    if (m && ID.test(m)) return make("matterport", "3d", `https://my.matterport.com/show/?m=${m}`);
  }
  if (h === "kuula.co" && (parts[0] === "share" || parts[0] === "post") && parts[1] && ID.test(parts[1]))
    return make("kuula", "360", `https://kuula.co/share/${parts[1]}`);
  if (h === "youtu.be" && parts[0] && ID.test(parts[0])) return make("youtube", "video", `https://www.youtube-nocookie.com/embed/${parts[0]}`);
  if ((h === "youtube.com" || h === "m.youtube.com") && parts[0] === "watch") {
    const v = u.searchParams.get("v");
    if (v && ID.test(v)) return make("youtube", "video", `https://www.youtube-nocookie.com/embed/${v}`);
  }
  if (h === "vimeo.com" && parts[0] && /^\d{5,12}$/.test(parts[0])) return make("vimeo", "video", `https://player.vimeo.com/video/${parts[0]}`);
  return make("other", "link");
}

/** Hosts a tour frame may load from. The page's frame-src policy is built from this list. */
export const TOUR_FRAME_HOSTS = ["my.matterport.com", "kuula.co", "www.youtube-nocookie.com", "player.vimeo.com"] as const;

/** Wide enough to be an equirectangular 360 photo (2:1, with a little slack for cropped exports). */
export function looks360(width: number, height: number): boolean {
  return height > 0 && width / height >= 1.9 && width / height <= 2.1;
}

export interface TourSummaryInput {
  title: string;
  tour?: TourInfo | undefined;
  /** Captions of the visible 360 photos, in gallery order (blank captions left out). */
  rooms: readonly string[];
  /** Number of visible 360 photos, captioned or not. */
  panoramas: number;
  /** Plain facts from the listing, such as "4 bedrooms, 2 bathrooms and 2 car spaces". */
  highlights?: string | undefined;
}

const list = (xs: readonly string[]) => (xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * What Elena says about a listing's tour. Built only from what the owner supplied (the tour type, the 360 photo captions)
 * and the listing's own facts: she cannot see inside a tour, and says so.
 */
export function tourSummary(i: TourSummaryInput): string {
  const parts: string[] = [];
  if (i.tour) parts.push(`${i.title} has a ${i.tour.label.replace(/^(Video|Virtual)/, m => m.toLowerCase())}${i.tour.embedUrl ? " you can start right on the property page" : " that opens in a new tab"}.`);
  if (i.panoramas > 0) {
    const named = i.rooms.slice(0, 8);
    parts.push(`There ${i.panoramas === 1 ? "is 1 360 photo" : `are ${i.panoramas} 360 photos`} you can look around by dragging${named.length ? `, including ${list(named)}` : ""}.`);
  }
  if (parts.length === 0) return `${i.title} doesn't have a virtual tour or 360 photos yet. The owner can add one from the photo manager.`;
  if (i.highlights) parts.push(`From the listing: ${i.highlights}.`);
  parts.push("I can't see inside the tour myself, so I only describe what the owner has labelled. Have a look around, and ask the owner here for anything it doesn't show.");
  return parts.join(" ");
}
