/**
 * Anti-discrimination wording filter (House Listing Spec 6.4). Pure functions, no I/O.
 *
 * Australia has no single Fair Housing Act. The Racial, Sex, Disability and Age Discrimination Acts (Cth) and each state's law
 * (Queensland: Anti-Discrimination Act 1991, s 7 attributes) make it unlawful to refuse, or advertise an intention to refuse,
 * accommodation or a sale because of a protected attribute. This filter catches wording that states or implies such a preference
 * in listing titles, descriptions, owner messages, auto-reply templates and AI drafts.
 *
 * Two severities:
 * - "block": the text cannot be published or sent. Staff can clear a match on a listing (some exceptions are lawful, for example
 *   seniors housing or share accommodation in the owner's own home) and the clearance is recorded.
 * - "warn": shown to the owner as advice; it does not block.
 *
 * Gate G1 needs at least 95% recall on the labelled set in tests/discrimination-filter.test.ts. This is a starting map, not legal
 * advice; Australian counsel reviews the phrase list before G1.
 */

export type DiscriminationCategory =
  | "familial_status" | "age" | "race" | "religion" | "sex" | "sexuality_gender" | "relationship_status"
  | "disability" | "income_source" | "occupation";

export type FlagSeverity = "block" | "warn";

export interface WordingFlag {
  /** Stable rule id (for analytics and the staff queue). */
  ruleId: string;
  category: DiscriminationCategory;
  severity: FlagSeverity;
  /** The exact text that matched, as written. */
  match: string;
  start: number;
  end: number;
  /** What the owner sees: why it was flagged and a neutral way to say it. */
  message: string;
  suggestion: string;
}

export interface ScanResult {
  flags: WordingFlag[];
  /** True when at least one flag has severity "block". */
  blocked: boolean;
}

export const CATEGORY_LABELS: Record<DiscriminationCategory, string> = {
  familial_status: "children, family or pregnancy",
  age: "age",
  race: "race, nationality or ethnic origin",
  religion: "religion",
  sex: "sex",
  sexuality_gender: "sexuality or gender identity",
  relationship_status: "relationship status",
  disability: "disability",
  income_source: "source of income",
  occupation: "occupation"
};

/** Neutral alternative per category: describe the property, never the people. */
const SUGGESTIONS: Record<DiscriminationCategory, string> = {
  familial_status: "Describe the property instead, for example \"3 bedrooms, fenced yard, 5 minutes to schools\" or \"low-maintenance unit\".",
  age: "Describe the property instead, for example \"single-level living, no stairs\" or \"close to transport and shops\".",
  race: "Remove it. For buyers from overseas, say \"Foreign Investment Review Board (FIRB) rules may apply\".",
  religion: "Remove it. You can describe nearby places, for example \"5 minutes to local churches and schools\".",
  sex: "Remove it and describe the room or property, for example \"furnished room with private bathroom\".",
  sexuality_gender: "Remove it and describe the property instead.",
  relationship_status: "State the occupancy limit instead, for example \"suits up to 2 occupants\".",
  disability: "Describe access features instead, for example \"step-free entry\" or \"stairs to all bedrooms\".",
  income_source: "Remove it. Every applicant is assessed on ability to pay, references and identity.",
  occupation: "Remove it. Every applicant is assessed on ability to pay, references and identity."
};

/**
 * Protected-group words by category. Each entry is a regex source matched with word boundaries and the "i" flag.
 * Order matters only for categorising a match that contains words from two categories (the first listed wins).
 */
const NATIONALITIES = [
  "asians?", "indians?", "chinese", "africans?", "south africans?", "sudanese", "somalis?", "vietnamese", "koreans?", "japanese",
  "filipinos?", "filipinas?", "thais?", "indonesians?", "malaysians?", "pakistanis?", "bangladeshis?", "sri lankans?", "nepalese",
  "lebanese", "arabs?", "arabic", "middle eastern(?:ers?)?", "iranians?", "iraqis?", "afghans?", "afghanis?", "turks?", "turkish",
  "europeans?", "english", "british", "brits?", "poms?", "irish", "scottish", "italians?", "greeks?", "germans?", "russians?",
  "americans?", "canadians?", "kiwis?", "new zealanders?", "maoris?", "pacific islanders?", "islanders?", "samoans?", "tongans?", "fijians?",
  "latinos?", "latinas?", "hispanics?", "brazilians?", "mexicans?",
  "aboriginals?", "aborigines?", "abos?", "indigenous", "torres strait islanders?", "first nations",
  "whites?", "blacks?", "caucasians?", "anglos?", "anglo[- ]saxons?", "ethnics?", "coloured", "colored",
  "foreigners?", "foreign", "overseas", "international", "immigrants?", "migrants?", "refugees?", "asylum seekers?",
  "non[- ]?australians?", "non[- ]?residents?", "australians?", "aussies?", "australian citizens?", "citizens?", "permanent residents?",
  "locals?", "english[- ]speaking", "non[- ]english[- ]speaking"
];

