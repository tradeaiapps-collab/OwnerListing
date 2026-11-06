/**
 * Elena's page awareness. Pure and client-safe (no imports): maps a URL path and a form field to a readable page and section,
 * gives the hint Elena shows for that section, and reads room counts from the owner's own words.
 * PRIVACY: where a person is on the site is kept in the browser tab's memory only. It is never sent to the server or stored.
 */
export interface ElenaPlace { path: string; pageLabel: string; section: string; sectionLabel: string; field: string }

const PAGES: [RegExp, string][] = [
  [/^\/$/, "Home"], [/^\/listings\/new$/, "Create a listing"], [/^\/listings\/mine$/, "My listings"], [/^\/listings\/[^/]+\/edit$/, "Edit listing"],
  [/^\/listings\/[^/]+/, "Listing"], [/^\/listings$/, "Browse listings"], [/^\/messages/, "Messages"], [/^\/enquiries/, "Enquiries"],
  [/^\/offers/, "Offers"], [/^\/plans/, "Plans and fees"], [/^\/dashboard/, "Dashboard"], [/^\/settings/, "Settings"], [/^\/billing/, "Billing"],
  [/^\/inspections/, "Inspections"], [/^\/settlements/, "Settlement"], [/^\/market/, "Market"], [/^\/buyer/, "Buyer area"], [/^\/agent/, "Agent area"],
  [/^\/notifications/, "Notifications"], [/^\/staff\/?$/, "Staff home"], [/^\/staff\/investments\/settings/, "Investor module settings"],
  [/^\/staff\/investments/, "Investor projects (staff)"], [/^\/staff\/disclosures/, "Disclosure requirements (staff)"], [/^\/staff/, "Staff console"]
];

/** A readable name from the last meaningful path segments, for pages without a fixed name ("/foo/bar-baz" becomes "Foo, bar baz"). */
function humanise(p: string): string {
  const parts = p.split("/").filter(s => s && !/^(\d+|[0-9a-f-]{16,})$/i.test(s)).slice(-2).map(s => decodeURIComponent(s).replace(/[-_]+/g, " "));
  const t = parts.join(", ");
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : "";
}

