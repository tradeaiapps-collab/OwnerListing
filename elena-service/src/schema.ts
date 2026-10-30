import { MAX_QUESTION_LENGTH, type ChatFacts, type ChatOffer, type ChatRole } from "./engine.ts";

export class BadRequest extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown, where: string): Obj => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new BadRequest(`${where} must be an object.`);
  return v as Obj;
};
/** Strict on purpose: an unknown field (say `floor_cents` or `owner_phone`) is rejected, so private data cannot reach Elena by accident. */
const only = (o: Obj, allowed: readonly string[], where: string) => {
  const extra = Object.keys(o).filter(k => !allowed.includes(k));
  if (extra.length) throw new BadRequest(`${where} has fields Elena does not accept: ${extra.join(", ")}.`);
};
const str = (o: Obj, k: string, where: string, max = 300): string => {
  const v = o[k];
  if (typeof v !== "string" || !v.trim() || v.length > max) throw new BadRequest(`${where}.${k} must be a non-empty string up to ${max} characters.`);
  return v;
};
const int = (o: Obj, k: string, where: string, required: boolean): number | undefined => {
  const v = o[k];
  if (v === undefined || v === null) { if (required) throw new BadRequest(`${where}.${k} is required.`); return undefined; }
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 1e12) throw new BadRequest(`${where}.${k} must be a whole number of 0 or more.`);
  return v;
};
const strList = (v: unknown, where: string): string[] => {
  if (!Array.isArray(v) || v.length > 20 || v.some(x => typeof x !== "string" || x.length > 200)) throw new BadRequest(`${where} must be a list of up to 20 short strings.`);
  return v as string[];
};

const ROLES: Record<string, ChatRole> = { buyer: "buyer", owner: "owner", seller: "owner", agent: "agent" };

function terms(o: Obj, where: string) {
  return {
    priceCents: int(o, "price_cents", where, true)!, depositCents: int(o, "deposit_cents", where, true)!,
    settlementDays: int(o, "settlement_days", where, true)!, conditions: strList(o["conditions"] ?? [], `${where}.conditions`)
  };
}

export interface ChatRequest {
  question: string | undefined; role: ChatRole; facts: ChatFacts;
  history: { role: "user" | "elena"; text: string }[]; personaName: string;
}

export function parseChatRequest(body: unknown): ChatRequest {
  const b = obj(body, "body");
  only(b, ["question", "user_role", "listing_context", "offer_context", "conversation_history", "persona_name"], "body");
  const role = ROLES[String(b["user_role"])];
  if (!role) throw new BadRequest("user_role must be buyer, seller, owner or agent.");
  let question: string | undefined;
  if (b["question"] !== undefined) {
    question = str(b, "question", "body", MAX_QUESTION_LENGTH).trim();
  }

  const l = obj(b["listing_context"], "listing_context");
  only(l, ["title", "address", "suburb", "transaction_type", "property_type", "asking_cents", "bedrooms", "bathrooms", "parking", "verified_disclosures"], "listing_context");
  const tx = l["transaction_type"];
  if (tx !== "sale" && tx !== "rent") throw new BadRequest("listing_context.transaction_type must be sale or rent.");
  const facts: ChatFacts = {
    listing: {
      title: str(l, "title", "listing_context"), address: str(l, "address", "listing_context"),
      suburb: l["suburb"] === undefined ? undefined : str(l, "suburb", "listing_context"),
      transactionType: tx, propertyType: str(l, "property_type", "listing_context", 60),
      askingCents: int(l, "asking_cents", "listing_context", false), bedrooms: int(l, "bedrooms", "listing_context", false),
      bathrooms: int(l, "bathrooms", "listing_context", false), parking: int(l, "parking", "listing_context", false),
      verifiedDisclosures: int(l, "verified_disclosures", "listing_context", false) ?? 0
    }
  };

  if (b["offer_context"] !== undefined && b["offer_context"] !== null) {
    const o = obj(b["offer_context"], "offer_context");
    only(o, ["price_cents", "deposit_cents", "settlement_days", "conditions", "status", "counter"], "offer_context");
    const offer: ChatOffer = { ...terms(o, "offer_context"), status: str(o, "status", "offer_context", 40) };
    if (o["counter"] !== undefined && o["counter"] !== null) {
      const c = obj(o["counter"], "offer_context.counter");
      only(c, ["from_party", "price_cents", "deposit_cents", "settlement_days", "conditions", "status"], "offer_context.counter");
      if (c["from_party"] !== "owner" && c["from_party"] !== "buyer") throw new BadRequest("offer_context.counter.from_party must be owner or buyer.");
      offer.counter = { ...terms(c, "offer_context.counter"), fromParty: c["from_party"], status: str(c, "status", "offer_context.counter", 40) };
    }
    facts.offer = offer;
  }

  const hist = b["conversation_history"] ?? [];
  if (!Array.isArray(hist) || hist.length > 20) throw new BadRequest("conversation_history must be a list of up to 20 turns.");
  const history = hist.map((h, i) => {
    const t = obj(h, `conversation_history[${i}]`);
    only(t, ["role", "text"], `conversation_history[${i}]`);
    if (t["role"] !== "user" && t["role"] !== "elena") throw new BadRequest(`conversation_history[${i}].role must be user or elena.`);
    return { role: t["role"] as "user" | "elena", text: str(t, "text", `conversation_history[${i}]`, 2000) };
  });
  const personaName = b["persona_name"] === undefined ? "Elena" : str(b, "persona_name", "body", 40);
  return { question, role, facts, history, personaName };
}