const GROUP_WORDS: Record<DiscriminationCategory, readonly string[]> = {
  familial_status: [
    "kids?", "kiddies", "children", "child", "babies", "baby", "toddlers?", "infants?", "teenagers?", "teens?", "families", "family",
    "pregnant(?: women| woman| ladies| couples?)?", "expecting couples?", "single (?:parents?|mums?|moms?|mothers?|dads?|fathers?)",
    "breastfeeding mothers?", "parents?"
  ],
  age: [
    "elderly", "seniors?", "older (?:people|persons?|tenants?|couples?|buyers?|applicants?|ones?)", "old (?:people|persons?)",
    "young (?:people|persons?|tenants?|couples?|buyers?|applicants?|professionals?|families|family|singles?|ones?)",
    "youngsters?", "youths?", "retirees?", "mature(?:[- ]aged)? (?:people|persons?|tenants?|couples?|buyers?|applicants?|ladies|lady|gentlem[ae]n|women|woman|men|man|students?|professionals?)",
    "over[- ]?(?:\\d{2})s?", "under[- ]?(?:\\d{2})s?", "(?:\\d{2})\\s?(?:\\+|plus|and over|and older)", "millennials?", "boomers?",
    "retired (?:people|persons?|couples?)"
  ],
  race: NATIONALITIES,
  religion: [
    "christians?", "catholics?", "protestants?", "anglicans?", "muslims?", "moslems?", "islamic", "jews?", "jewish", "hindus?", "buddhists?",
    "sikhs?", "atheists?", "religious (?:people|persons?|tenants?|families|family|buyers?)", "church[- ]?goers?", "god[- ]?fearing",
    "believers?", "non[- ]?believers?", "mormons?", "jehovah'?s? witness(?:es)?"
  ],
  sex: [
    "males?", "females?", "men", "man", "women", "woman", "guys?", "girls?", "boys?", "ladies", "lady", "gentlem[ae]n", "gents?",
    "blokes?", "fellas?", "chicks?"
  ],
  sexuality_gender: [
    "gays?", "lesbians?", "homosexuals?", "heterosexuals?", "straights?", "straight (?:people|couples?|tenants?)", "bisexuals?",
    "lgbt\\w*\\+?", "queers?", "trans(?:gender)?(?: people| persons?| tenants?| women| men)?", "transsexuals?", "non[- ]binary"
  ],
  relationship_status: [
    "married couples?", "married (?:people|persons?|tenants?)", "couples?(?!\\s+of\\b)", "singles", "single (?:people|persons?|person|tenants?|occupants?|men|man|women|woman|males?|females?|ladies|lady|guys?|girls?|professionals?)",
    "de ?facto(?: couples?)?", "unmarried(?: couples?)?", "divorcees?", "divorced (?:people|persons?|men|women)", "widows?", "widowers?"
  ],
  disability: [
    "disabled(?: people| persons?| tenants?| buyers?| applicants?)?", "people with (?:a )?disabilit(?:y|ies)", "persons? with (?:a )?disabilit(?:y|ies)",
    "handicapped(?: people| persons?)?", "wheelchairs?", "wheelchair users?", "wheelies", "cripples?", "invalids?", "mentally ill", "mental illness",
    "mental health (?:issues|problems|conditions)", "psych(?:iatric)? patients?", "blind (?:people|persons?)", "deaf (?:people|persons?)",
    "people on ndis", "ndis(?: participants?| tenants?| clients?)?", "sick people", "hiv(?: positive)?"
  ],
  income_source: [
    "dss", "centrelink", "welfare(?: recipients?)?", "pensioners?", "people on (?:the )?pension", "unemployed(?: people| persons?)?", "dole(?: bludgers?)?",
    "jobseekers?", "job seekers?", "housing commission(?: tenants?)?", "public housing tenants?", "people on benefits", "on benefits", "people on government assistance"
  ],
  occupation: [
    "professionals?", "working professionals?", "working (?:people|persons?|couples?|tenants?|singles?|families|family)", "students?",
    "international students?", "uni students?", "tradies", "tradesmen", "blue[- ]collar workers?", "white[- ]collar workers?", "executives?", "corporates?",
    "fifo workers?", "shift workers?", "backpackers?"
  ]
};

