/**
 * The assistant's character: the face and name the guide assistant shows on the public site (chat launcher and header, home page
 * greeter). Staff choose one of five fixed personas at /staff/assistant; Elena is the default. Names, images and wording are fixed
 * here (staff only pick an id), and she is always labelled as an AI assistant so a buyer never mistakes her for a licensed agent.
 */
export const PERSONA_IDS = ["elena", "maya", "amara", "sofia", "noor"] as const;
export type PersonaId = (typeof PERSONA_IDS)[number];
export const DEFAULT_PERSONA_ID: PersonaId = "elena";
export const isPersonaId = (v: unknown): v is PersonaId => typeof v === "string" && (PERSONA_IDS as readonly string[]).includes(v);

export interface Persona {
  id: PersonaId;
  name: string;
  kind: string;
  /** One line for staff, shown under the tile in the picker. */
  blurb: string;
  /** Square photo (512 px), for the picker and the home page greeter. */
  portrait: string;
  /** Round icon with transparent corners (96 px), for the chat launcher and header. */
  icon: string;
  /** Full-length waving photo, when there is one; the home greeter uses the portrait otherwise. */
  greeter: string | null;
}

const img = (id: PersonaId) => ({ portrait: `/assistant/${id}-portrait.jpg`, icon: `/assistant/${id}-icon.png` });

export const PERSONAS: readonly Persona[] = [
  { id: "elena", name: "Elena", kind: "The Advisor", blurb: "Composed and polished. Navy blazer. Feels trustworthy on offers, pricing and paperwork.", ...img("elena"), greeter: "/assistant/elena-greeter.jpg" },
  { id: "maya", name: "Maya", kind: "The Neighbour", blurb: "Warm and relaxed in a cream knit. Suits first-time buyers and owners listing on their own.", ...img("maya"), greeter: null },
  { id: "amara", name: "Amara", kind: "The Concierge", blurb: "Modern and confident. A match for new developments and investor projects.", ...img("amara"), greeter: null },
  { id: "sofia", name: "Sofia", kind: "The Host", blurb: "Elegant luxury-hotel host. The most premium of the five.", ...img("sofia"), greeter: null },
  { id: "noor", name: "Noor", kind: "The Analyst", blurb: "Sharp and tech-forward, with a gold ring that marks her as the AI.", ...img("noor"), greeter: null }
];

export const personaById = (id: unknown): Persona => PERSONAS.find(p => p.id === id) ?? PERSONAS.find(p => p.id === DEFAULT_PERSONA_ID)!;

/** Shown wherever her name appears. Fixed so it cannot be edited away. */
export const personaLabel = (p: Pick<Persona, "name">) => `${p.name} · AI assistant`;

/** The home page greeter's line. */
export const personaIntro = (p: Pick<Persona, "name">, siteName: string) =>
  `Hi, I'm ${p.name}, ${siteName}'s AI assistant. I can show you how to list your home, how offers work, or what to do next. I'm automated, not a licensed agent.`;