export function pageLabel(path: string): string {
  const p = path.split(/[?#]/)[0]!.replace(/\/+$/, "") || "/";
  for (const [re, label] of PAGES) if (re.test(p)) return label;
  return humanise(p) || "this page";
}

/** True when the person is asking which page they are on. */
export const isWhereQuestion = (text: string) => /\b(what|which)\s+(page|screen|section)\b|\bwhere\s+am\s+i\b|\bwhat\s+am\s+i\s+(looking|viewing)\b/i.test(text);

/** Elena's answer to "what page am I on", from the in-tab place only. */
export function whereAnswer(place: Pick<ElenaPlace, "path" | "pageLabel" | "sectionLabel">): string {
  const name = place.pageLabel && place.pageLabel !== "this page" ? place.pageLabel : "";
  const base = name ? `You are on ${name} (${place.path}).` : `You are on ${place.path}.`;
  return place.sectionLabel ? `${base} You last touched ${place.sectionLabel}.` : base;
}

export const isListingForm = (path: string) => /^\/listings\/new\/?$/.test(path) || /^\/listings\/[^/]+\/edit\/?$/.test(path);

export const LISTING_SECTIONS = {
  basics: "The basics", type: "What you are listing", location: "Location", price: "Price", description: "Description", features: "Features", photos: "Photos"
} as const;
export type ListingSection = keyof typeof LISTING_SECTIONS;

const FIELD_SECTION: Record<string, ListingSection> = {
  title: "basics", address: "basics", transactionType: "type", useClass: "type", propertyType: "type", jurisdiction: "type",
  suburb: "location", postcode: "location", price: "price", description: "description", bedrooms: "features", bathrooms: "features", parking: "features", amenities: "features"
};

/** The listing-form section a field belongs to, or undefined for any other field. */
export const sectionOfField = (name: string): ListingSection | undefined => FIELD_SECTION[name];

export interface SectionHint { text: string; action?: { id: "pricing" | "rewrite" | "shots" | "tell"; label: string } }

/** What Elena says about a section of the listing form, given which fields are still empty. */
export function sectionHint(section: string, empty: { price: boolean; description: boolean; rooms: boolean }): SectionHint | undefined {
  switch (section) {
    case "basics": return { text: "A clear title and the exact street address help buyers find it. Start typing the street and I suggest the address." };
    case "type": return { text: "Choose sale or rent first. It changes my price guidance and the questions I ask." };
    case "location": return { text: "Buyers search by suburb, and I use it to find recent nearby results." };
    case "price": return empty.price
      ? { text: "Not sure what to ask? I can show a range from recent nearby results.", action: { id: "pricing", label: "Show price guidance" } }
      : { text: "I compare your price with recent nearby results. You decide the number.", action: { id: "pricing", label: "Check my price" } };
    case "description": return empty.description
      ? { text: "Tell me about the property in your own words and I will fill in the details.", action: { id: "tell", label: "Tell Elena" } }
      : { text: "I can tidy the wording or make it shorter. You keep control of every change.", action: { id: "rewrite", label: "Make it better" } };
    case "features": return empty.rooms
      ? { text: "Bedrooms, bathrooms and parking are the first filters buyers use. Tell me and I fill them in.", action: { id: "tell", label: "Tell Elena" } }
      : { text: "Tick only what is true. I suggest extras I find in your description." };
    case "photos": return { text: "About 10 bright, landscape photos work best. I have a shot list.", action: { id: "shots", label: "Open shot list" } };
    default: return undefined;
  }
}

const WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8 };
const NUM = "(\\d{1,2}|one|two|three|four|five|six|seven|eight)";
const toNum = (s: string) => (/^\d+$/.test(s) ? Number(s) : WORDS[s.toLowerCase()]);

/** Room counts the owner wrote ("3 bed, 2 bath, 2 car"). Only their own numbers are read, never guessed. */
export function roomsFromText(text: string): { bedrooms?: number; bathrooms?: number; parking?: number } {
  const t = text.replace(/\s+/g, " ");
  const pick = (re: RegExp) => { const m = re.exec(t); const n = m ? toNum(m[1]!) : undefined; return n !== undefined && n <= 20 ? n : undefined; };
  const out: { bedrooms?: number; bathrooms?: number; parking?: number } = {};
  const b = pick(new RegExp(`\\b${NUM}[ -]?(?:bed(?:room)?s?|br|bdrm?s?)\\b`, "i"));
  const ba = pick(new RegExp(`\\b${NUM}[ -]?(?:bath(?:room)?s?)\\b`, "i"));
  const p = pick(new RegExp(`\\b${NUM}[ -]?(?:car(?: ?(?:spaces?|garage|park|port))?s?|garages?|carports?|parking)\\b`, "i"));
  if (b !== undefined) out.bedrooms = b;
  if (ba !== undefined) out.bathrooms = ba;
  if (p !== undefined) out.parking = p;
  return out;
}

// ---- Free conversation: Elena answers typed questions from where the person is, on every page ----
const FORM_TOPICS: readonly [ListingSection, RegExp, string][] = [
  ["photos", /\b(repeat\w*|duplicat\w*|same\s+(photo|shot|image)|twice|hide\s+photo|remove\s+photo|keep\s+both|delete\s+(a\s+)?photo)\b/i,
    "Repeated photos: the red warning shows which photos match. Under each one choose Hide (keeps it saved but off the listing), Remove (deletes it) or Keep both if they really are different shots. I can't press those for you, because you decide which photo stays."],
  ["photos", /\b(photos?|images?|pictures?|pics?|floor\s*plans?|360|upload|choose\s+(the\s+)?images?|cover|captions?|drag)\b/i,
    "Photos: press Choose images (or drag files in) and pick Photos, Floor plans or 360 from the list first. JPEG, PNG or WebP up to 10 MB each. Location and camera details are removed automatically, and the first photo is the cover. Ask Elena for captions writes them for you, and you can reorder or remove photos any time."],
  ["price", /\b(price|pricing|asking|how\s+much\s+(should|to)|worth|range)\b/i,
    "Price: you set the number. Press Show price guidance (or Check my price) in the Price section and I compare recent nearby results. I can't value your home or tell you what to accept."],
  ["description", /\b(description|describe|wording|write|rewrite|text|summary|headline)\b/i,
    "Description: write it in your own words and press Make it better if you want it tidied or shorter. Or press Tell Elena and describe the property in plain language and I fill in the details for you. You approve every change."],
  ["features", /\b(features?|bed(room)?s?|bath(room)?s?|parking|car\s*(space|park)s?|garage|amenit\w+|extras?)\b/i,
    "Features: bedrooms, bathrooms and parking are the first filters buyers use. Type them or tell me (for example 3 bed, 2 bath, 2 car) and I fill them in. Tick only extras that are true."],
  ["location", /\b(location|suburb|postcode|map|pin|street|address)\b/i,
    "Location: start typing the street address and pick the suggestion. I place the map pin from it, and you can drag the pin if it is slightly off."],
  ["type", /\b(sale|sell|rent|rental|lease|type|house|unit|apartment|land|commercial|state|jurisdiction)\b/i,
    "What you are listing: choose sale or rent first, then the property type and state. It changes my price guidance, the questions I ask and the disclosure documents your state needs."],
  ["basics", /\b(title|name\s+of\s+(the\s+)?listing|headline)\b/i,
    "Title: keep it short and specific, for example the street, suburb and the one thing buyers will love."]
];
const SAVE_RE = /\b(save|draft|publish|go\s+live|submit|finish|done|live)\b/i;
const HELP_RE = /\b(help|explain|what\s+(do|can|should)\s+i|what\s+is\s+(this|here)|what\s+can\s+you|how\s+(do|does|can)|guide\s+me|stuck|confus\w*|not\s+sure|don'?t\s+know|next)\b/i;
const HELLO_RE = /^\s*(hi|hello|hey|hiya|g'?day|good\s+(morning|afternoon|evening)|yo)\b[\s!.?]*$/i;
const THANKS_RE = /\b(thanks?|thank\s+you|cheers|great|perfect|awesome)\b/i;

const PAGE_HELP: Record<string, string> = {
  "Home": "This is the home page. You can start a listing, browse properties, or ask me how selling and buying work here.",
  "Browse listings": "This is where you browse properties. Use the filters or ask me to search for you, save a search for alerts, compare listings, or open one and press Enquire.",
  "Listing": "This is a listing. You can read the details, save or compare it, and press Enquire to message the owner. Offers are made through the secure link in the enquiry chat after you verify.",
  "My listings": "These are your listings. Open one to edit it, check enquiries and offers, replace documents, or see its status.",
  "Create a listing": "You are creating a listing. It saves as a draft, so nothing goes live until your checks pass. I can fill details from your notes and check it before you publish.",
  "Edit listing": "You are editing a listing. Change any section and save. I can tidy the description, suggest captions or check the price against recent results.",
  "Messages": "This is your secure message chat. Messages are kept as a record and can't be deleted.",
  "Enquiries": "These are your enquiries. Open one to continue the chat, and offers arrive through the secure offer link there.",
  "Offers": "This is where offers are reviewed. Owners decide to accept, counter or decline. I can explain the options but never decide for you.",
  "Plans and fees": "These are the plans and fees, with GST shown. There is no commission, and deposits go to the solicitor's trust account.",
  "Dashboard": "This is your dashboard with your progress and next steps. Ask me what to do next."
};

/** Where she thinks the person is, in words. */
export function placeSentence(place: Pick<ElenaPlace, "pageLabel" | "sectionLabel">): string {
  const page = place.pageLabel && place.pageLabel !== "this page" ? place.pageLabel : "this page";
  return place.sectionLabel ? `You are on ${page}, in ${place.sectionLabel}.` : `You are on ${page}.`;
}

/**
 * A direct answer to a typed question from where the person is, or null to let the normal guide answer. On the listing form she answers
 * about the section named in the question, or the section the person is in. Elsewhere she answers "help / what is this page" questions
 * and greetings. Never advice, never other users' data, nothing sent anywhere.
 */
export function contextAnswer(text: string, place: ElenaPlace): string | null {
  const t = text.trim().slice(0, 500);
  if (!t) return null;
  if (HELLO_RE.test(t)) return `Hi! ${placeSentence(place)} Ask me anything about it, in your own words.`;
  if (/^\s*(thanks?|thank\s+you|cheers)\b[\s!.]*$/i.test(t) || (t.length < 25 && THANKS_RE.test(t) && !HELP_RE.test(t))) return "You're welcome! Ask me anything else, any time.";
  if (isListingForm(place.path)) {
    const named = FORM_TOPICS.find(([, re]) => re.test(t));
    if (named) return `${placeSentence({ pageLabel: place.pageLabel, sectionLabel: place.sectionLabel })} ${named[2]}`;
    if (/^\s*(fix|fix\s+(it|this|that)|please\s+fix(\s+(it|this))?|solve|sort\s+(it|this)\s+out)[\s!.?]*$/i.test(t)) {
      return place.section === "photos" || !place.section
        ? "I can't change your photos for you, but here is the fix: in the red repeated-photos warning press Hide or Remove under the photo that repeats, or Keep both if they are different. Tell me which part is wrong and I'll walk you through it."
        : `${placeSentence(place)} Tell me what looks wrong in this section and I'll walk you through the fix. I can tidy the description, check the price or fill in details from your notes.`;
    }
    if (SAVE_RE.test(t)) return "Your listing saves as a draft as you go. It can go live once your solicitor's trust account is verified, your state's documents are added and the publishing checks pass. I run those checks for you before you publish.";
    if (HELP_RE.test(t)) {
      const hint = place.section ? sectionHint(place.section, { price: false, description: false, rooms: false }) : undefined;
      return hint ? `${placeSentence(place)} ${hint.text}` : `${placeSentence(place)} Tell me about the property in your own words, or ask about any part of the form: photos, price, description, features or location.`;
    }
    return null;
  }
  if (HELP_RE.test(t) && !/\b(offers?|fees?|verif\w*|enquir\w*|document\w*)\b/i.test(t)) {
    const help = PAGE_HELP[place.pageLabel];
    return help ? `${placeSentence(place)} ${help}` : `${placeSentence(place)} Ask me what you want to do here and I will point you the right way.`;
  }
  return null;
}

/** When nothing matched: stay in the conversation and say what she can do right here, not "I didn't catch that". */
export function contextFallback(place: ElenaPlace): string {
  const where = placeSentence(place);
  return isListingForm(place.path)
    ? `${where} I'm not sure I understood that one. Try asking about photos, price, description, features or location, or tell me about the property and I fill it in.`
    : `${where} I'm not sure I understood that one. Try asking in different words, ask what you can do on this page, or pick a topic below.`;
}