/** Order used to categorise a match (more specific categories first). */
const CATEGORY_ORDER: readonly DiscriminationCategory[] = [
  "disability", "income_source", "sexuality_gender", "religion", "age", "relationship_status", "familial_status", "occupation", "race", "sex"
];

/** Optional people words that can follow a protected adjective ("Christian family", "Asian buyers", "female flatmate"). */
const PERSON = "(?:\\s+(?:people|persons?|tenants?|buyers?|purchasers?|occupants?|applicants?|renters?|residents?|flatmates?|housemates?|roommates?|lodgers?|boarders?|investors?|owners?|couples?|families|family|household|man|men|woman|women|lady|ladies|guys?|girls?|boys?|students?|professionals?|only))?";

const alt = (xs: readonly string[]) => xs.join("|");
const ALL_GROUPS = CATEGORY_ORDER.flatMap(c => GROUP_WORDS[c]);
/** One protected group, optionally with a stacked adjective and a people word: "young professional couple", "Asian tenants". */
const GROUP = `(?:(?:a|an|the)\\s+)?(?:(?:${alt(ALL_GROUPS)})\\s+)?(?:${alt(ALL_GROUPS)})${PERSON}`;
const SEP = "[\\s,-]+";

/** Words after a group that make it about the property, not people: "no wheelchair access", "no family room". */
const PROPERTY_CONTEXT = "(?!\\s*['’]|\\s*(?:-?friendly\\b|access(?:ible)?\\b|ramps?\\b|rooms?\\b|homes?\\b|areas?\\b|zones?\\b|parks?\\b|playgrounds?\\b|bathrooms?\\b|toilets?\\b|grocer(?:y|ies)\\b|schools?\\b|restaurants?\\b|shops?\\b|cuisine\\b|church(?:es)?\\b|mosques?\\b|temples?\\b|synagogues?\\b|investment\\b|travel\\b|caves?\\b|garage\\b|beds?\\b|bedrooms?\\b|storey\\b|level\\b|lock[- ]?up\\b|carport\\b|car\\s?space\\b|minutes?\\b|of\\s+minutes\\b|approval\\b|rules\\b|buyers?\\s+(?:may|must|should|need|will)\\b))";

interface Rule {
  id: string;
  /** Regex source; compiled with "gi". */
  pattern: string;
  /** Severity by category; categories not listed use `defaultSeverity`. */
  defaultSeverity: FlagSeverity;
  severityFor?: Partial<Record<DiscriminationCategory, FlagSeverity>>;
  /** Fixed category (otherwise taken from the group words inside the match). */
  category?: DiscriminationCategory;
  message: (category: DiscriminationCategory) => string;
}

const states = (c: DiscriminationCategory) => `This states a preference about who can buy or rent based on ${CATEGORY_LABELS[c]}.`;
const excludes = (c: DiscriminationCategory) => `This excludes people based on ${CATEGORY_LABELS[c]}.`;

/** Soft suitability wording ("perfect for families") is advice only for these categories; for the rest it blocks. */
const SOFT_OK: Partial<Record<DiscriminationCategory, FlagSeverity>> = {
  familial_status: "warn", relationship_status: "warn", occupation: "warn", age: "warn"
};

