/**
 * Turns a notification's website link into a screen in the app. Push messages carry the same link the website uses (for example
 * /listings/<id> or /agent-appointments/<id>/messages). Anything the app has no screen for opens the notifications list.
 */
export type AppRoute =
  | { screen: "listing"; id: string }
  | { screen: "messages"; appointmentId: string }
  | { screen: "appointments" }
  | { screen: "offers"; listingId: string }
  | { screen: "settlement"; id: string }
  | { screen: "settlements" }
  | { screen: "inspections" }
  | { screen: "today" }
  | { screen: "saved" }
  | { screen: "notifications" };

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const MESSAGES = new RegExp(`^/agent-appointments/(${UUID})/messages$`, "i");
const LISTING = new RegExp(`^/listings/(${UUID})$`, "i");
const OFFERS = new RegExp(`^/listings/(${UUID})/offers(?:/${UUID})?$`, "i");
const SETTLEMENT = new RegExp(`^/settlements/(${UUID})(?:/messages)?$`, "i");

export function routeForLink(link: unknown): AppRoute {
  if (typeof link !== "string" || link.length > 500) return { screen: "notifications" };
  let path = link;
  if (/^https?:\/\//i.test(link)) {
    try {
      path = new URL(link).pathname; // absolute links (from emails): keep only the path
    } catch {
      return { screen: "notifications" };
    }
  }
  path = path.split(/[?#]/)[0]!.replace(/\/$/, "");
  let m = MESSAGES.exec(path);
  if (m) return { screen: "messages", appointmentId: m[1]!.toLowerCase() };
  m = LISTING.exec(path);
  if (m) return { screen: "listing", id: m[1]!.toLowerCase() };
  m = OFFERS.exec(path);
  if (m) return { screen: "offers", listingId: m[1]!.toLowerCase() };
  m = SETTLEMENT.exec(path);
  if (m) return { screen: "settlement", id: m[1]!.toLowerCase() };
  if (path === "/settlements") return { screen: "settlements" };
  if (path === "/agent/inspections") return { screen: "inspections" };
  if (path === "/listings/mine") return { screen: "today" };
  if (path === "/agent/appointments" || path === "/agent-appointments") return { screen: "appointments" };
  if (path === "/buyer/saved" || path === "/buyer/saved-listings") return { screen: "saved" };
  return { screen: "notifications" };
}

/** The expo-router path for a route. */
export function hrefFor(r: AppRoute): string {
  switch (r.screen) {
    case "listing": return `/listing/${r.id}`;
    case "messages": return `/messages/${r.appointmentId}`;
    case "appointments": return "/appointments";
    case "offers": return `/listing-offers/${r.listingId}`;
    case "settlement": return `/settlement/${r.id}`;
    case "settlements": return "/settlements";
    case "inspections": return "/inspections";
    case "today": return "/today";
    case "saved": return "/saved";
    case "notifications": return "/notifications";
  }
}
