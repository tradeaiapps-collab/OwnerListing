/**
 * The "next step" checklist on the dashboard and the guide assistant's "what should I do next?". Pure: it only turns facts the
 * server already holds about the signed-in user (their own records) into steps. Steps only guide; every route still enforces access.
 */
export type JourneyStatus = "done" | "todo" | "unavailable";
export interface JourneyStep { id: string; label: string; hint: string; href: string; status: JourneyStatus }

export interface OwnerFacts {
  termsAccepted: boolean;
  listingCount: number;
  /** The listing the next steps point at (the first not yet published, else the first). */
  focusListingId: string | null;
  photoCount: number;
  planChosen: boolean;
  published: boolean;
}
export interface BuyerFacts {
  emailVerified: boolean; phoneVerified: boolean; idVerified: boolean;
  termsAccepted: boolean; savedSearches: number; enquiries: number;
}

const step = (id: string, label: string, hint: string, href: string, done: boolean): JourneyStep =>
  ({ id, label, hint, href, status: done ? "done" : "todo" });

export function ownerChecklist(f: OwnerFacts): JourneyStep[] {
  const id = f.focusListingId;
  const onListing = (path: string) => (id ? `/listings/${id}${path}` : "/listings/new");
  return [
    step("email", "Confirm your email", "Done when you signed in with your email account.", "/settings", true),
    // Owner mobile and ID checks are not built yet: shown so the journey is clear, never counted as missing.
    { id: "phone_id", label: "Verify your mobile and ID", hint: "Owner mobile and ID checks are not switched on yet. Nothing to do for now.", href: "/settings", status: "unavailable" },
    step("terms", "Accept the terms", "Needed before you can publish or reply to offers.", "/terms", f.termsAccepted),
    step("listing", "Create your listing", "Add the address, price and details. It stays a draft until you publish.", "/listings/new", f.listingCount > 0),
    step("photos", "Add photos", "Good photos get more enquiries. Upload them on the listing's files page.", onListing("/documents"), f.photoCount > 0),
    step("plan", "Choose a plan", "Pick a listing plan. Prices include GST.", id ? `/listings/${id}/checkout` : "/plans", f.planChosen),
    step("publish", "Publish", "Goes live once your solicitor's trust account is verified and the checks pass.", "/listings/mine", f.published)
  ];
}

export function buyerChecklist(f: BuyerFacts): JourneyStep[] {
  return [
    step("email", "Verify your email", "One time, from the Verification page.", "/buyer/verification", f.emailVerified),
    step("phone", "Verify your mobile", "We send a code by SMS.", "/buyer/verification", f.phoneVerified),
    step("id", "Verify your ID", "Needed before you can make an offer.", "/buyer/verification", f.idVerified),
    step("terms", "Accept the terms", "Needed before you can enquire or offer.", "/terms", f.termsAccepted),
    step("search", "Save a search", "Get an alert when a matching home is listed.", "/buyer/saved-searches", f.savedSearches > 0),
    step("enquire", "Send your first enquiry", "Open a listing and press Enquire to message the owner.", "/listings", f.enquiries > 0)
  ];
}

/** The first step still to do, or null when everything that can be done is done. */
export const nextStep = (steps: readonly JourneyStep[]): JourneyStep | null => steps.find(s => s.status === "todo") ?? null;

/** Done and total, leaving out steps that are not available yet. */
export function progress(steps: readonly JourneyStep[]): { done: number; total: number } {
  const counted = steps.filter(s => s.status !== "unavailable");
  return { done: counted.filter(s => s.status === "done").length, total: counted.length };
}