const RULES: readonly Rule[] = [
  {
    id: "exclude.no_group",
    pattern: `\\b(?:no|nil|not\\s+(?:any|for))${SEP}(?:${GROUP})(?!\\w)${PROPERTY_CONTEXT}`,
    defaultSeverity: "block", message: excludes
  },
  {
    id: "exclude.group_not_allowed",
    pattern: `\\b(?:${GROUP})${SEP}(?:are\\s+|is\\s+|will\\s+)?(?:not|n't|aren['’]?t|isn['’]?t|won['’]?t\\s+be|will\\s+not\\s+be|cannot\\s+be|can['’]?t\\s+be)\\s*(?:be\\s+)?(?:allowed|permitted|welcome|welcomed|accepted|considered|suitable|tolerated|entertained)\\b`,
    defaultSeverity: "block", message: excludes
  },
  {
    id: "exclude.need_not_apply",
    pattern: `\\b(?:${GROUP})${SEP}(?:need|should|must|please)\\s+(?:not|don['’]?t)\\s+(?:apply|enquire|inquire|bother|call|contact)\\b`,
    defaultSeverity: "block", message: excludes
  },
  {
    id: "exclude.no_group_please",
    pattern: `\\b(?:sorry|strictly|absolutely)[\\s,]+no${SEP}(?:${GROUP})(?!\\w)${PROPERTY_CONTEXT}`,
    defaultSeverity: "block", message: excludes
  },
  {
    id: "exclude.without_children",
    pattern: "\\b(?:without|with\\s+no|free\\s+of|childless|kidless)\\s+(?:kids?|children|child|babies|pets\\s+or\\s+(?:kids|children))\\b",
    category: "familial_status", defaultSeverity: "block", message: excludes
  },
  {
    id: "exclude.child_free",
    pattern: "\\b(?:child|kid|children|baby|family)[\\s-]?free\\b|\\badults?[\\s-]+only\\b|\\badult[\\s-]+(?:household|building|complex|community|living)\\s+only\\b|\\bstrictly\\s+adults?\\b",
    category: "familial_status", defaultSeverity: "block", message: excludes
  },
  {
    id: "exclude.unsuitable_for",
    pattern: `\\b(?:not|un)[\\s-]?(?:suit(?:able|ed)|ideal|appropriate|fit|designed|recommended|available)\\s+(?:for|to)\\s+(?:${GROUP})(?!\\w)${PROPERTY_CONTEXT}`,
    defaultSeverity: "block", message: excludes
  },
  {
    id: "exclude.wont_rent_to",
    pattern: `\\b(?:will\\s+not|won['’]?t|do\\s+not|don['’]?t|cannot|can['’]?t|not\\s+willing\\s+to|refuse\\s+to|no\\s+longer)\\s+(?:rent|lease|sell|let)\\s+(?:it\\s+|this\\s+(?:property|home|house|unit)\\s+)?to\\s+(?:${GROUP})(?!\\w)${PROPERTY_CONTEXT}`,
    defaultSeverity: "block", message: excludes
  },
  {
    id: "prefer.group_only",
    pattern: `\\b(?:${GROUP})${SEP}(?:only|exclusively|strictly)\\b(?!\\s+(?:minutes?|a\\s+short|steps|metres|meters|walking))`,
    defaultSeverity: "block", message: states
  },
  {
    id: "prefer.only_group",
    pattern: `\\b(?:only|exclusively|strictly)\\s+(?:for\\s+|to\\s+|rent(?:ing)?\\s+to\\s+|sell(?:ing)?\\s+to\\s+|accept(?:ing)?\\s+|consider(?:ing)?\\s+|suits?\\s+|suitable\\s+for\\s+)?(?:${GROUP})(?!\\w)${PROPERTY_CONTEXT}(?!\\s+(?:minutes?|away|kms?|metres|walk))`,
    defaultSeverity: "block", message: states
  },
  {
    id: "prefer.group_preferred",
    pattern: `\\b(?:${GROUP})${SEP}(?:are\\s+|is\\s+)?(?:preferred|preferable|wanted|desired|favoured|favored|sought|required|needed|a\\s+must)\\b`,
    defaultSeverity: "block", message: states
  },
  {
    id: "prefer.prefer_group",
    pattern: `\\b(?:prefer(?:ence)?|preferably|preferring|prefers|would\\s+like|looking\\s+for|seeking|searching\\s+for|want(?:ed|ing)?|requires?|must\\s+be|should\\s+be|has\\s+to\\s+be|need\\s+to\\s+be)\\s+(?:for\\s+|to\\s+(?:rent|sell|lease)\\s+to\\s+)?(?:${GROUP})(?!\\w)${PROPERTY_CONTEXT}`,
    defaultSeverity: "block", message: states
  },
  {
    id: "prefer.suits_group",
    pattern: `\\b(?:suits?|suited\\s+to|suitable\\s+for|ideal\\s+for|perfect\\s+for|great\\s+for|best\\s+for|designed\\s+for|tailored\\s+for|made\\s+for)\\s+(?:${GROUP})(?!\\w)${PROPERTY_CONTEXT}`,
    defaultSeverity: "block", severityFor: SOFT_OK, message: states
  },
  {
    id: "steer.group_area",
    pattern: `\\b(?:${alt([...NATIONALITIES.filter(n => !/foreign|overseas|international|locals?|citizens?|residents?|australian|aussie|english|white|black|colou?red/.test(n)), ...GROUP_WORDS.religion])})\\s+(?:area|neighbourhood|neighborhood|suburb|street|community|enclave|household|family|families|building|complex)\\b(?!\\s+(?:centre|center|hall|school|church))`,
    defaultSeverity: "block", message: c => `This describes the people in the home or area by ${CATEGORY_LABELS[c]}, which can steer buyers or renters.`
  },
  {
    id: "require.language",
    pattern: "\\b(?:must|should|need\\s+to|required\\s+to|has\\s+to|have\\s+to)\\s+(?:be\\s+able\\s+to\\s+)?speak\\s+(?:fluent\\s+|good\\s+)?english\\b|\\b(?:fluent|good)\\s+english\\s+(?:required|essential|a\\s+must)\\b|\\benglish[\\s-]speaking\\s+(?:only|required|essential|preferred)\\b",
    category: "race", defaultSeverity: "block", message: excludes
  },
  {
    id: "require.citizenship",
    pattern: "\\b(?:must|should|need\\s+to|has\\s+to|have\\s+to)\\s+(?:be|hold|have)\\s+(?:an?\\s+)?(?:australian\\s+citizen(?:ship)?s?|citizens?|permanent\\s+residen(?:ts?|cy)|australian\\s+passport|aussie)\\b|\\b(?:australian\\s+)?(?:citizens?|permanent\\s+residents?)\\s+(?:and\\s+permanent\\s+residents?\\s+)?only\\b",
    category: "race", defaultSeverity: "block", message: excludes
  },
  {
    id: "require.able_bodied",
    pattern: "\\b(?:able[\\s-]bodied|physically\\s+fit|must\\s+be\\s+(?:fit|healthy|mobile)|no\\s+(?:mobility|medical)\\s+(?:issues|problems|aids)|(?:no|without)\\s+(?:a\\s+)?(?:disability|disabilities|illness|mental\\s+health\\s+issues))\\b",
    category: "disability", defaultSeverity: "block", message: excludes
  },
  {
    id: "require.no_pregnancy",
    pattern: "\\b(?:not\\s+(?:be\\s+)?pregnant|no\\s+pregnan(?:t|cy|cies)|(?:no|not\\s+planning)\\s+(?:plans\\s+)?(?:for|to\\s+have)\\s+(?:kids|children|a\\s+baby|babies|a\\s+family))\\b",
    category: "familial_status", defaultSeverity: "block", message: excludes
  },
  {
    id: "require.employment",
    pattern: "\\b(?:must\\s+(?:be|have)\\s+(?:in\\s+)?(?:full[\\s-]time\\s+|permanent\\s+)?(?:employed|employment|a\\s+(?:full[\\s-]time\\s+)?job|working))\\b",
    category: "income_source", defaultSeverity: "warn",
    message: () => "Requiring a job can exclude people on pensions or benefits. Assess ability to pay instead."
  },
  {
    id: "require.political",
    pattern: "\\b(?:no|not)\\s+(?:greens|labor|liberal|lnp|one\\s+nation|union(?:ist)?s?|union\\s+members?|activists?|protesters?)\\s+(?:voters?|supporters?|members?|people|tenants?|buyers?)?\\b",
    category: "occupation", defaultSeverity: "block",
    message: () => "This excludes people based on political belief, activity or trade union membership."
  },
  {
    id: "soft.not_child_friendly",
    pattern: "\\bnot\\s+(?:child|kid|family)[\\s-]friendly\\b",
    category: "familial_status", defaultSeverity: "warn",
    message: () => "This can read as excluding families. Describe the feature instead, for example \"steep stairs and an unfenced pool\"."
  },
  {
    id: "soft.quiet_mature",
    pattern: "\\b(?:quiet\\s+)?(?:mature|older|young)\\s+(?:tenants?|person|people|couples?|lady|gentleman|professionals?|singles?)\\b(?!\\s+(?:only|preferred|wanted|required|exclusively))",
    category: "age", defaultSeverity: "warn",
    message: () => "Describing the ideal occupant by age can be read as a preference. Describe the property instead."
  }
];

const COMPILED = RULES.map(r => ({ rule: r, re: new RegExp(r.pattern, "gi") }));
const CATEGORY_RES: readonly [DiscriminationCategory, RegExp][] = CATEGORY_ORDER.map(c => [c, new RegExp(`\\b(?:${alt(GROUP_WORDS[c])})(?!\\w)`, "gi")]);
const ANY_GROUP = new RegExp(`\\b(?:${alt(ALL_GROUPS)})(?!\\w)`, "i");

/**
 * The category of the protected words inside a match: the leftmost protected phrase wins, then the longest ("Indian families" is
 * race, "international students" is occupation), then CATEGORY_ORDER. Undefined if none (then the match is not a flag).
 */
export function categoryOf(text: string): DiscriminationCategory | undefined {
  let best: { c: DiscriminationCategory; index: number; length: number } | undefined;
  for (const [c, re] of CATEGORY_RES) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m !== null; m = re.exec(text)) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (!best || m.index < best.index || (m.index === best.index && m[0].length > best.length)) best = { c, index: m.index, length: m[0].length };
    }
  }
  return best?.c;
}

/** Curly quotes and dashes become plain ones (same length, so offsets still point at the original text). */
function normalise(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/[–—]/g, "-").replace(/ /g, " ");
}

const MAX_SCAN_LENGTH = 20_000;

/**
 * Scans text for discriminatory wording. Overlapping matches keep the longest (then the most severe). Results are in text order.
 * Text longer than 20,000 characters is scanned up to that point only (inputs are capped well below that).
 */
export function scanForDiscrimination(text: string): ScanResult {
  const t = normalise(text.slice(0, MAX_SCAN_LENGTH));
  const found: WordingFlag[] = [];
  // Most clean text has no protected word at all; the group rules are skipped then (rules with a fixed category always run).
  const hasGroup = ANY_GROUP.test(t);
  for (const { rule, re } of COMPILED) {
    if (!hasGroup && !rule.category) continue;
    re.lastIndex = 0;
    for (let m = re.exec(t); m !== null; m = re.exec(t)) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      const category = rule.category ?? categoryOf(m[0]);
      if (!category) continue;
      const severity = rule.severityFor?.[category] ?? rule.defaultSeverity;
      const start = m.index, end = m.index + m[0].length;
      found.push({
        ruleId: rule.id, category, severity, match: text.slice(start, end), start, end,
        message: rule.message(category), suggestion: SUGGESTIONS[category]
      });
    }
  }
  const rank = (f: WordingFlag) => (f.severity === "block" ? 1 : 0);
  found.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start) || rank(b) - rank(a));
  const flags: WordingFlag[] = [];
  for (const f of found) {
    const prev = flags[flags.length - 1];
    if (prev && f.start < prev.end) {
      // Overlap: keep the wider span; if one is a block and the other a warning, the block wins.
      if (rank(f) > rank(prev) || (rank(f) === rank(prev) && f.end - f.start > prev.end - prev.start)) flags[flags.length - 1] = { ...f, start: Math.min(f.start, prev.start), end: Math.max(f.end, prev.end), match: text.slice(Math.min(f.start, prev.start), Math.max(f.end, prev.end)) };
      continue;
    }
    flags.push(f);
  }
  return { flags, blocked: flags.some(f => f.severity === "block") };
}

/** A match key that survives unrelated edits elsewhere in the text: field + lower-cased match with spaces collapsed. */
export function flagKey(field: string, match: string): string {
  return `${field}:${match.toLowerCase().replace(/\s+/g, " ").trim()}`;
}

export interface FieldFlags { field: string; flags: WordingFlag[] }

/** Scans several named fields (for example title and description). */
export function scanFields(fields: Readonly<Record<string, string | undefined>>): FieldFlags[] {
  return Object.entries(fields)
    .filter((e): e is [string, string] => typeof e[1] === "string" && e[1].length > 0)
    .map(([field, value]) => ({ field, flags: scanForDiscrimination(value).flags }))
    .filter(f => f.flags.length > 0);
}

/**
 * Publish-gate reasons for blocking flags that staff have not cleared. `cleared` holds flagKey values staff approved for this listing.
 */
export function wordingBlockReasons(fields: readonly FieldFlags[], cleared: ReadonlySet<string> = new Set()): string[] {
  const reasons: string[] = [];
  for (const { field, flags } of fields) {
    for (const f of flags) {
      if (f.severity !== "block" || cleared.has(flagKey(field, f.match))) continue;
      reasons.push(`Wording in the ${field} may be discriminatory: "${f.match}". ${f.message} ${f.suggestion}`);
    }
  }
  return reasons;
}

/** For owner messages and templates: a single error message when the text has a blocking flag, else undefined. */
export function messageWordingError(text: string): string | undefined {
  const blocking = scanForDiscrimination(text).flags.filter(f => f.severity === "block");
  if (blocking.length === 0) return undefined;
  const f = blocking[0]!;
  return `This message can't be sent because "${f.match}" may be discriminatory. ${f.message} ${f.suggestion}`;
}
